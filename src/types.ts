import type { AgentSpec } from './agents.js';
import type { LoggerSpec } from './loggers.js';
import type { PromptGeneratorSpec } from './prompt-generators.js';
import type { ReporterSpec } from './reporters.js';

/**
 * A JSON Schema object describing the expected shape of structured output.
 */
export type OutputSchema = Record<string, unknown>;

/**
 * Cost and token usage metadata for an agent invocation. `costSource:
 * 'unavailable'` means usage may be known but no USD figure was produced.
 */
export interface CostInfo {
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly model?: string;
  readonly costSource: 'provider' | 'estimated' | 'unavailable';
}

/**
 * We ran a prompt through an Agent and it worked out okay
 */
export interface SuccessfulInvocationResult {
  readonly status: 'success';
  readonly output: string;
  readonly cost?: CostInfo;
  /**
   * When an `outputSchema` was provided, the SDK returns the parsed object
   * that conforms to the schema. Present only when structured output was
   * requested and the agent supports it.
   */
  readonly structuredOutput?: unknown;
}

/**
 * We ran a prompt through an Agent and there was a transient problem which
 * indicates a problem with the agent rather than the prompt (for example
 * an 'out of tokens' error or a 'network down' error.).
 * Given a glitch the caller should probably stop and work out a configuration
 * which will work or wait until a transient problem is resolved
 */
export interface GlitchedInvocationResult {
  readonly status: 'glitch';
  readonly reason: string;
  readonly cost?: CostInfo;
}

/**
 * We ran a prompt through and an Agent and it broke in a way that indicates
 * a problem with the prompt rather than the agent. This prompt should probably
 * not be tried again.
 */
export interface ErrorInvocationResult {
  readonly status: 'error';
  readonly reason: string;
  readonly cost?: CostInfo;
}

/**
 * The outcome of invoking the agent on a single file
 */
export type InvokeResult =
  | SuccessfulInvocationResult
  | GlitchedInvocationResult
  | ErrorInvocationResult;

/**
 * The structured outcome of a full loop run. Callers branch on the
 * `status` field and the optional `reason`, never on a parsed message
 * string. The reason set is open to extension by later steps (for
 * example Step 06 adds a pipeline-level `maxPasses` stop).
 */
export interface LoopRunResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly reason?:
    | 'maxPrompts'
    | 'maxBudgetUsd'
    | 'errorResult'
    | 'tooManyGlitches'
    | 'maxPasses';
  readonly message?: string;
}

/**
 * Type definition for the main start point for the loop
 */
export interface LoopCliConfig {
  /**
   * The task name is used in reports and as part of a filename when managing
   * state.
   */
  readonly name: string;

  /**
   * Directory into which we can write a report and a state tracking file
   */
  readonly outputDir?: string;

  /**
   * The agent to which we send prompts
   */
  readonly agent: AgentSpec;

  /**
   * The source of prompts to sent to the selected agent
   */
  readonly promptGenerator: PromptGeneratorSpec;

  /**
   * How we report on the responses from the agent to the various prompts
   */
  readonly reporter?: ReporterSpec;

  /**
   * Maximum number of prompts to process. Unlimited when null/undefined.
   */
  readonly maxPrompts?: number;

  /**
   * Lifetime USD budget across resumes. When set, the loop stops after the
   * prompt whose completion takes the persisted total at or above this cap,
   * and stops immediately at startup if the persisted total is already at or
   * above it. Track-only when omitted.
   */
  readonly maxBudgetUsd?: number;

  /**
   * Number of prompts to run concurrently in one process. Defaults to 1
   * (serial, byte-for-byte the previous behaviour). Values greater than 1 are
   * rejected together with `allowSourceUpdate` (git commits cannot safely
   * interleave) or the batch prompt generator (summary prompts would race
   * with in-flight batch items).
   */
  readonly concurrency?: number;

  /**
   * Pause between each prompt. Can help with rate limiting.
   */
  readonly interPromptPause?: number;

  /**
   * When true, the loop checks that the working directory is clean before
   * starting, allows agents to make source changes, and commits after each
   * successful prompt. When false (the default), git state is ignored and
   * no commits are made.
   */
  readonly allowSourceUpdate?: boolean;

  /**
   * Controls verbose diagnostic logging to stderr. Accepts a concrete
   * `VerboseLogger` instance, the string `'verbose'` (which creates an
   * enabled logger), or `undefined` (quiet, the default).
   */
  readonly logger?: LoggerSpec;
}

/**
 * One step of a pipeline. A step is one `loop()` over one prompt generator.
 * `promptGenerator` is required; every other field overrides the pipeline-level
 * default for this step only. `dependsOn` is an optional, cycle-tolerant
 * ordering hint within a pass and never a correctness constraint.
 */
export interface PipelineStep {
  readonly promptGenerator: PromptGeneratorSpec;
  readonly agent?: AgentSpec;
  readonly reporter?: ReporterSpec;
  readonly outputDir?: string;
  readonly allowSourceUpdate?: boolean;
  readonly maxPrompts?: number;

  /**
   * Stricter local USD budget for this step alone, passed into the step's
   * `loop()`. Independent of the pipeline-wide shared cap (a top-level
   * `maxBudgetUsd`), which is enforced across all steps by the orchestrator.
   */
  readonly maxBudgetUsd?: number;

  /**
   * Within-step prompt concurrency for this step's own `loop()` (the Step 04
   * lever). Independent of the pipeline-level `maxStepConcurrency`, which limits
   * how many steps overlap. No top-level fallback. `loop()` rejects values > 1
   * together with `allowSourceUpdate` or a batch generator; the pipeline rejects
   * those combinations at load time.
   */
  readonly concurrency?: number;
  readonly interPromptPause?: number;
  readonly logger?: LoggerSpec;
  readonly dependsOn?: ReadonlyArray<string>;
}

/**
 * A pipeline: a set of named steps plus a designated terminal `output` step.
 * Not a DAG; cycles between steps are a supported feature (rework loops). Runs
 * to a fixed point, bounded by `maxPasses`.
 */
export interface PipelineTask {
  /**
   * Key of the terminal step. Identifies the final artifact for reporting; it
   * does not impose execution order. Must name an existing step.
   */
  readonly output: string;

  /**
   * The steps, keyed by step key. Non-empty. The loop name of each step is the
   * derived `${pipelineName}-${stepKey}`.
   */
  readonly steps: Readonly<Record<string, PipelineStep>>;

  /**
   * Safety ceiling on the number of fixed-point passes. Defaults to 100.
   */
  readonly maxPasses?: number;

  /**
   * Maximum number of independent steps to run concurrently within a pass.
   * Defaults to 1 (steps run sequentially in dependency-hint order, exactly as
   * before). A step with `allowSourceUpdate` always runs as an exclusive
   * barrier regardless of this limit.
   */
  readonly maxStepConcurrency?: number;
}

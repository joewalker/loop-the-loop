import type { LoopState } from '../loop-state.js';
import { BugzillaPromptGenerator } from './bugzilla.js';
import { PerFilePromptGenerator } from './per-file.js';

/**
 * A prompt is basically just a string that we pass to an agent to kick off
 * some work. In addition to the prompt string, we also track an id for
 * debugging purposes and a function to inform the PromptGenerator what
 * happened when we executed the prompt.
 */
export interface Prompt {
  /**
   * Unique identifier which could be useful in debugging to quickly identify
   * a prompt that is causing problems. Likely to be a bug-id, filename, index
   * into an array, etc.
   * Typically we won't be able to use the prompt as an identifier due to its
   * length and the likelihood that the unique part will be embedded deep in
   * the prompt
   */
  readonly id: string;

  /**
   * The initial text to send to the agent
   */
  readonly prompt: string;
}

/**
 * A PromptGenerator is (obviously) a source of Prompts
 */
export interface PromptGenerator {
  /**
   * Return the prompt stream for this generator instance.
   */
  generate(loopState: LoopState): AsyncIterable<Prompt>;
}

type PromptGeneratorCtor<T extends PromptGenerator = PromptGenerator> = new (
  ...args: Array<any>
) => T;

/**
 * To add a new built-in PromptGenerator, add it in here
 */
const creatorFunctions = {
  ['bugzilla']: BugzillaPromptGenerator,
  ['per-file']: PerFilePromptGenerator,
} satisfies Record<string, PromptGeneratorCtor>;

type PromptGeneratorConstructors = typeof creatorFunctions;
type PromptGeneratorType = keyof PromptGeneratorConstructors;

/**
 * The type when someone specifies a PromptGenerator in a call to agenticLoop
 */
export type PromptGeneratorSpec = {
  [T in PromptGeneratorType]: [
    T,
    ...ConstructorParameters<PromptGeneratorConstructors[T]>,
  ];
}[PromptGeneratorType];

/**
 * Enable the command line to know what prompt generators are available
 */
export const promptGeneratorTypes = Object.keys(creatorFunctions);

/**
 * Allow easy switching between different PromptGenerator types
 */
export function createPromptGenerator(
  ...spec: PromptGeneratorSpec
): PromptGenerator;
export function createPromptGenerator<T extends PromptGeneratorType>(
  type: T,
  ...args: ConstructorParameters<PromptGeneratorConstructors[T]>
): PromptGenerator;
export function createPromptGenerator(
  type: PromptGeneratorType,
  ...args: Array<unknown>
): PromptGenerator {
  const PromptGeneratorClass = creatorFunctions[type] as new (
    ...ctorArgs: Array<unknown>
  ) => PromptGenerator;
  return new PromptGeneratorClass(...args);
}

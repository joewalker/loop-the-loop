import { resolve } from 'node:path';

const REPORT_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.report\}\}/gu;
const STATE_HANDOFF = /\{\{steps\.([A-Za-z0-9_-]+)\.state\}\}/gu;

/**
 * Resolve `{{steps.<name>.report}}` and `{{steps.<name>.state}}` handoff
 * markers in a config path to the named step's actual local artifacts under
 * `outputDir`: `<name>-report.jsonl` for the report and
 * `<name>-loop-state.json` for the state. A path with no marker is returned
 * unchanged. This removes hard-coded filenames so renaming a step updates its
 * consumers instead of silently breaking the wiring.
 *
 * `mapName` maps the marker's step key to the actual artifact basename; it
 * defaults to identity (standalone loop, where the loop name equals the
 * basename). Inside a pipeline the caller passes
 * `(key) => `${pipelineName}-${key}`` so a marker written with the bare step
 * key resolves to the pipeline-prefixed filename.
 */
export function resolveStepHandoff(
  value: string,
  outputDir: string,
  mapName: (name: string) => string = name => name,
): string {
  return value
    .replace(REPORT_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${mapName(name)}-report.jsonl`),
    )
    .replace(STATE_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${mapName(name)}-loop-state.json`),
    );
}

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
 */
export function resolveStepHandoff(value: string, outputDir: string): string {
  return value
    .replace(REPORT_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${name}-report.jsonl`),
    )
    .replace(STATE_HANDOFF, (_match, name: string) =>
      resolve(outputDir, `${name}-loop-state.json`),
    );
}

# Step 02: `--doctor`

## Goal

Give users a preflight command that validates the configured agent, prompt generator, reporter, output directory, git requirements, and state file before the loop spends time or tokens.

## Work

- Add an optional `check()` capability to agents, prompt generators, and reporters.
- Add `doctor(config)` to instantiate configured components and stream structured check results to stdout.
- Add the `--doctor` CLI flag.
- Run cross-cutting checks for output directory write access, state file readability, and source-update git prerequisites.
- Keep checks sequential so output remains deterministic and readable.

## Dependencies

- Step 01, so state checks validate the strict state contract and can report malformed state files clearly.

## Done when

- `--doctor` exits 0 when all checks pass and 1 when any check fails.
- Missing optional checks are reported as `skip`, not as success.
- Real external probes are cheap and read-only where possible.
- Component construction failures are reported without preventing unrelated checks from running.

## Related plans

- [`--doctor` CLI option](doctor-flag.md)

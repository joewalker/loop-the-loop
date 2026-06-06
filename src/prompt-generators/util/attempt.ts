/**
 * Attempt knobs that gate and re-mint an id for bounded rework loops. A
 * reader (currently `jsonl`) parses the `#N` attempt suffix off an incoming
 * id, decides whether to emit it, and optionally re-emits it at the next
 * attempt. Attempt 1 is the bare id with no suffix; rework mints `id#2`,
 * `id#3`, and so on. See `docs/future-plans/conditional-routing-design.md`.
 */
export interface AttemptKnobs {
  /**
   * Emit only while the incoming attempt is strictly below this value.
   */
  readonly maxAttempts?: number;

  /**
   * Emit only once the incoming attempt is at or above this value.
   */
  readonly minAttempts?: number;

  /**
   * When true, emit the id at the next attempt (`#(N+1)`) rather than
   * verbatim. This is how a loop-back reader re-enters work.
   */
  readonly incrementAttempt?: boolean;
}

/**
 * Split an id into its base and attempt number. Only a numeric suffix of 2 or
 * more after the last `#` counts as an attempt marker, so a bare id is attempt
 * 1 and ids that legitimately contain `#` (or `#1`/`#0`) round-trip unchanged.
 */
export function parseAttempt(id: string): {
  readonly base: string;
  readonly attempt: number;
} {
  const hash = id.lastIndexOf('#');
  if (hash > 0) {
    const suffix = id.slice(hash + 1);
    if (/^\d+$/u.test(suffix)) {
      const attempt = Number(suffix);
      if (attempt >= 2) {
        return { base: id.slice(0, hash), attempt };
      }
    }
  }
  return { base: id, attempt: 1 };
}

/**
 * Render a base id at a given attempt. Attempt 1 is the bare base; higher
 * attempts append `#N`. Inverse of {@link parseAttempt}.
 */
export function formatAttempt(base: string, attempt: number): string {
  return attempt >= 2 ? `${base}#${attempt}` : base;
}

/**
 * Apply the attempt knobs to an incoming id. Returns the id to emit (possibly
 * incremented) or `null` when the gates suppress it.
 */
export function resolveAttemptId(
  id: string,
  knobs: AttemptKnobs,
): string | null {
  const { base, attempt } = parseAttempt(id);
  if (knobs.maxAttempts !== undefined && attempt >= knobs.maxAttempts) {
    return null;
  }
  if (knobs.minAttempts !== undefined && attempt < knobs.minAttempts) {
    return null;
  }
  const nextAttempt = knobs.incrementAttempt === true ? attempt + 1 : attempt;
  return formatAttempt(base, nextAttempt);
}

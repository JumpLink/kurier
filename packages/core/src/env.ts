/**
 * The one reader for a knob a person may set — `LOTSE_*`, with `KURIER_*` still honoured.
 *
 * The app was called kurier through 0.1.1, so a machine set up then has `KURIER_DATA_DIR` or
 * `KURIER_CWD` in a shell rc, a systemd unit or a launcher that nobody is going to revisit. Both
 * names are read and the new one wins; a value that is only whitespace counts as unset, which is
 * the rule each call site applied to the single name before.
 *
 * One reader rather than a fallback written out per knob, because the failure mode is a new knob
 * that reads only one name and a person whose old setting is silently ignored.
 */

/** The value of `LOTSE_<suffix>`, else the legacy `KURIER_<suffix>`, else `undefined`. */
export function envKnob(env: Record<string, string | undefined>, suffix: string): string | undefined {
  const current = env[`LOTSE_${suffix}`]?.trim();
  if (current) return current;
  return env[`KURIER_${suffix}`]?.trim() || undefined;
}

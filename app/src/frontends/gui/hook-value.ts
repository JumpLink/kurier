/**
 * How a `LOTSE_APP_*` value is read — the three rules, in one place, with no `gi://` in sight.
 *
 * **Why this is its own file and not three closures inside `readHooks`.** `readHooks` also calls the
 * framework's `readAppDevHooks`, whose barrel imports `Adw`, so a test that imports it drags
 * `gi://Adw` into the Node run and cannot be run on both runtimes at all. The *rules* are the part
 * that has to be true — `'0'` and `'false'` and an empty value all mean off, and a comma list is
 * split and trimmed — and they are the part that a future key would get wrong, because the mistake
 * looks exactly like the previous key working. Split out, they run on GJS and on Node like every
 * other rule in this app.
 *
 * **One rule for "is this on", shared with the stand-in agent.** `scripts/stand-in-agent.mjs` has the
 * same `flag()` and cannot import this file — it is a standalone program and this is a bundle. It is
 * copied rather than shared, and the two are kept in step by both files saying so.
 */

/** The `LOTSE_APP_` prefix, from `constants.ts` — the same one `readHooks` spreads the framework hooks with. */
const PREFIX = 'LOTSE_APP_';

/**
 * The value of one hook, trimmed, or `undefined` when it is unset or empty.
 *
 * **Empty is unset, and that is a rule rather than a default.** An env var set to `''` is what a shell
 * gives a variable that was exported with nothing after the `=`, and treating it as set would make
 * `LOTSE_APP_PROMPT=` send an empty prompt — which `AgentSession.prompt()` then refuses, so the run would
 * look like the hook was ignored instead of like the value was empty.
 */
export function hookValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[`${PREFIX}${key}`]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Whether a hook is on: set, and not one of the two spellings of off.
 *
 * **`'0'` and `'false'` are off, and both had to be made so.** A truthiness test on the raw string
 * accepts `'0'` — a non-empty string is truthy in JavaScript — so the first version of this reader
 * sent a prompt for `LOTSE_APP_THINKING=0` and staged a dialog for `LOTSE_APP_PERMISSION=0`. A hook whose
 * off-switch is ignored is worse than no hook, because the screenshot then shows a state nobody asked
 * for and the log cannot account for it.
 */
export function hookFlag(env: Record<string, string | undefined>, key: string): boolean {
  const value = hookValue(env, key);
  return value !== undefined && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * A comma-separated hook as a list, in order, with the blanks dropped.
 *
 * **`LOTSE_APP_SWITCH=fixture-1,fixture-2` is a walk, and a walk has an order**, which is the whole
 * reason this is a list rather than a set: opening A and then B is a different run from opening B
 * and then A. Empty entries are dropped rather than kept as `''`, so a trailing comma — which is what
 * a shell leaves behind when a variable is built up in a loop — asks for one session fewer instead of
 * for a session whose id is the empty string.
 */
export function hookList(env: Record<string, string | undefined>, key: string): string[] {
  const value = hookValue(env, key);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

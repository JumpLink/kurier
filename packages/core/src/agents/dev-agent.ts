/**
 * The stand-in agent: a spawnable ACP peer for the window, and the hook that chooses it.
 *
 * **It is deliberately NOT in `agents/launcher.ts`, and the reason is that table's own header.** That
 * table is "a table of programs, not of capabilities" and `lotse agents` prints it as what a person
 * can install and run. The stand-in is a dev fixture inside this repository — a file under
 * `scripts/`, run with Node, reachable only by naming it in a dev hook — and putting it in the table
 * would print "Kurier stand-in agent" to somebody who asked which agents they have, next to OpenCode,
 * with no marker that it is a fixture. A test also pins that table's ids to exactly `['opencode']`.
 *
 * So it is reachable the only other way this surface reaches anything a pointer cannot:
 * **`KU_APP_AGENT=stand-in`**, read once at startup (`gui/hooks.ts`). That is the same mechanism
 * `KU_APP_SESSION` uses to open a session without a click, and it means the stand-in costs nothing in
 * the shipped surface: no launcher, no menu entry, no way to pick it by accident.
 *
 * The command line for a person is in `AGENTS.md`, because a fixture that cannot be run by hand is a
 * fixture nobody runs:
 *
 * ```sh
 * KURIER_SESSIONS_FILE=<file> KU_APP_SESSION=<id> KU_APP_AGENT=stand-in \
 *   ./node_modules/.bin/gjsify workspace lotse-cli start:app
 * ```
 *
 * **It runs on Node, not GJS, and `program: 'node'` is the honest spelling of that.** The script is
 * `scripts/stand-in-agent.mjs`, a plain ESM module with no GTK and no bundling; kurier's own
 * `AGENTS.md` records the two failures of importing a gjsify package under Node and under GJS when
 * trying to share code between them. The fixture exists to be *run*, not to be shipped, so it uses the
 * one runtime that needs no build step.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_AGENT, findLauncher, launcherIds, requireLauncher } from './launcher.ts';
import { describeResolved, type ResolvedAgent, type ResolvedSource } from './resolve.ts';
import type { AgentCommand } from './stdio.ts';

/** The name `KU_APP_AGENT` takes for the fixture. */
export const STAND_IN_AGENT_ID = 'stand-in';

/** Where the fixture lives, relative to the repository root. */
export const STAND_IN_SCRIPT = 'scripts/stand-in-agent.mjs';

/**
 * Where the fixture's source is, as an absolute path.
 *
 * **`KU_STANDIN_AGENT` overrides the guess.** The fallback derives the repository root from this
 * module's own location — the bundle lives in `app/dist/`, so the script is two levels up — which is
 * right for a checkout and meaningless for an installed app. That is fine: an installed app has no
 * fixture, and the override is how somebody points at a copy outside the repository (a second checkout,
 * a wrapper). Guessing is documented rather than pretended: an override beats a wrong guess, and a
 * wrong guess surfaces as a sentence on screen, not a crash.
 */
export function standInScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['KU_STANDIN_AGENT']?.trim();
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', STAND_IN_SCRIPT);
}

/** The `AgentCommand` for the fixture. Exactly the four keys `AgentCommand` documents. */
export function standInCommand(script: string = standInScriptPath()): AgentCommand {
  return {
    id: STAND_IN_AGENT_ID,
    title: `Kurier stand-in agent (${STAND_IN_SCRIPT})`,
    program: 'node',
    args: [script],
  };
}

export interface DevAgentChoice {
  readonly command: AgentCommand;
  /** Which copy runs — what a new session's record names. A launcher or the stand-in is `host`. */
  readonly source: ResolvedSource;
  /** A line the caller should print, or `null` when there is nothing to explain. */
  readonly note: string | null;
}

/**
 * Which agent a window talks to, given the dev hook.
 *
 * **An unknown name falls back to the default rather than failing the window.** The hook is typed by
 * hand into a command line; a typo there should cost the person their typed fixture and nothing else.
 * A refusal here would mean no window at all, and the reason would be printed to a stderr they may not
 * be watching — a dev hook that can keep the app from starting is not a dev hook.
 */
export function chooseAgent(
  id: string | undefined | null,
  resolveDefault: () => ResolvedAgent | null = () => null,
): DevAgentChoice {
  const wanted = id?.trim();
  if (!wanted) {
    // No explicit choice: the available setting, else the person's own install, else the bundled copy. With neither, the launcher
    // stays the command, so the window starts and its composer says why the agent will not (the same
    // failure as before the bundled copy existed).
    const found = resolveDefault();
    if (found) return { command: found.command, source: found.source, note: describeResolved(found) };
    return { command: requireLauncher(DEFAULT_AGENT), source: 'host', note: null };
  }
  if (wanted === STAND_IN_AGENT_ID) {
    return {
      command: standInCommand(),
      source: 'host',
      note: `using the stand-in agent (${STAND_IN_SCRIPT}) — a dev fixture, not a launcher`,
    };
  }
  const found = findLauncher(wanted);
  if (found) return { command: found, source: 'host', note: null };
  return {
    command: requireLauncher(DEFAULT_AGENT),
    source: 'host',
    note: `KU_APP_AGENT=${wanted} is not an agent launcher — using ${DEFAULT_AGENT}. Try one of: ${launcherIds().join(', ')}`,
  };
}

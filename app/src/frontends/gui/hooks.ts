/**
 * The dev hooks — the states that can only be reached by a pointer, and so need an env var to be
 * verifiable at all.
 *
 * This is not a debug leftover and the reason is measured. gjsify's devtools plane over `gdbus`
 * cannot type into an entry (`SendKey` takes accelerators, not text) and **cannot operate a combo
 * row**: `ActivateWidget` on an `Adw.ComboRow`'s internal list row reports `true` and changes no
 * selection. So a config dropdown, a permission dialog answered by clicking, and a stopped turn are
 * three states that a screenshot of the running app cannot reach from the outside. Without a hook
 * they are the parts of this surface that are written and never checked.
 *
 * Read from the environment at startup and passed down, rather than read at the point of use: a hook
 * that is read late can be flipped between two states inside one run, and a test that says
 * "with the hook set, this state is reachable" has to mean one thing.
 */

import { readAppDevHooks, type AppDevHooks } from '@gjsify/adwaita-app';

import { DEV_HOOK_PREFIX } from './constants.ts';

/** What the hooks framework gives us: `view`, `file`, `debug`. */
export type FrameworkHooks = AppDevHooks;

/** What this surface adds on top, and why each one exists. */
export interface KurierHooks extends FrameworkHooks {
  /**
   * `KU_APP_SESSION` — open this session id at startup.
   *
   * Without it the only reachable state is an empty window, because selecting a session needs a
   * click. A surface whose interesting half cannot be opened without a mouse is a surface whose
   * interesting half is untested.
   */
  session?: string;

  /**
   * `KU_APP_AGENT` — which agent this window talks to. Unset means the CLI's default launcher.
   *
   * Not an `AgentCommand` and not a path: an *agent id*, resolved in `core/agents/dev-agent.ts`. The
   * two accepted values are a real launcher (`opencode`) and `stand-in`, the dev fixture — and the
   * fixture is the reason the hook exists at all, because a real turn costs a model call and is not
   * reproducible, so every running/streaming/stopped state in this window is looked at against it.
   * An unknown id falls back to the default with a line in the log rather than refusing to start.
   */
  agent?: string;

  /**
   * `KU_APP_PERMISSION` — stage an open `session/request_permission` at startup.
   *
   * The dialog is the **reason this project exists**: a modal that must appear, must show what the
   * agent wants to do, and must fail closed on Escape. None of that is observable from outside
   * without a staged request, and none of it works in a build-only CI run.
   */
  permission?: boolean;

  /**
   * `KU_APP_CONFIG` — open with a config option set to this value id, as if it had been picked.
   *
   * For the same reason: a `Gtk.DropDown` is exactly the widget the devtools plane cannot operate,
   * and the config row is the surface's most-used control.
   */
  config?: string;

  /**
   * `KU_APP_THINKING` — send a prompt at startup, so a running turn can be reached without a pointer.
   *
   * The turn that follows is a **real** turn against whatever `KU_APP_AGENT` selected: this hook starts
   * it, it does not stage a fake one. Against the stand-in agent that is free and repeatable, and
   * against `opencode` it is a model call — which is exactly why the fixture is the default way to look
   * at this state and why the prompt it sends is a fixture prompt rather than anything of the person's.
   */
  thinking?: string;

  /**
   * `KU_APP_PROMPT` — the text `KU_APP_THINKING` sends. Fixed English, synthetic: a screenshot must
   * not carry a real conversation out of a real session file.
   */
  prompt?: string;
}

/**
 * Read `KU_APP_*` at startup.
 *
 * The framework's own reader is used rather than hand-rolled `process.env` lookups, so the
 * "empty means unset" rule and the truthiness rule are the framework's — a second implementation of
 * "is this set" is how two hooks disagree about `KU_APP_THINKING=0`.
 */
export function readHooks(env: Record<string, string | undefined> = process.env): KurierHooks {
  const framework = readAppDevHooks({ prefix: DEV_HOOK_PREFIX, env });
  const trimmed = (key: string): string | undefined => {
    const value = env[`${DEV_HOOK_PREFIX}_${key}`]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  return {
    ...framework,
    session: trimmed('SESSION'),
    agent: trimmed('AGENT'),
    permission: trimmed('PERMISSION') !== undefined,
    config: trimmed('CONFIG'),
    thinking: trimmed('THINKING'),
    prompt: trimmed('PROMPT'),
  };
}

/**
 * The native GNOME front-end — entry point.
 *
 * A third surface on the same kernel as `kurier start` and the MCP server: it builds an `AcpClient`
 * and calls the same `app/src/core` actions, and it renders every sentence about a session from the
 * transcript the core produced. Nothing about ACP, about permissions or about a config option is
 * decided in here.
 *
 * **Its own bundle, not a subcommand of the CLI.** `import Gtk from '@girs/gtk-4.0'` becomes a
 * top-level `gi://Gtk` in the bundle, so folding this into `kurier.gjs.mjs` would make every
 * `kurier sessions` in a terminal — including over SSH, where there is no display at all — load GTK
 * and libadwaita and die. Two entry points, one kernel. Verified by the build: `gi://Adw` and
 * `gi://Gtk` appear 0× in the CLI bundle and ≥1× in this one.
 *
 *   build: gjsify workspace kurier-cli build:app    (→ dist/kurier-app.gjs.mjs)
 *   run:   gjsify workspace kurier-cli start:app
 *
 * The shell is `@gjsify/adwaita-app`'s `runAdwaitaApp`, which owns the `runAsync` lifecycle — never
 * the synchronous `run()`, which starves the promise-job queue, so an awaited agent answer never
 * resolves and a spinner turns for ever. That is not a style preference: the CLI already depends on
 * the same lifecycle, and the two surfaces disagreeing about it is a bug with two faces.
 */

import Gtk from '@girs/gtk-4.0';
import { runAdwaitaApp } from '@gjsify/adwaita-app';

import { LOCAL_PRINCIPAL, createSessionStore, forPrincipal } from '@kurier/session';

import { chooseAgent } from '../../core/agents/dev-agent.ts';
import { sessionsFile } from '../../core/paths.ts';
import { APP_CSS } from './css.ts';
import { readHooks } from './hooks.ts';
import { MainWindow } from './window.ts';
import { APP_ID, APP_NAME, APP_VERSION } from './constants.ts';

// Pin GTK 4 before libadwaita pulls it in; keep the import referenced. Without this the import looks
// unused to the linter, and the version pin it documents is the thing that actually matters when
// libadwaita and the `@girs/*` types disagree about a signature.
void Gtk;

/**
 * Read the dev hooks **once**, before the window exists — see `hooks.ts` for why each one has to
 * exist at all, and why a state that only a click can reach is a state nobody has checked.
 */
const hooks = readHooks();

/**
 * Which agent this window will start on its first prompt.
 *
 * **Resolved once, here, and handed to the window as an `AgentCommand`.** The alternative — the window
 * reading `KU_APP_AGENT` itself — would put an environment lookup and a fallback rule in a widget file,
 * and `hooks.ts` exists precisely so that every environment read happens once at startup and can be
 * reasoned about as a whole. An unknown id prints its line here, where a person watching the terminal
 * will see it, and falls back rather than refusing to start.
 */
const agent = chooseAgent(hooks.agent);
if (agent.note) console.log(`kurier: ${agent.note}`);

const status = await runAdwaitaApp({
  applicationId: APP_ID,
  css: APP_CSS,
  about: {
    applicationName: APP_NAME,
    applicationIcon: APP_ID,
    developerName: 'JumpLink / Art+Code Studio',
    version: APP_VERSION,
    website: 'https://github.com/JumpLink/kurier',
    license: 'AGPL-3.0-or-later',
    comments:
      'An ACP client for GNOME: start a coding agent as a subprocess, watch it work, and answer ' +
      'the questions it asks. The agent brings its own model, its own tools and its own login — ' +
      'kurier shows what it offers and asks before it acts. The same kernel as the command line.',
  },
  // The same read `kurier sessions` does, principal filter included: two surfaces listing different
  // sessions from one file would make one of them wrong, and nobody could say which.
  createWindow: (app) =>
    new MainWindow(app, {
      hooks,
      agent: agent.command,
      loadSessions: () => forPrincipal(createSessionStore(sessionsFile()).all(), LOCAL_PRINCIPAL),
      // **One store for the window's lifetime, not one per call.** The window reads the file once at
      // startup and appends a batch per streamed chunk; a fresh store per append would re-read and
      // re-parse a file that may hold thirty conversations, for every token an agent emits. The store is
      // a synchronous JSON file with no cache of its own, so this is the only place that can be improved,
      // and "improve it" is a change to `@kurier/session` rather than a decision for a surface.
      appendTurns: (sessionId, entries) => {
        createSessionStore(sessionsFile()).append(sessionId, entries);
      },
    }),
});

process.exit(status);

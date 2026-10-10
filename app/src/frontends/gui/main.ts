/**
 * The native GNOME front-end — entry point.
 *
 * A third surface on the same kernel as `lotse start` and the MCP server: it builds an `AcpClient`
 * and calls the same `app/src/core` actions, and it renders every sentence about a session from the
 * transcript the core produced. Nothing about ACP, about permissions or about a config option is
 * decided in here.
 *
 * **Its own bundle, not a subcommand of the CLI.** `import Gtk from '@girs/gtk-4.0'` becomes a
 * top-level `gi://Gtk` in the bundle, so folding this into `kurier.gjs.mjs` would make every
 * `lotse sessions` in a terminal — including over SSH, where there is no display at all — load GTK
 * and libadwaita and die. Two entry points, one kernel. Verified by the build: `gi://Adw` and
 * `gi://Gtk` appear 0× in the CLI bundle and ≥1× in this one.
 *
 *   build: gjsify workspace lotse-cli build:app    (→ dist/lotse-app.gjs.mjs)
 *   run:   gjsify workspace lotse-cli start:app
 *
 * The shell is `@gjsify/adwaita-app`'s `runAdwaitaApp`, which owns the `runAsync` lifecycle — never
 * the synchronous `run()`, which starves the promise-job queue, so an awaited agent answer never
 * resolves and a spinner turns for ever. That is not a style preference: the CLI already depends on
 * the same lifecycle, and the two surfaces disagreeing about it is a bug with two faces.
 */

import Gtk from '@girs/gtk-4.0';
import { runAdwaitaApp } from '@gjsify/adwaita-app';

import { LOCAL_PRINCIPAL, createSessionStore, forPrincipal } from '@lotse/session';

import {
  BUNDLED_AGENTS,
  NO_AGENT_MESSAGE,
  chooseAgent,
  currentSandboxFacts,
  emptyStateView,
  gatherCwdFacts,
  gatherResolveContext,
  gatherResolveContextAsync,
  isSandboxed,
  noticeView,
  resolveCwd,
  resolveDefaultWithNote,
  resolveRecorded,
} from '@lotse/core';
import { migratedPaths } from '../../core/migrate.ts';
import { markSeen, readNotices, writeNotices } from '../../core/notices.ts';
import { backupPath, readSettings, saveSettings } from '../../core/settings.ts';
import { settingsChoicesView } from '../../core/settings-view.ts';
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
 * The paths — and, on the first run after the rename, the move from the ones kurier wrote
 * (`core/migrate.ts`). A note per directory that was not already in place, printed like the
 * settings notes below, because a person whose conversations just moved deserves to be told, and a
 * person whose move *failed* deserves to be told more.
 */
const { paths, notes: migrationNotes } = migratedPaths();
for (const note of migrationNotes) console.log(`lotse: ${note}`);

/**
 * What the settings said about themselves: an unreadable file, or a choice that is not available here.
 * **Carried as values, printed to the terminal for now** — the window shows them in a later slice, and
 * until then a person watching the terminal is the only one who can be told.
 */
const settingsNotes: string[] = [];

/**
 * Which agent this window will start on its first prompt.
 *
 * **Resolved once, here, and handed to the window as an `AgentCommand`.** The alternative — the window
 * reading `LOTSE_APP_AGENT` itself — would put an environment lookup and a fallback rule in a widget file,
 * and `hooks.ts` exists precisely so that every environment read happens once at startup and can be
 * reasoned about as a whole. An unknown id prints its line here, where a person watching the terminal
 * will see it, and falls back rather than refusing to start. With no hook the agent is resolved as the CLI
 * resolves it: the saved setting if it is available, else the person's own install, else the bundled copy.
 */
let nothingFound = false;
const agent = chooseAgent(hooks.agent, () => {
  const { settings, problem } = readSettings(paths.settingsFile);
  if (problem) settingsNotes.push(problem);
  // No `--version` spawn. Inside a Flatpak this still asks the host, synchronously (up to 5 s per
  // launcher), before the window exists — only the preferences dialog is asynchronous (see below).
  const { agent: found, note } = resolveDefaultWithNote(gatherResolveContext(paths, false), settings.agent);
  if (note) settingsNotes.push(note);
  if (!found || hooks.noAgent) {
    nothingFound = true;
    console.log(`kurier: ${NO_AGENT_MESSAGE}`);
    return null;
  }
  return found;
});
// `LOTSE_APP_NO_AGENT` beats `LOTSE_APP_AGENT`: it forces the nothing-found resolution for the empty state.
const noAgent = hooks.noAgent === true || nothingFound;
const emptyView = noAgent ? emptyStateView({ agent: null }) : null;

/**
 * The bundled-agent notice, read once: nothing seen yet (or a file that could not be read, which shows it
 * again) and the copy that runs. `LOTSE_APP_NOTICE` forces the bundled condition — the copy does not exist
 * outside a Flatpak.
 */
const noticesPath = paths.noticesFile;
const noticesRead = readNotices(noticesPath);
if (noticesRead.problem) console.log(`kurier: ${noticesRead.problem}`);
const notice = noAgent
  ? null
  : noticeView(hooks.notice === true ? 'bundled' : agent.source, noticesRead.notices.seen);
for (const note of settingsNotes) console.log(`kurier: ${note}`);
if (agent.note) console.log(`kurier: ${agent.note}`);

const sandboxed = isSandboxed(currentSandboxFacts());

/**
 * Where a new chat runs. `LOTSE_APP_CWD` is the dev hook that pins it (a screenshot must not show a real
 * directory name), `LOTSE_CWD` is the same override for a person; `resolveCwd` decides the rest.
 */
const facts = gatherCwdFacts(process.env);
const cwd = resolveCwd({ ...process.env, ...(hooks.cwd ? { LOTSE_CWD: hooks.cwd } : {}) }, facts);

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
  // The same read `lotse sessions` does, principal filter included: two surfaces listing different
  // sessions from one file would make one of them wrong, and nobody could say which.
  createWindow: (app) =>
    new MainWindow(app, {
      hooks,
      agent: agent.command,
      agentSource: agent.source,
      ...(emptyView?.kind === 'no-agent' ? { noAgent: emptyView } : {}),
      ...(notice
        ? {
            notice,
            rememberNotice: (id: typeof notice.id) => {
              try {
                writeNotices(noticesPath, markSeen(readNotices(noticesPath).notices, id));
              } catch (error) {
                console.log(
                  `kurier: could not remember the notice — ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          }
        : {}),
      newChat: cwd ? { cwd, home: facts.home } : null,
      // **Only when no agent is pinned.** `LOTSE_APP_AGENT` means "this agent, for everything in this window"
      // — a fixture record naming `opencode` must be answered by the stand-in, not start a real one.
      ...(hooks.agent
        ? {}
        : {
            resolveAgent: async (id, source) => {
              try {
                return resolveRecorded(
                  id,
                  source,
                  sandboxed
                    ? await gatherResolveContextAsync(paths)
                    : gatherResolveContext(paths, false, false),
                );
              } catch (error) {
                return { problem: error instanceof Error ? error.message : String(error) };
              }
            },
          }),
      preferences: {
        // The file is read afresh on every open and after every choice, so the rows show the file, not a
        // memory of it. Never a blocking child: with no host answer yet (`detected` null) the PATH walk
        // is all that runs, and inside a Flatpak the host rows say "Checking…" until `detect` answers.
        // Outside a Flatpak there is no host question, so `detect` is `null` and the cheap rows are final.
        load: (detected) => {
          const file = paths.settingsFile;
          const { settings, problem, problemKind } = readSettings(file);
          const context = detected ?? gatherResolveContext(paths, false, false);
          return settingsChoicesView(context.detections, BUNDLED_AGENTS, settings, {
            bundledAvailable: context.bundledAvailable,
            problem,
            problemKind,
            backupPath: backupPath(file),
            hostPending: detected === null && sandboxed,
          });
        },
        detect: sandboxed
          ? async () => {
              try {
                return await gatherResolveContextAsync(paths);
              } catch {
                // A probe that threw means "no host answer": the cheap rows, now final.
                return gatherResolveContext(paths, false, false);
              }
            }
          : null,
        save: (choice) => saveSettings(paths.settingsFile, { version: 1, agent: choice }),
      },
      createSession: (record) => {
        createSessionStore(paths.sessionsFile).create(record);
      },
      loadSessions: () => forPrincipal(createSessionStore(paths.sessionsFile).all(), LOCAL_PRINCIPAL),
      // **One store for the window's lifetime, not one per call.** The window reads the file once at
      // startup and appends a batch per streamed chunk; a fresh store per append would re-read and
      // re-parse a file that may hold thirty conversations, for every token an agent emits. The store is
      // a synchronous JSON file with no cache of its own, so this is the only place that can be improved,
      // and "improve it" is a change to `@lotse/session` rather than a decision for a surface.
      appendTurns: (sessionId, entries) => {
        createSessionStore(paths.sessionsFile).append(sessionId, entries);
      },
    }),
});

process.exit(status);

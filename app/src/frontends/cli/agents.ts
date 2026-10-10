/**
 * `kurier agents` — the launchers, and whether their binary is there.
 *
 * A small command with one job: make "not installed" and "broken" different sentences. Both look
 * identical from the outside until you know whether the binary exists, and the fix for each is
 * nothing alike. The SOURCE column says where a usable one came from — the person's own install
 * (`host`) or the copy shipped inside this build (`bundled`) — and the last line names the one kurier
 * would start now.
 */

import type { CommandModule } from 'yargs';

import { resolveAgent, detectAgents, type AgentDetection } from '../../core/agents/detect.ts';
import { DEFAULT_AGENT, LAUNCHERS, launcherIds } from '../../core/agents/launcher.ts';
import { gatherAgentFacts } from '../../core/agents/probe.ts';
import type { AgentCommand } from '../../core/agents/stdio.ts';
import type { KurierPaths } from '../../core/paths.ts';
import {
  describeChoice,
  parseChoiceSpec,
  readSettings,
  saveSettings,
  type Settings,
} from '../../core/settings.ts';

import { NO_AGENT_REMEDY } from '../../core/empty-state.ts';
import { err, out, pickArgv } from './output.ts';

const SOURCE_LABEL = { host: 'host', bundled: 'bundled', none: 'not found' } as const;

/** The table and the closing line, as text. Pure: the detections are an argument. */
export function agentsReport(
  launchers: readonly AgentCommand[],
  detections: readonly AgentDetection[],
  chosen: AgentDetection | null,
): string[] {
  const rows = [['AGENT', 'PROGRAM', 'SOURCE', 'STATE', 'COMMAND']];
  for (const launcher of launchers) {
    const found = detections.find((entry) => entry.id === launcher.id);
    rows.push([
      `${launcher.id === DEFAULT_AGENT ? '*' : ' '}${launcher.id}`,
      launcher.program,
      SOURCE_LABEL[found?.source ?? 'none'],
      found?.path ?? 'NOT FOUND',
      launcher.args.join(' '),
    ]);
  }
  // Header and rows share one width per column, taken from the data: STATE holds a full path whose
  // length nothing bounds. The marker rides inside the AGENT cell, so the header's cell is indented to match.
  rows[0]![0] = ` ${rows[0]![0]}`;
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join(' ')
      .trimEnd(),
  );
  lines.push('');
  lines.push(
    chosen
      ? `kurier would use: ${chosen.id} (${SOURCE_LABEL[chosen.source]}, ${chosen.path}${chosen.version ? `, ${chosen.version}` : ''})`
      : `kurier would use: none — no agent is available — ${NO_AGENT_REMEDY}`,
  );
  return lines;
}

/** Where the setting lives and what it says, as text. Pure: the file's content is an argument. */
export function settingsReport(file: string, settings: Settings, problem: string | null): string[] {
  const lines = [`setting: ${settings.agent ? describeChoice(settings.agent) : 'none (host, else bundled)'}`];
  lines.push(`settings file: ${file}`);
  if (problem) lines.push(`settings problem: ${problem}`);
  return lines;
}

const command = (paths: KurierPaths): CommandModule => ({
  command: 'agents',
  describe: 'list the agent launchers kurier knows how to start',
  builder: (yargs) =>
    yargs
      .option('use', {
        type: 'string',
        describe: 'remember which agent to start: <id>, <id>:host, <id>:bundled, or none to clear',
      })
      .strict(),
  handler: (argv) => {
    const file = paths.settingsFile;
    const use = pickArgv<string>(argv as Record<string, unknown>, 'use');
    if (use !== undefined) {
      const parsed = parseChoiceSpec(use, launcherIds());
      if ('problem' in parsed) {
        err(parsed.problem);
        process.exitCode = 1;
        return;
      }
      try {
        const { backup } = saveSettings(file, { version: 1, agent: parsed.choice });
        if (backup) err(`the earlier settings file was moved to ${backup}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        err(
          code ? `could not write ${file}: ${code}` : error instanceof Error ? error.message : String(error),
        );
        process.exitCode = 1;
        return;
      }
    }
    const { settings, problem } = readSettings(file);
    const facts = gatherAgentFacts();
    const detections = detectAgents(facts);
    const { detection: chosen, note } = resolveAgent({
      setting: settings.agent,
      detections,
      bundledAvailable: (id) => facts.find((fact) => fact.id === id)?.bundledExists === true,
    });
    for (const line of agentsReport(LAUNCHERS, detections, chosen)) out(line);
    for (const line of settingsReport(file, settings, problem)) out(line);
    if (note) err(note);
    err('* the default for --agent');
  },
});

export const agentsCommand = command;

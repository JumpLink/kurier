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
import { DEFAULT_AGENT, LAUNCHERS } from '../../core/agents/launcher.ts';
import { gatherAgentFacts } from '../../core/agents/probe.ts';
import type { AgentCommand } from '../../core/agents/stdio.ts';

import { err, out } from './output.ts';

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
      : 'kurier would use: none — no agent is available; install one of the launchers above',
  );
  return lines;
}

const command: CommandModule = {
  command: 'agents',
  describe: 'list the agent launchers kurier knows how to start',
  builder: (yargs) => yargs.strict(),
  handler: () => {
    const detections = detectAgents(gatherAgentFacts());
    const chosen = resolveAgent({ setting: null, detections });
    for (const line of agentsReport(LAUNCHERS, detections, chosen)) out(line);
    err('* the default for --agent');
  },
};

export const agentsCommand = command;

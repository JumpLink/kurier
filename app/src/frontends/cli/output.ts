/**
 * Output, in two streams with two jobs.
 *
 * **stdout carries the answer, stderr carries everything about the answer.** An agent's message
 * goes to stdout so `kurier start "…"` pipes into something useful; progress, notices, tool
 * questions and the agent's own log lines go to stderr so they never contaminate it. A person
 * watching a turn sees both; a script sees one.
 */

import type { SessionNotification } from '@lotse/acp/types';
import { labelOf, type SessionRecord } from '@lotse/session';

import { chunkToText, describeUsage } from '@lotse/core';

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Read an option from yargs' argv, trying each key in order.
 *
 * yargs exposes an option under both spellings depending on version and configuration, and the
 * camelCase form is the one that changes without a rename on our side. `--deny-all` read as
 * `argv.denyAll` alone is a flag that silently never fires — a gate that quietly stopped gating.
 */
export function pickArgv<T>(argv: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = argv[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

/** Stream one `session/update` to the right place. This is the CLI's whole "rendering". */
export function showUpdate(notification: SessionNotification, onText: (text: string) => void): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      onText(chunkToText(update.content));
      return;
    case 'agent_thought_chunk':
      // Thought goes to stderr with a marker: it is not part of the answer, and mixing it into
      // stdout would put a model's private reasoning into somebody's pipe.
      err(`  · ${chunkToText(update.content)}`);
      return;
    case 'tool_call':
      err(`  ⚙ ${update.title}${update.status ? ` (${update.status})` : ''}`);
      return;
    case 'tool_call_update': {
      const label = update.title ?? update.toolCallId;
      err(`  ⚙ ${label}${update.status ? ` (${update.status})` : ''}`);
      return;
    }
    case 'plan':
      for (const entry of update.entries) {
        const mark = entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '→' : '·';
        err(`  ${mark} ${entry.content}`);
      }
      return;
    case 'current_mode_update':
      err(`  mode: ${update.currentModeId}`);
      return;
    case 'usage_update': {
      // **The same clause the transcript gets, out of `core/usage.ts`.** This file used to build its
      // own two-field version — input and output tokens and *no cost* — which is how a terminal and a
      // window end up disagreeing about what an agent reported, and it is the version that had no
      // float to round because it never printed the number that has one. One formatter, both surfaces.
      err(`  usage: ${describeUsage(update)}`);
      return;
    }
    case 'available_commands_update':
      for (const command of update.availableCommands) {
        err(`  /${command.name}${command.description ? ` — ${command.description}` : ''}`);
      }
      return;
    default:
      // Not an error, and not silent: an update the client does not know is a line on stderr.
      err(`  (update this client does not know: ${String(update.sessionUpdate)})`);
  }
}

export function showSession(record: SessionRecord): void {
  out(labelOf(record));
  out(`  id       ${record.id}`);
  out(`  agent    ${record.agent}`);
  out(`  cwd      ${record.cwd}`);
  out(`  scope    ${record.boundTo ? `bound to ${record.boundTo}` : 'standalone'}`);
  out(`  updated  ${record.updatedAt}`);
  if (record.reattach) out(`  reattach ${record.reattach}`);
  out();
  for (const turn of record.turns) {
    out(`  ${turn.kind.padEnd(7)} ${turn.text.split('\n').join('\n          ')}`);
  }
}

/**
 * One row per session, newest first. Aligned, because a list of ids is not a list.
 *
 * Says nothing when the list is empty: the caller owns that message, because only it knows whether
 * an empty list means "no sessions at all" or "no sessions for THIS principal" — two different
 * sentences, and printing both is how a person learns to ignore the output.
 */
export function showSessionTable(records: SessionRecord[]): void {
  if (records.length === 0) return;
  const idWidth = Math.min(28, Math.max(...records.map((record) => record.id.length)));
  for (const record of records) {
    const scope = record.boundTo ? `→ ${record.boundTo}` : 'standalone';
    out(
      `${record.id.slice(0, idWidth).padEnd(idWidth)}  ${record.agent.padEnd(10)}  ` +
        `${record.updatedAt.padEnd(24)}  ${scope.padEnd(20)}  ${labelOf(record)}`,
    );
  }
}

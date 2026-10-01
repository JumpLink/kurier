/**
 * A `session/update` stream turned into transcript lines.
 *
 * Two things are deliberately not done here:
 *
 * - **Tool output is summarised, not parsed.** A `tool_call` carries `rawInput`/`rawOutput` in
 *   whatever shape the agent's tool used; a transcript that tried to read it would be a second,
 *   wrong model of somebody else's tool. The status is recorded, the content is not.
 * - **Nothing is filtered for privacy.** The transcript is the conversation, and the file it lands
 *   in is `0600` outside the repository. A filter here would be a policy with no gate behind it —
 *   exactly the shape the plan forbids.
 */

import type { SessionNotification, SessionUpdate } from '@kurier/acp/types';
import type { TranscriptEntry } from '@kurier/session';

import { chunkToText } from './policy.ts';
import { describeUsage } from './usage.ts';

/** One notification becomes zero or more lines; a `plan` update is several. */
export function toTranscript(notification: SessionNotification, at: string): TranscriptEntry[] {
  const update = notification.update;
  const base = { at, sessionId: notification.sessionId };
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return textEntry('user', chunkToText(update.content), base);
    case 'agent_message_chunk':
      return textEntry('agent', chunkToText(update.content), base);
    case 'agent_thought_chunk':
      return textEntry('thought', chunkToText(update.content), base);
    case 'tool_call':
      return [
        {
          ...base,
          kind: 'tool',
          toolCallId: update.toolCallId,
          text: `${update.title}${update.status ? ` — ${update.status}` : ''}`,
        },
      ];
    case 'tool_call_update': {
      const status = update.status ? ` — ${update.status}` : '';
      const title = update.title ? `${update.title}${status}` : status.trim();
      if (!title) return [];
      return [{ ...base, kind: 'tool', toolCallId: update.toolCallId, text: title }];
    }
    case 'plan':
      return update.entries.map((entry) => ({
        ...base,
        kind: 'system' as const,
        text: `plan: [${entry.status ?? 'pending'}] ${entry.content}`,
      }));
    case 'current_mode_update':
      return [{ ...base, kind: 'system', text: `mode: ${update.currentModeId}` }];
    case 'session_info_update':
      return update.title ? [{ ...base, kind: 'system', text: `title: ${update.title}` }] : [];
    case 'usage_update':
      // **The clause is `core/usage.ts`'s, not a template literal here.** A cost arrives as an IEEE
      // double and printing it raw put `0.0014555100000000001 USD` into a person's transcript — a
      // rounding artefact recorded as a price. See that file for the digits and the `<0.0001` case.
      return [{ ...base, kind: 'system', text: `usage: ${describeUsage(update)}` }];
    case 'available_commands_update':
    case 'config_option_update':
      // Bookkeeping the user did not ask for. The commands are still available from
      // `session/new`'s answer, where the protocol says they belong.
      return [];
    default:
      // An update variant from a newer ACP. Recorded as one opaque line: the turn's shape stays
      // visible, and dropping it would make kurier's record disagree with the agent's.
      return [{ ...base, kind: 'system', text: `(${describeUnknown(update)})` }];
  }
}

function textEntry(
  kind: TranscriptEntry['kind'],
  text: string,
  base: { at: string; sessionId: string },
): TranscriptEntry[] {
  return text ? [{ ...base, kind, text }] : [];
}

function describeUnknown(update: SessionUpdate): string {
  const name = String((update as { sessionUpdate?: unknown }).sessionUpdate ?? 'unknown');
  return `update the client does not know: ${name}`;
}

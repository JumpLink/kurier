/**
 * A person at a terminal deciding whether a tool call happens.
 *
 * This is a **gate**, and the distinction matters. It is not a policy store, not a list of what is
 * allowed, and it holds nothing between calls: every request is answered on its own, and the
 * answer is one of the option ids *the agent offered*, so this function cannot invent an outcome.
 *
 * The rules it obeys, and why they are in this file rather than in a config file:
 *
 * - **Silence is a no.** EOF, a closed pipe, or a non-terminal stdin all mean "no". A gate that
 *   reads an empty answer as consent turns a Ctrl-D into an approval, which is the exact failure
 *   mode a gate exists to prevent.
 * - **Only a rejecting option can be returned without typing.** Typing `y` picks the agent's
 *   `allow_once`; anything else picks the agent's `reject_once` if there is one, and declines if
 *   there is not. An agent that offers only `allow_*` therefore cannot get an allow out of a
 *   silence.
 * - **Nothing is remembered.** A second identical request asks again. `allow_always` is offered by
 *   the agent and deliberately not honoured: "always" is a capability to hand to a session, and a
 *   session is a scope, not a permission.
 */

import type { PermissionGate } from '@kurier/acp/gate';
import type { ContentBlock, PermissionOption, RequestPermissionRequest } from '@kurier/acp/types';

/** The terminal's line source. Injected so a test can drive the gate without a process. */
export interface Terminal {
  /** True when a person is there. False means piped input: answer, never ask. */
  readonly interactive: boolean;
  write(text: string): void;
  /** One line, or null at end of input. */
  read(): Promise<string | null>;
  close(): void;
}

const REJECTING: PermissionOption['kind'][] = ['reject_once', 'reject_always'];

export interface TerminalGateOptions {
  terminal: Terminal;
  /** Called with one line per decision. `kurier start` writes these to the session transcript. */
  onDecision?: (optionId: string | null) => void;
}

export function terminalGate(options: TerminalGateOptions): PermissionGate {
  const { terminal, onDecision } = options;
  return async (request: RequestPermissionRequest): Promise<string | null> => {
    const allowing = request.options.filter((option) => !REJECTING.includes(option.kind));
    const rejecting = request.options.filter((option) => REJECTING.includes(option.kind));

    if (!terminal.interactive) {
      // Piped or redirected: the gate cannot ask, so it denies. `kurier start` is documented as
      // needing a terminal for anything beyond one prompt turn without tool calls.
      const declined = rejecting[0]?.optionId ?? null;
      onDecision?.(declined);
      return declined;
    }

    terminal.write('\n');
    terminal.write(describe(request));
    if (allowing.length === 0) {
      // Nothing to allow. There is no decision to collect, so there is no way to say yes.
      terminal.write('  the agent offers no allowing option — declined\n');
      onDecision?.(null);
      return null;
    }
    terminal.write(`  [y] ${allowing.map((option) => option.name).join(' / ')}   [n/Enter] decline\n`);
    const answer = await terminal.read();
    const yes = answer !== null && /^[Yy]$/.test(answer.trim());
    if (yes) {
      const optionId = allowing[0]?.optionId ?? null;
      onDecision?.(optionId);
      return optionId;
    }
    const declined = rejecting[0]?.optionId ?? null;
    onDecision?.(declined);
    return declined;
  };
}

/** What a person is asked. The tool call first — the decision is about the tool, not the option id. */
export function describe(request: RequestPermissionRequest): string {
  const call = request.toolCall;
  const where = call.locations?.[0];
  const lines = [`  tool: ${call.title}${call.kind ? ` (${call.kind})` : ''}`];
  if (where?.path) lines.push(`  file: ${where.path}${where.line ? `:${where.line}` : ''}`);
  if (call.rawInput !== undefined) lines.push(`  input: ${truncate(JSON.stringify(call.rawInput))}`);
  return `${lines.join('\n')}\n`;
}

function truncate(text: string | undefined, limit = 300): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** The human-readable one-liner for an agent message chunk, used by the CLI and the transcript. */
export function chunkToText(content: ContentBlock | undefined): string {
  if (!content) return '';
  if (content.type === 'text') return content.text;
  if (content.type === 'resource_link') return `[${content.name}](${content.uri})`;
  return `[${content.type}]`;
}

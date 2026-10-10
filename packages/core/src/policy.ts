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
 * - **Nothing is remembered here either.** A second identical request asks again, whatever the first
 *   answer was: this file holds no policy between calls. An `allow_always` answer is therefore a
 *   promise the *agent* keeps — it is the agent that decides not to ask again — and kurier asking a
 *   second time is the fail-closed direction, never the dangerous one.
 * - **`y` picks the narrowest allow on offer, and the prompt says so.** Both `allow_once` and
 *   `allow_always` are choices the agent offered, so neither is filtered; but a single `y` typed into a
 *   prompt line is a weaker signal than a click on a button that reads "always", so `allow_once` wins
 *   when the agent sent both. The line prints **which option `y` grants** — `y = Allow once`, not the
 *   agent's own `name`s — because a `y` that silently became a session-wide grant is the one thing on
 *   this screen that must not be a surprise. The agent's wording rides along underneath.
 * - **The options are filtered by the same four-kind set the dialog uses** (`usableOptions`), so a
 *   kind ACP v1 does not name cannot become the answer here any more than it can become a button
 *   there. Reading the raw array would have made this a second gate with its own idea of what an
 *   option is.
 */

import type { PermissionGate } from '@lotse/acp/gate';
import type { ContentBlock, PermissionOption, RequestPermissionRequest } from '@lotse/acp/types';

import { agentNames, initialFocusResponseId, optionLabel, usableOptions } from './permission.ts';

/** The terminal's line source. Injected so a test can drive the gate without a process. */
export interface Terminal {
  /** True when a person is there. False means piped input: answer, never ask. */
  readonly interactive: boolean;
  write(text: string): void;
  /** One line, or null at end of input. */
  read(): Promise<string | null>;
  close(): void;
}

export interface TerminalGateOptions {
  terminal: Terminal;
  /** Called with one line per decision. `kurier start` writes these to the session transcript. */
  onDecision?: (optionId: string | null) => void;
}

export function terminalGate(options: TerminalGateOptions): PermissionGate {
  const { terminal, onDecision } = options;
  return async (request: RequestPermissionRequest): Promise<string | null> => {
    // **The same four-kind filter and the same order the dialog renders**, not the raw wire array: an
    // `allow_whenever` an agent invented would otherwise land in `allowing[0]` here while being
    // invisible in the window. Two surfaces, one answer about what an option is.
    const offered = usableOptions(request);
    const allowing = offered.filter((option) => option.kind.startsWith('allow'));
    // The narrowest decline, chosen once and used by *both* the piped path and the interactive one —
    // otherwise a piped run and a terminal run of the same request would answer differently.
    const declined = initialFocusResponseId(offered);

    if (!terminal.interactive) {
      // Piped or redirected: the gate cannot ask, so it denies. `kurier start` is documented as
      // needing a terminal for anything beyond one prompt turn without tool calls. **The narrowest
      // decline, same as the interactive path** — a pipe is not a reason to answer more broadly.
      onDecision?.(declined);
      return declined;
    }

    terminal.write('\n');
    terminal.write(describe(request));
    if (allowing.length === 0) {
      // Nothing to allow. There is no decision to collect, so there is no way to say yes — and the
      // answer is the decline the agent offered, not `null`, so the agent learns *which* of its own
      // options kurier picked. `null` is the last resort, for an agent that offered nothing rejecting.
      terminal.write('  the agent offers no allowing option — declined\n');
      onDecision?.(declined);
      return declined;
    }
    // The narrowest allow, not the first: one typed `y` is not the same signal as a click on a button
    // that reads "always", so a `*_once` option wins when the agent sent both and `allow_always` is
    // returned only when it is the *only* allow on offer.
    const allowOnce = allowing.find((option) => option.kind === 'allow_once');
    const granted = allowOnce ?? allowing[0]!;
    terminal.write(`  y = ${optionLabel(granted)}    n/Enter = ${declineLabel(offered)}\n`);
    // The agent's own wording underneath, and only when it says something the labels do not — the same
    // `agentNames` rule the dialog body uses, so the two surfaces describe the same set identically.
    const names = agentNames(offered);
    if (names !== null) terminal.write(`  ${names}\n`);
    const answer = await terminal.read();
    if (answer !== null && /^[Yy]$/.test(answer.trim())) {
      onDecision?.(granted.optionId);
      return granted.optionId;
    }
    onDecision?.(declined);
    return declined;
  };
}

/**
 * What the bare-line answer is called, for the prompt line — the same sentence the dialog's decline
 * button carries, so `Enter` means the same thing in both places.
 *
 * Falls back to "decline" when the agent offered nothing rejecting, which is also what the answer
 * *is*: `initialFocusResponseId` returned null, so there is no option id and nothing is granted.
 */
function declineLabel(offered: readonly PermissionOption[]): string {
  const id = initialFocusResponseId(offered);
  if (id === null) return 'decline';
  const option = offered.find((candidate) => candidate.optionId === id);
  return option === undefined ? 'decline' : optionLabel(option);
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

/**
 * The record of a conversation that has just been opened with an agent.
 *
 * One function for `lotse start` and the window, so the CLI and the GUI cannot drift about what a new
 * session looks like on disk: the title, which copy of the agent held it, where it ran, and how it is
 * put back in front of an agent (`reattach`, from what that agent advertised).
 */

import { newSession, type AgentSource, type SessionRecord } from '@lotse/session';

const TITLE_MAX = 72;

/** The first line of the prompt, trimmed and cut at 72 characters; `null` for an empty prompt. */
export function titleFromPrompt(prompt: string): string | null {
  const line = prompt
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (!line) return null;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

export interface ConversationInput {
  readonly id: string;
  readonly agent: string;
  readonly agentSource: AgentSource;
  readonly cwd: string;
  /** What the person asked first; empty for `lotse start` without a prompt. */
  readonly prompt: string;
  readonly at: string;
  readonly supportsLoadSession: boolean;
  readonly supportsResumeSession: boolean;
}

export function conversationRecord(input: ConversationInput): SessionRecord {
  return newSession({
    id: input.id,
    agent: input.agent,
    agentSource: input.agentSource,
    cwd: input.cwd,
    title: titleFromPrompt(input.prompt),
    at: input.at,
    // Recorded now, from the agent's own capabilities, so `resume` knows what this session was
    // reattached with — not what it *should* have been.
    reattach: input.supportsLoadSession ? 'load' : input.supportsResumeSession ? 'resume' : null,
  });
}

/**
 * What a person reads when `session/new` succeeded and the record could not be written.
 *
 * **The agent now holds a session lotse has no record of**, so the sentence says that plainly rather
 * than leaving a generic failure: nothing of this conversation is in the list or the file, and what
 * they typed is on screen only. New chat is the way forward, and it is named because the composer is
 * disabled under this message until it is pressed.
 */
export function unsavedMessage(reason: string): string {
  return `This conversation was not saved (${reason}), so it will not appear in the list. Press New chat to start another.`;
}

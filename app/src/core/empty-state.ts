/**
 * What the window says when no agent can be started, and when it owes the bundled-agent notice. Pure.
 *
 * The remedy sentence is written once, here: the window's empty state and the command line's
 * `NO_AGENT_MESSAGE` (`agents/resolve.ts`) both read it, so the two never drift apart.
 */

import type { ResolvedAgent, ResolvedSource } from './agents/resolve.ts';
import { noticeDue, type NoticeId } from './notices.ts';

export const INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/install | bash';
export const DOCS_URL = 'https://opencode.ai/docs';

/** The remedy as one sentence, for a terminal. */
export const NO_AGENT_REMEDY =
  `install opencode (${INSTALL_COMMAND}, or see ${DOCS_URL}), ` +
  'or install kurier from Flatpak, which bundles one';

export type EmptyStateView =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'no-agent';
      readonly title: string;
      readonly body: string;
      readonly commands: readonly string[];
      readonly docsUrl: string;
      /** Why Send is off, shown under the composer. */
      readonly sendReason: string;
    };

export function emptyStateView(resolution: { readonly agent: ResolvedAgent | null }): EmptyStateView {
  if (resolution.agent !== null) return { kind: 'ready' };
  return {
    kind: 'no-agent',
    title: 'No agent found',
    body:
      'kurier starts a coding agent but found none on this machine. Install opencode with the command ' +
      'below, or install kurier from Flatpak, which bundles one. Then start kurier again.',
    commands: [INSTALL_COMMAND],
    docsUrl: DOCS_URL,
    sendReason: 'No agent found, so there is nothing to send to.',
  };
}

export interface NoticeView {
  readonly id: NoticeId;
  readonly text: string;
  readonly button: string;
}

// Three lines at the 360 px floor: Adw.Banner ellipsizes beyond that, which would cut the statement itself.
const BUNDLED_TEXT =
  'Bundled OpenCode, free models: time-limited, and use without an account is undocumented. ' +
  'What you send goes to that provider.';

/** The banner to show, or `null`: only the bundled copy earns one, and only until it was dismissed. */
export function noticeView(source: ResolvedSource | null, seen: readonly string[]): NoticeView | null {
  if (source !== 'bundled' || !noticeDue('bundled-agent', seen)) return null;
  return { id: 'bundled-agent', text: BUNDLED_TEXT, button: 'Got it' };
}

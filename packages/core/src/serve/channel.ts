/**
 * How `serve` reaches its person — the seam ADR 0002 §9 asks for.
 *
 * A task never names a channel. It names a profile, the profile a user, and `serve` hands every
 * message for that user to the one `ServeChannel` it was started with. The first channel is a
 * desktop notification (the app's `desktop-notifier.ts`); a Curlew/XMPP channel is a second
 * implementation of this interface and changes no task.
 *
 * Only `send` today. Reading answers off the channel ("read new messages since a position") arrives
 * with the Curlew channel; until then an answer comes in through `lotse answer`.
 */

import type { ServeUser } from './config.ts';

export interface ServeMessage {
  readonly title: string;
  readonly body: string;
  /** The question this message asks, so a channel with replies can thread the answer to it. */
  readonly questionId: string | null;
}

export interface ServeChannel {
  /** For the log: `desktop`, `stderr`, later `curlew`. */
  readonly name: string;
  send(user: ServeUser, message: ServeMessage): Promise<void> | void;
}

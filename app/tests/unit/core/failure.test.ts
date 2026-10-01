/**
 * `core/failure.ts` — which failure this is, and what the window may say about it.
 *
 * Both runtimes, no display. The whole point of the module is that these two questions are answered
 * before any widget exists, so this file is where they are answered twice over.
 */
import { RpcError, UnsupportedCapabilityError } from '@kurier/acp';
import { describe, expect, it } from '@gjsify/unit';

import {
  AUTH_COMMAND,
  AuthRequiredError,
  failureKind,
  failureNotice,
  failureToShow,
  staleDialog,
} from '../../../src/core/failure.ts';
import type { AgentAttachment } from '../../../src/core/turn.ts';

/**
 * ACP's own "log in first", exactly as `@kurier/acp` raises it: an `RpcError` carrying the wire
 * code. The constructor takes the whole `WireError`, so the message and the code are passed as one.
 */
function authRequired(): unknown {
  return new RpcError({ code: -32000, message: 'Authentication required' });
}

export default async function failure(): Promise<void> {
  await describe('failure — which failure this is', async () => {
    await it('reads ACP’s own auth_required as the auth trap', async () => {
      expect(failureKind(authRequired())).toBe('auth');
    });

    await it('reads the hint-wrapped error as the same trap, because withAuthHint replaces it', async () => {
      // This is the case that matters: the controller never sees the raw RpcError, it sees what
      // `withAuthHint` threw. A classifier that only knew the RpcError would call every auth failure
      // in the app a plain start failure, and the dialog would never appear.
      const wrapped = new AuthRequiredError('attaching to the session failed: run `kurier auth`');
      expect(failureKind(wrapped)).toBe('auth');
    });

    await it('reads a reattach refusal as its own kind, not as a start failure', async () => {
      // Trap 2: the agent ran and cannot reattach. `AcpClient.reattach` rejects with this class, so the
      // class is the fact — not a message that happens to mention a capability.
      const refused = new UnsupportedCapabilityError('this agent can neither load nor resume', {
        loadSession: false,
        resume: false,
      });
      expect(failureKind(refused)).toBe('unsupported');
    });

    await it('reads everything else as a failure to start', async () => {
      expect(failureKind(new Error('spawn opencode ENOENT'))).toBe('start');
      expect(failureKind('a string')).toBe('start');
      expect(failureKind(undefined)).toBe('start');
    });

    await it('does not classify by wording — an agent’s own text cannot claim to be a failure kind', async () => {
      // The whole reason the rule is "match the type": an agent is free to put any words in an error,
      // including the words kurier uses for its own sentences.
      expect(failureKind(new Error('session/load failed: run `kurier auth`'))).toBe('start');
      expect(failureKind(new Error('this agent can neither load nor resume a session'))).toBe('start');
    });

    await it('keeps the original error reachable on the wrapper', async () => {
      const cause = authRequired();
      expect(new AuthRequiredError('hint', { cause }).cause).toBe(cause);
    });
  });

  await describe('failure — what the window says', async () => {
    await it('names `kurier auth` for the auth trap, and says why a window cannot do it', async () => {
      const notice = failureNotice('auth');
      expect(notice).not.toBe(null);
      expect(notice?.command).toBe(AUTH_COMMAND);
      expect(notice?.command).toBe('kurier auth');
      expect(notice?.body).toContain('no terminal');
    });

    await it('says a reattach refusal is a refusal, and offers no command to run', async () => {
      // Plan §6: "shown as a refusal, not as an empty transcript". A dialog that offered a command
      // would be inventing a remedy; there is none, and the honest sentence is the refusal itself.
      const notice = failureNotice('unsupported');
      expect(notice).not.toBe(null);
      expect(notice?.command).toBe(null);
      expect(notice?.heading).toContain('cannot reopen');
    });

    await it('gives a failure to start no dialog at all', async () => {
      // The composer caption already says it and the window is otherwise usable; a modal here would
      // say "something is wrong" without adding anything the caption does not.
      expect(failureNotice('start')).toBe(null);
    });

    await it('is total over the three kinds, and never returns a command for the two that have none', async () => {
      const kinds = ['auth', 'unsupported', 'start'] as const;
      for (const kind of kinds) {
        const notice = failureNotice(kind);
        if (kind === 'start') {
          expect(notice).toBe(null);
        } else {
          expect(notice?.heading.length).toBeGreaterThan(0);
          expect(notice?.body.length).toBeGreaterThan(0);
          expect(notice?.command).toBe(kind === 'auth' ? AUTH_COMMAND : null);
        }
      }
    });

    await it('carries no agent text and no markup — the copy is kurier’s own', async () => {
      for (const kind of ['auth', 'unsupported'] as const) {
        const notice = failureNotice(kind);
        expect(notice?.heading).not.toContain('<');
        expect(notice?.body).not.toContain('<');
      }
    });
  });
  await describe('failure — the dialog a window still owes', async () => {
    // The attachment objects are built here rather than produced by a controller, because the rule
    // under test is about *identity* and a surface holding two references to one failure must behave the
    // same whether the controller or a test made it.
    const authFailure = (): AgentAttachment => ({
      status: 'failed',
      kind: 'auth',
      message: 'attaching to the session failed: run `kurier auth`',
    });
    const startFailure = (): AgentAttachment => ({
      status: 'failed',
      kind: 'start',
      message: 'spawn opencode ENOENT',
    });

    await it('owes a dialog the first time it sees a failure', async () => {
      expect(failureToShow(authFailure(), null)?.command).toBe(AUTH_COMMAND);
      expect(failureToShow(startFailure(), null)).toBe(null);
    });

    await it('owes nothing once that exact failure has been shown — the dialog that came back', async () => {
      // The defect: `#onSnapshot` fires on every state move and `attachment` stays `failed`, so a guard
      // on "is a dialog up right now" passes the moment a person dismisses one. Identity is the fix.
      const failure = authFailure();
      expect(failureToShow(failure, null)).not.toBe(null);
      expect(failureToShow(failure, failure)).toBe(null);
      // …and it stays owed-nothing for as long as that attachment is current, which is every later
      // snapshot in the same run.
      expect(failureToShow(failure, failure)).toBe(null);
      expect(failureToShow(failure, failure)).toBe(null);
    });

    await it('owes a dialog again for a *different* failure, which is a different attachment', async () => {
      // One window, one agent — but a failure that happens after a retry is a new object, and a
      // "have I ever shown a failure" guard would swallow it.
      const first = authFailure();
      const second = authFailure();
      expect(first).not.toBe(second);
      expect(failureToShow(second, first)).not.toBe(null);
    });

    await it('owes nothing for anything that is not a failure', async () => {
      const others: AgentAttachment[] = [
        { status: 'none' },
        { status: 'attaching' },
        { status: 'attached', name: 'OpenCode 2.0.19' },
        { status: 'gone', reason: 'exited with code 3' },
      ];
      for (const attachment of others) expect(failureToShow(attachment, null)).toBe(null);
    });

    await it('marks a dialog stale as soon as the window has moved on', async () => {
      // The other half: a modal left up over an attached agent, or over another session, is both a lie
      // and something that blocks the window.
      const failure = authFailure();
      expect(staleDialog(failure, failure)).toBe(false);
      expect(staleDialog(failure, { status: 'attached', name: 'OpenCode 2.0.19' })).toBe(true);
      expect(staleDialog(failure, { status: 'none' })).toBe(true);
      // Nothing shown, so nothing can be stale *because of* a move — a clean window is not a reason to
      // close anything, and `close()` is a no-op there anyway.
      expect(staleDialog(null, authFailure())).toBe(true);
    });
  });
}

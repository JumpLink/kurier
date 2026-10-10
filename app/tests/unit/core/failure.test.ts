/**
 * `core/failure.ts` — which failure this is, and what the window may say about it.
 *
 * Both runtimes, no display. The whole point of the module is that these two questions are answered
 * before any widget exists, so this file is where they are answered twice over.
 */
import { RpcError, UnsupportedCapabilityError } from '@lotse/acp';
import { describe, expect, it } from '@gjsify/unit';

import {
  AUTH_COMMAND,
  AuthRequiredError,
  failureAction,
  failureKind,
  failureNotice,
  failureToShow,
  isQuotaExhausted,
  staleDialog,
  type AgentAttachment,
} from '@lotse/core';

/**
 * ACP's own "log in first", exactly as `@lotse/acp` raises it: an `RpcError` carrying the wire
 * code. The constructor takes the whole `WireError`, so the message and the code are passed as one.
 */
function authRequired(): unknown {
  return new RpcError({ code: -32000, message: 'Authentication required' });
}

/** opencode 2.0.22 for a logged-in Zen account without balance: `-32603`, with the name in `data`. */
function quotaExhausted(): unknown {
  return new RpcError({
    code: -32603,
    message: 'Internal error: Upstream request failed: Insufficient account funds',
    data: { service: 'session', errorName: 'provider.quota' },
  });
}

export default async function failure(): Promise<void> {
  await describe('failure — an account without credit', async () => {
    await it('is its own kind, read from the error name and not from the sentence', async () => {
      expect(failureKind(quotaExhausted(), { promptSent: true })).toBe('quota');
      const reworded = new RpcError({
        code: -32603,
        message: 'something else entirely',
        data: { errorName: 'provider.quota' },
      });
      expect(failureKind(reworded, { promptSent: true })).toBe('quota');
    });

    await it('is not guessed from the wording or from the code alone', async () => {
      const sameWords = new RpcError({ code: -32603, message: 'Insufficient account funds' });
      expect(isQuotaExhausted(sameWords)).toBe(false);
      expect(failureKind(sameWords, { promptSent: true })).toBe('start');
      expect(isQuotaExhausted(new Error('provider.quota'))).toBe(false);
    });

    await it('tells a logged-in person not to log in again, and offers the model button', async () => {
      const notice = failureNotice('quota')!;
      expect(notice.command).toBe(null);
      expect(notice.action).toBe('choose-model');
      expect(notice.body.includes('lotse auth')).toBe(false);
      expect(failureAction(notice, { modelChoice: true, login: false })).toBe('choose-model');
      expect(failureAction(notice, { modelChoice: false, login: false })).toBe(null);
    });
  });

  await describe('failure — which failure this is', async () => {
    await it('reads ACP’s own auth_required as the auth trap when no prompt has gone out', async () => {
      expect(failureKind(authRequired(), { promptSent: false })).toBe('auth');
    });

    await it('reads the hint-wrapped error as the same trap, because withAuthHint replaces it', async () => {
      // This is the case that matters: the controller never sees the raw RpcError, it sees what
      // `withAuthHint` threw. A classifier that only knew the RpcError would call every auth failure
      // in the app a plain start failure, and the dialog would never appear.
      const wrapped = new AuthRequiredError('attaching to the session failed: run `lotse auth`');
      expect(failureKind(wrapped, { promptSent: false })).toBe('auth');
    });

    await it('reads a reattach refusal as its own kind, not as a start failure', async () => {
      // Trap 2: the agent ran and cannot reattach. `AcpClient.reattach` rejects with this class, so the
      // class is the fact — not a message that happens to mention a capability.
      const refused = new UnsupportedCapabilityError('this agent can neither load nor resume', {
        loadSession: false,
        resume: false,
      });
      expect(failureKind(refused, { promptSent: false })).toBe('unsupported');
    });

    await it('reads everything else as a failure to start', async () => {
      expect(failureKind(new Error('spawn opencode ENOENT'), { promptSent: false })).toBe('start');
      expect(failureKind('a string', { promptSent: false })).toBe('start');
      expect(failureKind(undefined, { promptSent: false })).toBe('start');
    });

    await it('does not classify by wording — an agent’s own text cannot claim to be a failure kind', async () => {
      // The whole reason the rule is "match the type": an agent is free to put any words in an error,
      // including the words kurier uses for its own sentences.
      expect(failureKind(new Error('session/load failed: run `lotse auth`'), { promptSent: false })).toBe(
        'start',
      );
      expect(
        failureKind(new Error('this agent can neither load nor resume a session'), { promptSent: false }),
      ).toBe('start');
    });

    await it('keeps the original error reachable on the wrapper', async () => {
      const cause = authRequired();
      expect(new AuthRequiredError('hint', { cause }).cause).toBe(cause);
    });
  });

  // Issue #2: https://github.com/JumpLink/kurier/issues/2 — `opencode/fledge-alpha-free` is geo-blocked
  // from Germany, and opencode answers a provider 403 on `session/prompt` with the *same* -32000 it
  // answers the real login trap with. kurier used to show the auth dialog on that path, naming
  // `lotse auth`, which does not help anybody. What separates them is that a prompt had gone out.
  await describe('failure — the same -32000 after a prompt was sent', async () => {
    await it('is the model, not the login trap, when a prompt has gone out', async () => {
      // The raw `RpcError` first: `session/prompt` is not wrapped by `withAuthHint`, so this is exactly
      // what reaches `failureKind` on the real path.
      expect(failureKind(authRequired(), { promptSent: true })).toBe('model');
    });

    await it('is the model from the hint-wrapped error too, because both arrive with the same shape', async () => {
      const wrapped = new AuthRequiredError(
        'sending the prompt failed: the agent wants a human to log in first',
      );
      expect(failureKind(wrapped, { promptSent: true })).toBe('model');
    });

    await it('leaves the login trap itself alone — an auth error before any prompt is still `auth`', async () => {
      // The other half of the split. If this ever moved, every missing login would offer "choose another
      // model", which fixes nothing: the agent cannot start at all without a login.
      expect(failureKind(authRequired(), { promptSent: false })).toBe('auth');
      expect(
        failureKind(new AuthRequiredError('attaching to the session failed'), { promptSent: false }),
      ).toBe('auth');
    });

    await it('changes nothing for the other two kinds — the turn state is only about auth errors', async () => {
      const refused = new UnsupportedCapabilityError('this agent can neither load nor resume', {
        loadSession: false,
        resume: false,
      });
      expect(failureKind(refused, { promptSent: true })).toBe('unsupported');
      expect(failureKind(new Error('spawn opencode ENOENT'), { promptSent: true })).toBe('start');
      // …including by wording: a message that claims to be about a model buys nothing either.
      expect(failureKind(new Error('the provider refused this model'), { promptSent: true })).toBe('start');
    });
  });

  await describe('failure — what the window says', async () => {
    await it('names `lotse auth` for the auth trap, and offers the login the window can drive', async () => {
      const notice = failureNotice('auth');
      expect(notice).not.toBe(null);
      expect(notice?.command).toBe(AUTH_COMMAND);
      expect(notice?.command).toBe('lotse auth');
      expect(notice?.action).toBe('login');
      expect(failureAction(notice!, { modelChoice: false, login: true })).toBe('login');
      expect(failureAction(notice!, { modelChoice: true, login: false })).toBe(null);
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

    await it('names a provider refusal without blaming one cause, and names both remedies', async () => {
      // The three causes are indistinguishable on this path — a region block, a rate limit and a login
      // that expired mid-turn all arrive as the same `-32000` — so the sentence may not pick one. And
      // `lotse auth` has to stay in it: it is wrong for the case this notice was written for (issue
      // #2) and right for the case that remains, so it is one clause of a sentence rather than the
      // headline.
      const notice = failureNotice('model');
      expect(notice).not.toBe(null);
      expect(notice?.heading).toContain('model');
      expect(notice?.body).toContain('region');
      expect(notice?.body).toContain('rate');
      expect(notice?.body).toContain('login');
      expect(notice?.body).toContain('lotse auth');
      expect(notice?.body).toContain('another model');
    });

    await it('offers no command line for a provider refusal, because its remedy is a button', async () => {
      // `FailureDialog` renders `command` as "Run this in a terminal" — the shape of advice whose only
      // remedy is a command. This notice's remedy is a button this window can press, so a command line
      // would push it aside.
      expect(failureNotice('model')?.command).toBe(null);
    });

    await it('is total over the four kinds, and never returns a command for the three that have none', async () => {
      const kinds = ['auth', 'model', 'unsupported', 'start'] as const;
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
      for (const kind of ['auth', 'model', 'unsupported'] as const) {
        const notice = failureNotice(kind);
        expect(notice?.heading).not.toContain('<');
        expect(notice?.body).not.toContain('<');
      }
    });
  });

  await describe('failure — what the dialog may offer', async () => {
    await it('offers the model choice for a provider refusal, when there is a model dropdown', async () => {
      const notice = failureNotice('model');
      expect(notice).not.toBe(null);
      if (notice) expect(failureAction(notice, { modelChoice: true, login: false })).toBe('choose-model');
    });

    await it('offers nothing for a provider refusal when the agent reported no model option', async () => {
      // The button opens the config row's model dropdown. An agent that reported no model option has
      // none, so the button would open nothing — and a control that points at nothing is the defect
      // this window exists to avoid. The *sentence* is still shown; only the button goes.
      const notice = failureNotice('model');
      expect(notice).not.toBe(null);
      if (notice) expect(failureAction(notice, { modelChoice: false, login: false })).toBe(null);
    });

    await it('offers nothing for the sentences that owe only words', async () => {
      for (const kind of ['unsupported'] as const) {
        const notice = failureNotice(kind);
        expect(notice).not.toBe(null);
        if (notice) {
          expect(notice.action).toBe(null);
          expect(failureAction(notice, { modelChoice: true, login: false })).toBe(null);
        }
      }
      expect(failureNotice('start')).toBe(null);
    });

    await it('is decided by the notice and the state, not by the failure — a dialog cannot grow a button', async () => {
      // Same sentence, two different surfaces: whether the button exists is a fact about the window, so
      // the notice carries the *offer* and `failureAction` carries the *availability*. Nothing here reads
      // a failure kind, which is why the two questions cannot drift apart.
      const notice = failureNotice('model');
      if (!notice) throw new Error('the model notice is missing');
      expect(notice.action).toBe('choose-model');
      expect(failureAction(notice, { modelChoice: true, login: false })).not.toBe(
        failureAction(notice, { modelChoice: false, login: false }),
      );
    });
  });
  await describe('failure — the dialog a window still owes', async () => {
    // The attachment objects are built here rather than produced by a controller, because the rule
    // under test is about *identity* and a surface holding two references to one failure must behave the
    // same whether the controller or a test made it.
    const authFailure = (): AgentAttachment => ({
      status: 'failed',
      kind: 'auth',
      message: 'attaching to the session failed: run `lotse auth`',
    });
    const startFailure = (): AgentAttachment => ({
      status: 'failed',
      kind: 'start',
      message: 'spawn opencode ENOENT',
    });
    /** Issue #2's attachment: the provider refused a turn, so the agent is still there. */
    const modelFailure = (): AgentAttachment => ({
      status: 'failed',
      kind: 'model',
      message: 'Authentication required: provider authentication required',
    });

    await it('owes a dialog the first time it sees a failure', async () => {
      expect(failureToShow(authFailure(), null)?.command).toBe(AUTH_COMMAND);
      expect(failureToShow(startFailure(), null)).toBe(null);
    });

    await it('owes a provider refusal a dialog exactly once, under the same identity rule', async () => {
      // The `'model'` kind is a third kind of `failed`, not a new mechanism: once-per-failure and
      // stale-close are decided by the attachment's identity and have nothing to do with which kind it
      // is. A dialog for a refusal that comes back on every emit is the same defect as the auth one.
      const failure = modelFailure();
      expect(failureToShow(failure, null)?.action).toBe('choose-model');
      expect(failureToShow(failure, failure)).toBe(null);
      expect(failureToShow(failure, failure)).toBe(null);
      // A second refusal is a new object, so it is shown.
      expect(failureToShow(modelFailure(), failure)).not.toBe(null);
      // And a refusal is stale the moment anything else is current — including the agent attaching
      // again, which is what picking another model does.
      expect(staleDialog(failure, { status: 'attached', name: 'OpenCode 2.0.19' })).toBe(true);
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

/**
 * What Ctrl-C means, and what it used to get wrong.
 *
 * The orphan this file's subject fixes was measured on the real bundle: `opencode acp` takes
 * seconds to answer `initialize` from cold, a Ctrl-C inside that window killed lotse with no
 * handler installed, and the agent subprocess stayed running with nothing owning it. So the
 * decision has to be provable without sending signals at a subprocess — which is also the only way
 * to test it on both runtimes, since a real signal test is exactly what produced three confident
 * wrong answers while developing this.
 */

import { describe, expect, it } from '@gjsify/unit';

import { decideInterrupt } from '@lotse/core';

export default async () => {
  await describe('decideInterrupt — nothing of ours is running', async () => {
    await it('ignores a signal when no agent exists', async () => {
      // The one case that must NOT be swallowed: there is no process of ours to end, so pretending
      // to handle it would make an innocent Ctrl-C look like it did something.
      expect(decideInterrupt({ agentRunning: false, turnRunning: false, sessionId: null }).kind).toBe(
        'ignore',
      );
    });

    await it('ignores a signal when no agent exists even if a turn flag is stale', async () => {
      // `turnRunning` is set by the command and cleared in a `finally`; a signal landing between the
      // turn ending and the flag being cleared must not produce a `session/cancel` for a turn that
      // is already over.
      expect(decideInterrupt({ agentRunning: false, turnRunning: true, sessionId: 'ses_1' }).kind).toBe(
        'ignore',
      );
    });
  });

  await describe('decideInterrupt — an agent exists but no turn does', async () => {
    await it('closes, during the handshake and between turns', async () => {
      // The handshake is the case that leaked. `sessionId` is null there because there is no session
      // yet, and a `cancel` would name nothing.
      expect(decideInterrupt({ agentRunning: true, turnRunning: false, sessionId: null }).kind).toBe('close');
    });

    await it('closes even when a session id is known but no turn runs', async () => {
      // `lotse start` with no prompt opens a session and stops. Ctrl-C there should end the
      // process, not send a cancel into a session with nothing running in it.
      expect(decideInterrupt({ agentRunning: true, turnRunning: false, sessionId: 'ses_1' }).kind).toBe(
        'close',
      );
    });
  });

  await describe('decideInterrupt — a turn is running', async () => {
    await it('cancels the named session', async () => {
      const action = decideInterrupt({ agentRunning: true, turnRunning: true, sessionId: 'ses_7' });
      expect(action.kind).toBe('cancel');
      // The session id is only there on a cancel — asserting it separately is what proves the
      // decision carries the name `session/cancel` needs, rather than just the right shape.
      expect(action.kind === 'cancel' ? action.sessionId : null).toBe('ses_7');
    });

    await it('closes rather than cancelling when the session id is missing', async () => {
      // Defensive: `turnRunning` without a session is an inconsistent state, and the safe reading of
      // an inconsistent state is the one that terminates a process, not the one that emits a
      // protocol message naming nothing.
      expect(decideInterrupt({ agentRunning: true, turnRunning: true, sessionId: null }).kind).toBe('close');
    });

    await it('prefers cancel over close — never the other way round', async () => {
      // The ordering IS the content. Closing first would SIGTERM the agent out of the turn it is
      // in the middle of, losing whatever it had not flushed — the exact thing `session/cancel`
      // exists to avoid.
      const action = decideInterrupt({ agentRunning: true, turnRunning: true, sessionId: 'ses_7' });
      expect(action.kind).toBe('cancel');
    });
  });
};

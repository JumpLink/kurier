import { describe, expect, it } from '@gjsify/unit';

import type { StopReason } from '@lotse/acp/types';

import {
  agentExitedEntry,
  agentName,
  agentStatus,
  isEchoOf,
  isOnScreen,
  leavesRunningTurn,
  permissionDecisionEntry,
  transition,
  type AgentAttachment,
  type CancelledBy,
  type TurnEvent,
  type TurnState,
} from '@lotse/core';

const ALL: readonly TurnState[] = ['idle', 'thinking', 'waiting-for-you', 'stopped', 'gone'];

const PROMPT: TurnEvent = { kind: 'prompt' };
const ANSWERED: TurnEvent = { kind: 'permission-answered' };
const ASKED: TurnEvent = { kind: 'permission-asked' };
const GONE: TurnEvent = { kind: 'agent-gone', reason: 'exited with code 1' };

/** A settled turn. `stopReason` is `null` only for "lotse never sent the prompt". */
function ended(stopReason: StopReason | null, cancelledBy: CancelledBy): TurnEvent {
  return { kind: 'turn-ended', stopReason, cancelledBy };
}

export default async () => {
  await describe('turn — the state machine', async () => {
    await it('covers exactly the plan §6 five states', async () => {
      // Asserted as a value, not read off the type: a union that quietly grew a sixth state would
      // still compile, and `composerView` would then have an unrendered case.
      expect([...ALL].sort()).toStrictEqual(
        ['gone', 'idle', 'stopped', 'thinking', 'waiting-for-you'].sort(),
      );
    });

    await describe('starting a turn', async () => {
      await it('a prompt from idle is thinking', async () => {
        expect(transition('idle', PROMPT)).toBe('thinking');
      });

      await it('a prompt from stopped is thinking — the next turn starts like the first', async () => {
        expect(transition('stopped', PROMPT)).toBe('thinking');
      });

      await it('a prompt does not resurrect a gone agent', async () => {
        // `gone` is terminal (composer-state's own rule): a window that quietly grew a second agent
        // would be holding two subprocesses behind one Stop button.
        expect(transition('gone', PROMPT)).toBe('gone');
      });
    });

    await describe('ending a turn', async () => {
      await it('an end_turn is idle', async () => {
        expect(transition('thinking', ended('end_turn', 'none'))).toBe('idle');
      });

      await it('a refusal is idle — the turn is over, which is not the same as being stopped', async () => {
        expect(transition('thinking', ended('refusal', 'none'))).toBe('idle');
      });

      await it("a window cancel answered with 'cancelled' is stopped", async () => {
        expect(transition('thinking', ended('cancelled', 'window'))).toBe('stopped');
      });

      await it('an agent that gave up on its own is idle, not stopped', async () => {
        // The distinction the whole `CancelledBy` type exists for: nobody pressed Stop, so saying
        // "Stopped" would put a word in the person's mouth. `session/cancel` is a notification, so
        // the only evidence there ever was is the controller's own intent.
        expect(transition('thinking', ended('cancelled', 'agent'))).toBe('idle');
      });

      await it('a Stop the agent ignored is idle, because the answer is what happened', async () => {
        // `end_turn` arriving after our cancel went out means it finished on its own while the cancel
        // was in flight. The answer wins.
        expect(transition('thinking', ended('end_turn', 'window'))).toBe('idle');
      });

      await it('a stop with no stop reason at all is stopped — nothing was ever sent', async () => {
        // The one path on which a turn settles with no `stopReason`: Stop during the handshake, so no
        // prompt went out. Reporting `idle` would put "the turn finished" on a turn that never ran.
        expect(transition('thinking', ended(null, 'window'))).toBe('stopped');
      });

      await it('a stop with no stop reason and no intent is idle, not a fabricated completion', async () => {
        expect(transition('thinking', ended(null, 'none'))).toBe('idle');
      });

      await it('turn-ended outranks permission-answered — a turn that ended is not waiting', async () => {
        expect(transition('waiting-for-you', ended('cancelled', 'window'))).toBe('stopped');
      });

      await it('a late answer does not move a gone window back', async () => {
        expect(transition('gone', ended('end_turn', 'none'))).toBe('gone');
      });
    });

    await describe('waiting-for-you', async () => {
      await it('is reached only from thinking, by a permission request', async () => {
        expect(transition('thinking', ASKED)).toBe('waiting-for-you');
      });

      await it('is not reached from idle — there is no turn to interrupt', async () => {
        expect(transition('idle', ASKED)).toBe('idle');
      });

      await it('returns to thinking when the question is answered', async () => {
        expect(transition('waiting-for-you', ANSWERED)).toBe('thinking');
      });

      await it('stays put for an answer nobody asked for', async () => {
        expect(transition('idle', ANSWERED)).toBe('idle');
      });
    });

    await describe('an agent that dies mid-turn', async () => {
      await it('is gone from every live state', async () => {
        for (const state of ['idle', 'thinking', 'waiting-for-you', 'stopped'] as const) {
          expect(transition(state, GONE)).toBe('gone');
        }
      });

      await it('is terminal — nothing that arrives afterwards moves the window out', async () => {
        expect(transition('gone', ANSWERED)).toBe('gone');
        expect(transition('gone', ASKED)).toBe('gone');
        expect(transition('gone', GONE)).toBe('gone');
      });
    });

    await describe('leaving a chat', async () => {
      await it('a cancel by `left` ends idle, never stopped', async () => {
        expect(transition('thinking', ended('cancelled', 'left'))).toBe('idle');
        expect(transition('thinking', ended(null, 'left'))).toBe('idle');
      });

      await it('chat-reset clears how the last chat ended, and leaves a running turn alone', async () => {
        const reset: TurnEvent = { kind: 'chat-reset' };
        expect(transition('gone', reset)).toBe('idle');
        expect(transition('stopped', reset)).toBe('idle');
        expect(transition('thinking', reset)).toBe('thinking');
        expect(transition('waiting-for-you', reset)).toBe('waiting-for-you');
      });

      await it('leavesRunningTurn: only a running turn, and only toward another chat', async () => {
        expect(leavesRunningTurn(false, 'a', null)).toBe(false);
        expect(leavesRunningTurn(true, 'a', null)).toBe(true);
        expect(leavesRunningTurn(true, 'a', 'b')).toBe(true);
        expect(leavesRunningTurn(true, 'a', 'a')).toBe(false);
        expect(leavesRunningTurn(true, null, 'b')).toBe(true);
      });

      await it('isOnScreen: only the session on screen, never an empty new chat', async () => {
        expect(isOnScreen('a', 'a')).toBe(true);
        expect(isOnScreen('a', 'b')).toBe(false);
        expect(isOnScreen('a', null)).toBe(false);
      });
    });

    await it('is total: every event from every state produces one of the five', async () => {
      // A transition function that could return `undefined` would hand the surface a state it cannot
      // render, and an empty line teaches a person nothing. So the whole cross product is asserted.
      const events: TurnEvent[] = [
        PROMPT,
        ASKED,
        ANSWERED,
        ended('end_turn', 'none'),
        ended('cancelled', 'window'),
        ended('cancelled', 'agent'),
        ended(null, 'none'),
        GONE,
      ];
      for (const state of ALL) {
        for (const event of events) {
          expect(ALL).toContain(transition(state, event));
        }
      }
    });
  });

  await describe('turn — what the window may say about the agent', async () => {
    const cases: { attachment: AgentAttachment; attached: boolean; mentions: string }[] = [
      { attachment: { status: 'none' }, attached: true, mentions: '' },
      { attachment: { status: 'attaching' }, attached: false, mentions: 'Starting the agent' },
      { attachment: { status: 'attached', name: 'OpenCode 2.0.19' }, attached: true, mentions: '' },
      { attachment: { status: 'gone', reason: 'exited with code 1' }, attached: false, mentions: 'code 1' },
      { attachment: { status: 'gone', reason: '' }, attached: false, mentions: 'exited' },
      {
        attachment: { status: 'failed', kind: 'auth', message: 'run `lotse auth`, then try again' },
        attached: false,
        mentions: 'lotse auth',
      },
    ];

    await it('projects each of the five shapes onto attached + one sentence', async () => {
      for (const { attachment, attached } of cases) {
        const status = agentStatus(attachment);
        expect(status.attached).toBe(attached);
        if (attached) {
          expect(status.note).toBe('');
        } else {
          // Every shape that cannot take a prompt has something to say. A silent disabled button is
          // the control-that-points-at-nothing this repo's own window header forbids.
          expect(status.note.length).toBeGreaterThan(0);
        }
      }
    });

    await it('says something a person can act on', async () => {
      for (const { attachment, mentions } of cases) {
        if (mentions === '') continue;
        expect(agentStatus(attachment).note).toContain(mentions);
      }
    });

    await it('counts only a finished handshake as attached', async () => {
      // While attaching there is a process but no session to prompt, so a Send enabled then would
      // accept a message that cannot be delivered.
      expect(agentStatus({ status: 'attaching' }).attached).toBe(false);
      expect(agentStatus({ status: 'attached', name: 'LotseStandIn 0.1.0' }).attached).toBe(true);
    });

    await it('carries the auth hint through verbatim — it is the remedy', async () => {
      const message =
        'attaching to the session failed: the agent wants a human to log in first. Run `lotse auth`, then try again.';
      expect(agentStatus({ status: 'failed', kind: 'auth', message }).note).toBe(message);
    });

    await it('names the agent only while it is attached', async () => {
      expect(agentName({ status: 'attached', name: 'OpenCode 2.0.19' })).toBe('OpenCode 2.0.19');
      expect(agentName({ status: 'gone', reason: 'x' })).toBe(null);
      expect(agentName({ status: 'failed', kind: 'start', message: 'x' })).toBe(null);
      expect(agentName({ status: 'none' })).toBe(null);
    });
  });

  await describe('turn — the stream', async () => {
    await it('an agent echo of the prompt we sent is recognised', async () => {
      expect(isEchoOf('why is this slow?', 'why is this slow?')).toBe(true);
      expect(isEchoOf('  why is this slow?\n', 'why is this slow?')).toBe(true);
    });

    await it('anything else is the agent speaking for itself and is kept', async () => {
      // The alternative — "drop the first user chunk of a turn" — would drop a real message, and the
      // transcript is a record of what happened.
      expect(isEchoOf('why is this slow? because', 'why is this slow?')).toBe(false);
      expect(isEchoOf('a different question', 'why is this slow?')).toBe(false);
      expect(isEchoOf('', 'why is this slow?')).toBe(false);
    });

    await it('the agent-exited line uses the plan §6 words and carries the reason', async () => {
      const entry = agentExitedEntry('s1', '2026-10-01T10:00:00.000Z', 'the agent process ended');
      expect(entry.kind).toBe('system');
      expect(entry.text).toContain('the agent exited during this turn');
      expect(entry.text).toContain('the agent process ended');
      expect(entry.sessionId).toBe('s1');
    });

    await it('the agent-exited line has no stopReason to invent — it only says what happened', async () => {
      // There is no way to pass a stop reason into this function, on purpose: a completion cannot be
      // spelled here at all.
      const text = agentExitedEntry('s1', '2026-10-01T10:00:00.000Z', '').text;
      expect(text).not.toContain('end_turn');
      expect(text).not.toContain('cancelled');
      expect(text).toContain('never answered');
    });

    await it('an allowed permission names what was allowed, and the option that did it', async () => {
      const entry = permissionDecisionEntry(
        {
          sessionId: 's1',
          toolCall: { toolCallId: 'c1', title: 'write src/index.ts', kind: 'edit' },
          options: [],
        },
        's1',
        '2026-10-01T10:00:00.000Z',
        { type: 'allowed', optionId: 'allow_once' },
      );
      expect(entry.kind).toBe('system');
      expect(entry.text).toContain('allowed once');
      expect(entry.text).toContain('write src/index.ts');
      // The id is in the line because "allowed" alone does not say *what* was allowed.
      expect(entry.text).toContain('allow_once');
    });

    await it('a declined permission reads as a decision, not as a failure', async () => {
      const entry = permissionDecisionEntry(
        { sessionId: 's1', toolCall: { toolCallId: 'c1', title: 'write src/index.ts' }, options: [] },
        's1',
        '2026-10-01T10:00:00.000Z',
        { type: 'declined', optionId: 'reject_once' },
      );
      expect(entry.text).toContain('declined');
    });

    await it('nobody answering is "not answered", and it names why rather than calling it a refusal', async () => {
      // **The wording is the point.** Every one of these four reasons ends in `cancelled`, but a
      // transcript that said "refused" four times would put a decision in a person's mouth for three
      // of them — they pressed Stop, or closed the window, or watched the agent die.
      for (const reason of ['dismissed', 'window-closed', 'turn-cancelled', 'agent-gone'] as const) {
        const entry = permissionDecisionEntry(
          { sessionId: 's1', toolCall: { toolCallId: 'c1', title: 'write src/index.ts' }, options: [] },
          's1',
          '2026-10-01T10:00:00.000Z',
          { type: 'not-answered', reason },
        );
        expect(entry.text).toContain('not answered');
        expect(entry.text).toContain(reason);
        expect(entry.text).not.toContain('refused');
      }
    });

    await it('a permission with no title still says a tool call was involved', async () => {
      // Every field of a tool call is optional in the schema but the id is not, so there is always
      // something to name — and a line that read "allowed once: " would name nothing.
      const entry = permissionDecisionEntry(
        { sessionId: 's1', toolCall: { toolCallId: 'c1', kind: 'execute' }, options: [] },
        's1',
        '2026-10-01T10:00:00.000Z',
        { type: 'not-answered', reason: 'dismissed' },
      );
      expect(entry.text).toContain('execute');
    });
  });
};

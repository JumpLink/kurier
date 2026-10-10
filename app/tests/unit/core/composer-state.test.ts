import { describe, expect, it } from '@gjsify/unit';

import {
  agentStatus,
  composerView,
  keepsDraft,
  offersStop,
  type AgentAttachment,
  type ComposerInput,
  type TurnState,
} from '@lotse/core';

const ALL: readonly TurnState[] = ['idle', 'thinking', 'waiting-for-you', 'stopped', 'gone'];

const ATTACHED: AgentAttachment = { status: 'attached', name: 'OpenCode 2.0.19' };
const NOTHING: AgentAttachment = { status: 'none' };

/** The inputs of a window that has an agent and a session open — the ordinary case. */
function at(
  state: TurnState,
  attachment: AgentAttachment = ATTACHED,
  sessionId: string | null = 's1',
): ComposerInput {
  return { state, agent: agentStatus(attachment), sessionId };
}

/** The same, through the real projection, so a change in `agentStatus` cannot pass unnoticed. */
function from(state: TurnState, attachment: AgentAttachment, sessionId: string | null = 's1'): ComposerInput {
  return { state, agent: agentStatus(attachment), sessionId };
}

export default async () => {
  await describe('composer-state — the one render decision', async () => {
    await it("covers exactly the plan's five states", async () => {
      // Asserted as a value, not read off the type: a union that grew a sixth state would still compile,
      // and `composerView` would then have a case nothing renders.
      expect([...ALL].sort()).toStrictEqual(
        ['gone', 'idle', 'stopped', 'thinking', 'waiting-for-you'].sort(),
      );
    });

    await describe('with an agent and a session', async () => {
      await it('idle offers a live send and nothing else', async () => {
        const view = composerView(at('idle'));
        expect(view.action).toBe('send');
        expect(view.buttonEnabled).toBe(true);
        expect(view.entryEditable).toBe(true);
        expect(view.reason).toBe('');
        expect(view.status).toBe('');
      });

      await it('stopped offers send again, because the turn is over', async () => {
        const view = composerView(at('stopped'));
        expect(view.action).toBe('send');
        expect(view.buttonEnabled).toBe(true);
      });
    });

    await describe('stop, and where it is not allowed to be', async () => {
      await it('replaces send while the agent works', async () => {
        expect(composerView(at('thinking')).action).toBe('stop');
      });

      await it('stays available while a question is open, so the dialog can be dismissed', async () => {
        // The waiting state is where a person most needs Stop: the turn is not finished and they want
        // it to end. A send button here would be a second prompt behind an unanswered question.
        expect(composerView(at('waiting-for-you')).action).toBe('stop');
        expect(composerView(at('waiting-for-you')).buttonEnabled).toBe(true);
      });

      await it('is offered in no other state', async () => {
        expect(offersStop('idle')).toBe(false);
        expect(offersStop('stopped')).toBe(false);
        expect(offersStop('gone')).toBe(false);
      });

      await it('outranks a missing agent, so a running turn is still cancellable', async () => {
        // The window passes through "turn starting, agent not attached yet" for as long as the
        // handshake takes. A disabled Send there would tell a person with a visible running turn to
        // wait for a button that cannot help.
        const view = composerView(from('thinking', NOTHING, null));
        expect(view.action).toBe('stop');
        expect(view.buttonEnabled).toBe(true);
      });

      await it('outranks a failed agent for the same reason', async () => {
        const view = composerView(
          from('thinking', { status: 'failed', kind: 'start', message: 'no such program' }, null),
        );
        expect(view.action).toBe('stop');
        expect(view.buttonEnabled).toBe(true);
      });
    });

    await describe('the status line — what is happening when nothing is disabled', async () => {
      await it('says a working turn is working', async () => {
        // The difference between a window that looks stuck and a window that is busy, and it is
        // invisible in a screenshot unless it is on screen.
        const view = composerView(at('thinking'));
        expect(view.status.length).toBeGreaterThan(0);
        expect(view.reason).toBe('');
      });

      await it('says a question is open, which is a different thing from working', async () => {
        const status = composerView(at('waiting-for-you')).status;
        expect(status).not.toBe(composerView(at('thinking')).status);
      });

      await it('says a stopped turn was stopped, next to a button that works', async () => {
        expect(composerView(at('stopped')).status.length).toBeGreaterThan(0);
      });

      await it('says nothing when there is nothing happening', async () => {
        expect(composerView(at('idle')).status).toBe('');
      });
    });

    await describe('with no agent started yet', async () => {
      await it('sends, because the first prompt is what starts the agent', async () => {
        // The defect this pins: `none` used to disable Send with a sentence promising that the first
        // prompt starts the agent, so the one message that would have started it could not be sent.
        const view = composerView(from('idle', NOTHING));
        expect(view.action).toBe('send');
        expect(view.buttonEnabled).toBe(true);
        expect(view.reason).toBe('');
      });
    });

    await describe('with a new conversation waiting', async () => {
      await it('sends with no session id, because Send is what creates one', async () => {
        const view = composerView({ ...from('idle', NOTHING, null), startsConversation: true });
        expect(view.buttonEnabled).toBe(true);
        expect(view.reason).toBe('');
      });

      await it('still refuses with no session and nothing waiting', async () => {
        expect(composerView(from('idle', NOTHING, null)).buttonEnabled).toBe(false);
        expect(
          composerView({ ...from('idle', NOTHING, null), startsConversation: false }).buttonEnabled,
        ).toBe(false);
      });

      await it('does not outrank a dead agent', async () => {
        const gone = from('idle', { status: 'gone', reason: 'x' }, null);
        expect(composerView({ ...gone, startsConversation: true }).buttonEnabled).toBe(false);
      });
    });

    await describe('with no agent attached', async () => {
      await it('shows a disabled send that says why', async () => {
        const view = composerView(from('idle', { status: 'gone', reason: 'exited with code 1' }));
        expect(view.action).toBe('send');
        expect(view.buttonEnabled).toBe(false);
        expect(view.reason.length).toBeGreaterThan(0);
      });

      await it('still lets a person type, because the text is kept for when one arrives', async () => {
        // Refusing input into a field that is enabled a second later is the surprise, not the help.
        expect(composerView(from('idle', { status: 'attaching' })).entryEditable).toBe(true);
      });

      await it('says the agent is starting, rather than that it is missing', async () => {
        // The two are different facts: a cold `opencode acp` takes seconds to answer `initialize`, and
        // "no agent is attached" during that is a lie a person can act on.
        const view = composerView(from('idle', { status: 'attaching' }));
        expect(view.buttonEnabled).toBe(false);
        expect(view.reason).toContain('Starting the agent');
      });

      await it('shows the auth remedy verbatim — it is the only useful thing on screen', async () => {
        const message =
          'attaching to the session failed: the agent wants a human to log in first. Run `kurier auth`, then try again.';
        const view = composerView(from('idle', { status: 'failed', kind: 'auth', message }));
        expect(view.buttonEnabled).toBe(false);
        expect(view.reason).toBe(message);
      });

      await it('names why the agent exited, so it is a sentence and not a shrug', async () => {
        const view = composerView(from('gone', { status: 'gone', reason: 'exited with code 1' }));
        expect(view.buttonEnabled).toBe(false);
        // `gone` is a *turn* state, so the composer says the turn's own sentence. The agent's reason is
        // on screen in the transcript line the controller wrote, where it belongs to the conversation.
        expect(view.reason.length).toBeGreaterThan(0);
      });
    });

    await describe('with an agent but no session open', async () => {
      await it('disables send, because there is nowhere to send it', async () => {
        // Step 5 spawns the agent on the first prompt, so before anything is started there is no
        // session. A Send that accepted text would be the control-this-window-forbids.
        const view = composerView(at('idle', ATTACHED, null));
        expect(view.action).toBe('send');
        expect(view.buttonEnabled).toBe(false);
        expect(view.reason.length).toBeGreaterThan(0);
      });

      await it('keeps the reason for tooltips but leaves it off the page, which already says it', async () => {
        const view = composerView(at('idle', ATTACHED, null));
        expect(view.reason.length).toBeGreaterThan(0);
        expect(view.reasonOnPage).toBe(true);
        expect(composerView(at('idle', NOTHING)).reasonOnPage).toBe(undefined);
      });

      await it('lets a person type anyway — the text is kept for when a session is chosen', async () => {
        expect(composerView(at('idle', ATTACHED, null)).entryEditable).toBe(true);
      });
    });

    await describe('after the agent exited', async () => {
      await it('offers nothing, and says the session is over', async () => {
        const view = composerView(at('gone'));
        expect(view.buttonEnabled).toBe(false);
        expect(view.entryEditable).toBe(false);
        expect(view.reason.length).toBeGreaterThan(0);
      });

      await it('offers nothing even though a draft could be typed', async () => {
        expect(composerView(from('gone', NOTHING)).buttonEnabled).toBe(false);
      });
    });

    await describe('the invariants that make the rules mechanical', async () => {
      const attachments: AgentAttachment[] = [
        NOTHING,
        { status: 'attaching' },
        ATTACHED,
        { status: 'gone', reason: 'exited with code 1' },
        { status: 'failed', kind: 'auth', message: 'run `kurier auth`' },
      ];

      await it('a sensitive button never carries a reason, and a disabled one always does', async () => {
        // Otherwise the surface shows an explanation for a button that works, or swallows the reason for
        // one that does not. Asserted over the whole cross product, because that is where a new agent
        // shape would land.
        for (const state of ALL) {
          for (const attachment of attachments) {
            for (const sessionId of ['s1', null]) {
              const view = composerView(from(state, attachment, sessionId));
              if (view.buttonEnabled) expect(view.reason).toBe('');
              else expect(view.reason.length).toBeGreaterThan(0);
            }
          }
        }
      });

      await it('never leaves the entry editable while the agent is gone', async () => {
        for (const attachment of attachments) {
          expect(composerView(from('gone', attachment)).entryEditable).toBe(false);
        }
      });

      await it('never offers both a reason and a status at once — one line, one sentence', async () => {
        // With a dead agent and no session both have something to say, and two sentences under one entry
        // read as two problems when there is one.
        for (const state of ALL) {
          for (const attachment of attachments) {
            for (const sessionId of ['s1', null]) {
              const view = composerView(from(state, attachment, sessionId));
              expect(view.reason === '' || view.status === '').toBe(true);
            }
          }
        }
      });
    });

    await describe('the draft', async () => {
      await it('survives Stop, which is the point of Stop', async () => {
        expect(keepsDraft('thinking')).toBe(true);
        expect(keepsDraft('stopped')).toBe(true);
      });

      await it('survives every state but the exited one', async () => {
        expect(keepsDraft('idle')).toBe(true);
        expect(keepsDraft('waiting-for-you')).toBe(true);
        expect(keepsDraft('gone')).toBe(false);
      });
    });
  });

  await describe('an unavailable agent', async () => {
    await it('turns Send and the entry off and says why, on screen', async () => {
      const view = composerView({ ...at('idle', NOTHING, null), unavailable: 'No agent found.' });
      expect(view.buttonEnabled).toBe(false);
      expect(view.entryEditable).toBe(false);
      expect(view.reason).toBe('No agent found.');
    });

    await it('is not in the way of Stop', async () => {
      const view = composerView({ ...at('thinking'), unavailable: 'No agent found.' });
      expect(view.action).toBe('stop');
      expect(view.buttonEnabled).toBe(true);
    });
  });
};

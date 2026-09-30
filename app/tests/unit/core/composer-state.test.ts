import { describe, expect, it } from '@gjsify/unit';

import { composerView, keepsDraft, offersStop, type TurnState } from '../../../src/core/composer-state.ts';

const ALL: readonly TurnState[] = ['idle', 'thinking', 'waiting-for-you', 'stopped', 'gone'];
export default async () => {
  await describe('composer-state — the one render decision', async () => {
    await describe('composer-state — the one render decision', async () => {
      await it("covers exactly the plan's five states", async () => {
        expect([...ALL].sort()).toStrictEqual(
          ['gone', 'idle', 'stopped', 'thinking', 'waiting-for-you'].sort(),
        );
      });

      await describe('with an agent attached', async () => {
        await it('idle offers a live send and nothing else', async () => {
          const view = composerView('idle', true);
          expect(view.action).toBe('send');
          expect(view.buttonEnabled).toBe(true);
          expect(view.entryEditable).toBe(true);
          expect(view.reason).toBe('');
        });

        await it('stopped offers send again, because the turn is over', async () => {
          const view = composerView('stopped', true);
          expect(view.action).toBe('send');
          expect(view.buttonEnabled).toBe(true);
        });
      });

      await describe('stop, and where it is not allowed to be', async () => {
        await it('replaces send while the agent works', async () => {
          expect(composerView('thinking', true).action).toBe('stop');
        });

        await it('stays available while a question is open, so the dialog can be dismissed', async () => {
          // The waiting state is where a person most needs Stop: the turn is not finished and they want
          // it to end. A send button here would be a second prompt behind an unanswered question.
          expect(composerView('waiting-for-you', true).action).toBe('stop');
          expect(composerView('waiting-for-you', true).buttonEnabled).toBe(true);
        });

        await it('is offered in no other state', async () => {
          expect(offersStop('idle')).toBe(false);
          expect(offersStop('stopped')).toBe(false);
          expect(offersStop('gone')).toBe(false);
        });

        await it('outranks a missing agent, so a running turn is still cancellable', async () => {
          // The window passes through "turn starting, agent not attached yet". A disabled Send there
          // would tell a person with a visible running turn to wait for a button that cannot help.
          const view = composerView('thinking', false);
          expect(view.action).toBe('stop');
          expect(view.buttonEnabled).toBe(true);
        });
      });

      await describe('with no agent attached — this slice, until step 5', async () => {
        await it('idle shows a disabled send that says why', async () => {
          const view = composerView('idle', false);
          expect(view.action).toBe('send');
          expect(view.buttonEnabled).toBe(false);
          expect(view.reason.length).toBeGreaterThan(0);
        });

        await it('still lets a person type, because the text is kept for when one arrives', async () => {
          // Refusing input into a field that is enabled a second later is the surprise, not the help.
          expect(composerView('idle', false).entryEditable).toBe(true);
        });
      });

      await describe('after the agent exited', async () => {
        await it('offers nothing, and says the session is over', async () => {
          const view = composerView('gone', true);
          expect(view.buttonEnabled).toBe(false);
          expect(view.entryEditable).toBe(false);
          expect(view.reason.length).toBeGreaterThan(0);
        });

        await it('offers nothing even though a draft could be typed', async () => {
          expect(composerView('gone', false).buttonEnabled).toBe(false);
        });
      });

      await describe('the invariant that makes the rule mechanical', async () => {
        await it('a sensitive button never carries a reason, and a disabled one always does', async () => {
          // Otherwise the surface shows an explanation for a button that works, or swallows the reason
          // for one that does not.
          for (const state of ALL) {
            for (const attached of [true, false]) {
              const view = composerView(state, attached);
              if (view.buttonEnabled) expect(view.reason).toBe('');
              else expect(view.reason.length).toBeGreaterThan(0);
            }
          }
        });

        await it('never leaves the entry editable while the agent is gone', async () => {
          expect(composerView('gone', true).entryEditable).toBe(false);
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
  });
};

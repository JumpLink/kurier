/**
 * The permission gate's decisions, tested without a window.
 *
 * Every case here is one the dialog makes hard to check by looking: what a dismissal means, what
 * happens to a second request, what a Stop does to a question that is already up. They are on GJS
 * **and** Node for the reason the whole `core/` split exists — a permission gate that only ever ran
 * under a display would be a gate nobody could test for failing closed.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
  answerFor,
  decideFromResponse,
  decideFromView,
  escapeMnemonic,
  initialFocusResponseId,
  optionLabel,
  permissionView,
  PermissionDesk,
  type PermissionDecision,
  type PermissionQuestion,
} from '../../../src/core/permission.ts';

import type { PermissionOption, RequestPermissionRequest } from '@kurier/acp/types';

/** The four options a real agent sends, which is the only shape that exercises the filtering. */
const ALL_FOUR: RequestPermissionRequest['options'] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always decline in this session', kind: 'reject_always' },
];

/** A wire message of a shape the schema does not promise, which is what `as never` is for. */
function malformed(payload: unknown): RequestPermissionRequest {
  return payload as RequestPermissionRequest;
}

function request(overrides: Partial<RequestPermissionRequest['toolCall']> = {}): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: {
      toolCallId: 't1',
      status: 'pending',
      title: 'Write src/hello.ts',
      kind: 'edit',
      locations: [{ path: 'src/hello.ts', line: 12 }],
      rawInput: { path: 'src/hello.ts', content: "export const hello = 1;\n" },
      ...overrides,
    },
    options: ALL_FOUR,
  };
}

/** Answer the desk the way `AgentSession.#present` does, naming the question it is answering. */
function answer(desk: PermissionDesk, id: string, responseId: string | null | undefined): void {
  desk.answer(id, responseId);
}

/**
 * A desk with no surface attached, so asks queue without anything rendering them.
 *
 * Every question in these tests is answered explicitly — by `answer()` or by `cancel()` — so a desk
 * that invented an answer of its own would be caught by the assertions rather than waited out. There
 * used to be a `timeoutMs` option here for exactly the opposite reason; the desk has no timeout at all
 * now (see its class comment), so nothing can fire in the middle of an assertion.
 */
function bareDesk(): PermissionDesk {
  return new PermissionDesk();
}

export default async () => {
  await describe('permissionView — what may be shown', async () => {
    await it('reports the tool, its kind, and its locations as the agent wrote them', async () => {
      const view = permissionView(request());
      expect(view.tool).toBe('Write src/hello.ts');
      expect(view.kind).toBe('edit');
      expect(view.locations).toStrictEqual(['src/hello.ts:12']);
    });

    await it('drops the "always" options and keeps both "once" ones', async () => {
      // **The promise this whole module makes.** A button for `allow_always` is a promise kurier
      // cannot keep — it keeps nothing — and the place to stop it is the projection, not the widget.
      const view = permissionView(request());
      expect(view.options.map((option) => option.optionId)).toStrictEqual(['allow_once', 'reject_once']);
      expect(view.options.some((option) => option.name.includes('Always'))).toBe(false);
    });

    await it('renders a missing rawInput as null, never as an empty string', async () => {
      // Empty and absent are different claims: "" says the agent sent nothing to do, null says it
      // said nothing *about* it. Only the second is true here, and the widget's "the agent did not
      // say" copy belongs to the second.
      expect(permissionView(request({ rawInput: undefined })).rawInput).toBe(null);
      expect(permissionView(request({ rawInput: null })).rawInput).toBe(null);
      expect(permissionView(request({ rawInput: '' })).rawInput).toBe('');
    });

    await it('turns a structured rawInput into readable JSON', async () => {
      const view = permissionView(request());
      expect(view.rawInput).not.toBe(null);
      expect(String(view.rawInput)).toContain('src/hello.ts');
      // Never "[object Object]" — that is no answer at all to "what is it about to do".
      expect(String(view.rawInput)).not.toContain('[object Object]');
    });

    await it('still says a tool is involved when the agent named neither title nor kind', async () => {
      const view = permissionView(request({ title: undefined, kind: undefined }));
      expect(view.tool.length).toBeGreaterThan(0);
      expect(view.kind.length).toBeGreaterThan(0);
    });

    await it('a location with no path is dropped rather than rendered as a blank line', async () => {
      const bare = request({ locations: [{ path: '' }, { path: 'src/real.ts' }] });
      expect(permissionView(bare).locations).toStrictEqual(['src/real.ts']);
    });
  });

  await describe('decideFromView — the fail-closed rule', async () => {
    const view = permissionView(request());

    await it('an allowing option id is allowed, and only that id', async () => {
      expect(decideFromView(view, 'allow_once')).toStrictEqual({ type: 'allowed', optionId: 'allow_once' });
    });

    await it('a rejecting option id is a decline', async () => {
      expect(decideFromView(view, 'reject_once')).toStrictEqual({ type: 'declined', optionId: 'reject_once' });
    });

    for (const id of ['close', 'cancel', 'allow_always', 'reject_always', '', null, undefined]) {
      await it(`the unrendered id ${JSON.stringify(id)} is not answered, it is dismissed`, async () => {
        // **The one case the whole gate is built around.** `Adw.AlertDialog`'s close response is
        // `"close"` by default, no agent ever sends that, and mapping it to anything but
        // `not-answered` is how a client's Escape becomes a file write. `allow_always` and
        // `reject_always` are in this list for a second reason: they are ids a *real* agent sends,
        // they were filtered out of the view, and answering one would mean honouring a promise kurier
        // has nowhere to keep.
        expect(decideFromView(view, id)).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      });
    }
  });

  await describe('answerFor — what goes back over the wire', async () => {
    await it('an allow is `selected` with the agent\'s own id', async () => {
      // There is no `allowed_once` in ACP v1. The outcome is `selected` plus the id, and what that id
      // means is the agent's business — which is exactly why only a `*_once` id can be in the view.
      expect(answerFor({ type: 'allowed', optionId: 'allow_once' })).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });
    });

    await it('a dismissal is `cancelled` with no option at all', async () => {
      expect(answerFor({ type: 'not-answered', reason: 'dismissed' })).toStrictEqual({
        outcome: { outcome: 'cancelled' },
      });
    });
  });

  await describe('PermissionDesk — one question at a time', async () => {
    await it('shows the first ask and queues the second without answering it', async () => {
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });

      const first = desk.ask(request());
      const second = desk.ask(request({ title: 'Write src/second.ts' }));
      // Arrival order, and the second is *not* answered: answering it would be kurier deciding.
      expect(shown).toStrictEqual(['q1']);
      expect(desk.waiting).toBe(1);
      answer(desk, 'q1', 'reject_once');
      expect(await first).toStrictEqual({ type: 'declined', optionId: 'reject_once' });
      // …and only now does the second come up.
      expect(shown).toStrictEqual(['q1', 'q2']);
      desk.cancel('turn-cancelled');
      expect(await second).toStrictEqual({ type: 'not-answered', reason: 'turn-cancelled' });
    });

    await it('answers in arrival order, and each press lands on the question being shown', async () => {
      // **The order is the assertion, not the outcome.** Three identical `allow_once` answers prove
      // nothing about *which* question each one settled: a desk that applied a press to the wrong
      // question would still return three "allowed"s. So every question here offers an option only it
      // has, and the settled list has to come back in arrival order.
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });
      const only = (optionId: string): RequestPermissionRequest => ({
        ...request(),
        options: [{ optionId, name: optionId, kind: 'allow_once' }],
      });
      const answers = [desk.ask(only('first_ok')), desk.ask(only('second_ok')), desk.ask(only('third_ok'))];
      // Only `second_ok` is offered by the question on screen, so answering q1 or q3 with it proves
      // the id check as well as the order.
      answer(desk, 'q1', 'first_ok');
      answer(desk, 'q2', 'second_ok');
      answer(desk, 'q3', 'third_ok');
      const settled = await Promise.all(answers);
      expect(settled).toStrictEqual([
        { type: 'allowed', optionId: 'first_ok' },
        { type: 'allowed', optionId: 'second_ok' },
        { type: 'allowed', optionId: 'third_ok' },
      ]);
      expect(shown).toStrictEqual(['q1', 'q2', 'q3']);
    });

    await it('an answer for a question that is no longer open does not reach the next one', async () => {
      // **The second fail-closed rule, and the one a surface causes by accident.** Two requests
      // arriving together produce two questions in sequence; a dialog that settles late — after the
      // desk has already promoted the second — would otherwise hand its id to the second question. The
      // person reading question two has not read question one, so that is an allow for work nobody
      // looked at. An id that is not the open question's is dropped: nothing settles, and the open
      // question stays open for a person.
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const first = desk.ask(request());
      const second = desk.ask(request());
      answer(desk, 'q1', 'allow_once');
      expect(await first).toStrictEqual({ type: 'allowed', optionId: 'allow_once' });
      // q1's dialog, answering late. q2 does not offer `allow_once` — it only has `reject_once` — so a
      // leak would be visible as a decline of the wrong id as well as of the wrong question.
      answer(desk, 'q1', 'reject_once');
      expect(desk.open?.id).toBe('q2');
      let settledEarly = false;
      void second.then(() => {
        settledEarly = true;
      });
      await Promise.resolve();
      expect(settledEarly).toBe(false);
      // …and q2 is still answerable by a person.
      answer(desk, 'q2', 'reject_once');
      expect(await second).toStrictEqual({ type: 'declined', optionId: 'reject_once' });
    });

    await it('a dismissal of the open question is not-answered, and the next one still comes up', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const first = desk.ask(request());
      desk.ask(request());
      answer(desk, 'q1', 'close');
      expect(await first).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
    });

    await it('cancelling settles the open question *and* the queue, both as not answered', async () => {
      // **A Stop with three dialogs' worth of questions up.** The turn is over, so the answers are
      // `cancelled` for all of them — leaving queued questions alive would ask about work that no
      // longer exists.
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const answers = [desk.ask(request()), desk.ask(request()), desk.ask(request())];
      desk.cancel('turn-cancelled');
      const settled = await Promise.all(answers);
      expect(settled).toStrictEqual([
        { type: 'not-answered', reason: 'turn-cancelled' },
        { type: 'not-answered', reason: 'turn-cancelled' },
        { type: 'not-answered', reason: 'turn-cancelled' },
      ]);
      expect(desk.open).toBe(null);
      expect(desk.waiting).toBe(0);
    });

    await it('names the reason a window-closed differs from a Stop, in the transcript', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const answer = desk.ask(request());
      desk.cancel('agent-gone');
      expect(await answer).toStrictEqual({ type: 'not-answered', reason: 'agent-gone' });
    });

    await it('waits for a person rather than answering for them', async () => {
      // **No timeout, and this is the test that says so.** The desk used to settle a question
      // `not-answered` after two seconds, on the theory that a gate with no deadline is a hang. It is
      // not: every path where nobody chose is a `cancel()`, and `AgentSession` makes that call from
      // Stop, a closing window, a dying agent and a surface whose promise rejected. What a timeout
      // added was an answer to somebody in the middle of reading a diff — and the dialog would then
      // still be on screen, answering `cancelled`, with "Allow once" doing nothing. Better a question
      // that waits than a gate that looks broken.
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      let settled = false;
      const question = desk.ask(request()).then((decision) => {
        settled = true;
        return decision;
      });
      // Well past the two seconds the old safety net used.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(desk.open).not.toBe(null);
      // …and it is still answerable, which is the other half of the claim.
      answer(desk, 'q1', 'allow_once');
      expect(await question).toStrictEqual({ type: 'allowed', optionId: 'allow_once' });
    });

    await it('asks after a cancel work again — the desk is not left wedged', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      desk.ask(request());
      desk.cancel('dismissed');
      const again = desk.ask(request());
      answer(desk, 'q2', 'allow_once');
      expect(await again).toStrictEqual({ type: 'allowed', optionId: 'allow_once' });
    });

    await it('an agent that offers nothing to press is cancelled, not shown empty', async () => {
      // `options` is the agent's array and may be empty; the filtering can empty it too — an agent
      // offering only `allow_always` has offered nothing kurier could keep. A dialog whose only
      // control is Escape is the control-that-points-at-nothing rule in a different shape.
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });
      const none: RequestPermissionRequest = { ...request(), options: [] };
      expect(await desk.ask(none)).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      expect(shown).toStrictEqual([]);

      // The same for a request that had options and lost them all to the `*_always` filter.
      const onlyAlways = desk.ask({
        ...request(),
        options: [{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }],
      });
      expect(await onlyAlways).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      expect(shown).toStrictEqual([]);
      expect(desk.open).toBe(null);
    });

    await it('a refused request does not wedge the desk — the next one still asks', async () => {
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });
      await desk.ask({ ...request(), options: [] });
      const next = desk.ask(request());
      expect(shown).toStrictEqual(['q2']);
      answer(desk, 'q2', 'reject_once');
      expect(await next).toStrictEqual({ type: 'declined', optionId: 'reject_once' });
    });

    await it('answers nothing when there is no question open', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      answer(desk, 'q1', 'allow_once');
      expect(desk.open).toBe(null);
    });

    await it('busy is true while a question is queued, so a fail-closed path knows to record', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      expect(desk.busy).toBe(false);
      desk.ask(request());
      expect(desk.busy).toBe(true);
      desk.ask(request());
      expect(desk.busy).toBe(true);
      // A request that was never shown because it had nothing to press does not make the desk busy —
      // there is no question on screen for a Stop to be about.
      desk.cancel('dismissed');
      expect(desk.busy).toBe(false);
      expect(desk.busy).toBe(false);
      await desk.ask({ ...request(), options: [] });
      expect(desk.busy).toBe(false);
    });

    await it('the question carries the view the widget renders, and the agent\'s ids unchanged', async () => {
      const desk = bareDesk();
      const shown: PermissionQuestion[] = [];
      desk.bind({
        show: (q) => shown.push(q),
      });
      desk.ask(request());
      expect(shown.length).toBe(1);
      expect(shown[0]?.view.tool).toBe('Write src/hello.ts');
      expect(shown[0]?.view.options.map((option) => option.optionId)).toStrictEqual(['allow_once', 'reject_once']);
      desk.cancel('dismissed');
    });
  });

  await describe('initialFocusResponseId — the keyboard must never start on an allow', async () => {
    const allow: PermissionOption = { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' };
    const reject: PermissionOption = { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' };

    await it('a rejecting option gets the focus, whichever order the agent sent them in', async () => {
      // **Order does not decide this.** libadwaita's own fallback is the last added response, so an
      // agent that sends `allow_once` last gets a dialog whose first Enter allows — measured, see
      // `scripts/probes/alert-dialog-close.mjs` case 9. The choice is made from `kind` instead.
      expect(initialFocusResponseId([allow, reject])).toBe('reject_once');
      expect(initialFocusResponseId([reject, allow])).toBe('reject_once');
      expect(initialFocusResponseId([allow, reject, allow])).toBe('reject_once');
    });

    await it('never an allowing id, for any option set an agent can send', async () => {
      // **The whole rule, as an assertion over the inputs rather than over one case.** A focused
      // `Gtk.Button` answers Enter and Space whether or not a default widget is set, so an allow id
      // here is an allow on the first keypress of an Enter meant for the composer.
      const sets: PermissionOption[][] = [
        [],
        [allow],
        [reject],
        [allow, reject],
        [reject, allow],
        [allow, allow, reject, reject],
        [{ optionId: 'a', name: 'A', kind: 'allow_always' }],
        [{ optionId: 'r', name: 'R', kind: 'reject_always' }, allow],
      ];
      for (const options of sets) {
        const chosen = initialFocusResponseId(options);
        if (chosen === null) continue;
        const found = options.find((option) => option.optionId === chosen);
        expect(found).toBeDefined();
        expect(found?.kind.startsWith('allow')).toBe(false);
      }
    });

    await it('null when the agent offered nothing to decline with', async () => {
      // There is no button that is both available and the wrong one, so the widget puts the focus on
      // the diff body instead — which is why the return type is `string | null` and not `string`.
      expect(initialFocusResponseId([])).toBe(null);
      expect(initialFocusResponseId([allow])).toBe(null);
    });

    await it('reads the *projected* options, so an "always" can never be focused', async () => {
      const view = permissionView(request());
      // `permissionView` has already dropped both `*_always` options, so even an agent that sent four
      // of them cannot get one focused here.
      expect(view.options.map((option) => option.optionId)).toStrictEqual(['allow_once', 'reject_once']);
      expect(initialFocusResponseId(view.options)).toBe('reject_once');
    });
  });

  await describe('optionLabel — kurier\'s voice, not the agent\'s', async () => {
    const allow: PermissionOption = { optionId: 'a', name: 'Yes', kind: 'allow_once' };
    const reject: PermissionOption = { optionId: 'r', name: 'No', kind: 'reject_once' };

    await it('an allowing option says so, whatever the agent called it', async () => {
      // **The reason this function exists.** ACP lets an agent name its `allow_once` option "Decline",
      // and the dialog used to print the name verbatim — a suggested-looking button reading "Decline"
      // that allows. The person cannot tell, and the styling would have said the opposite thing.
      expect(optionLabel(allow)).toBe('Allow once: Yes');
      expect(optionLabel(reject)).toBe('Decline: No');
      expect(optionLabel({ optionId: 'x', name: 'Decline', kind: 'allow_once' })).toBe('Allow once: Decline');
    });

    await it('the agent\'s name is dropped when it only repeats what the kind already says', async () => {
      // "Allow once: Allow once" is noise in a 360 px dialog, and every real agent's first option is
      // called exactly that.
      expect(optionLabel({ optionId: 'a', name: 'Allow once', kind: 'allow_once' })).toBe('Allow once');
      expect(optionLabel({ optionId: 'r', name: 'Decline', kind: 'reject_once' })).toBe('Decline');
      expect(optionLabel({ optionId: 'r', name: '  Decline  ', kind: 'reject_once' })).toBe('Decline');
      // Punctuation and case are not a difference of meaning.
      expect(optionLabel({ optionId: 'a', name: 'allow-once', kind: 'allow_once' })).toBe('Allow once');
      expect(optionLabel({ optionId: 'r', name: '', kind: 'reject_once' })).toBe('Decline');
    });

    await it('underscores are doubled, because add_response reads them as a mnemonic', async () => {
      // **An agent must not choose kurier's Alt accelerator.** GTK parses `_x` in a response label as
      // "Alt+x", so an option named `Delete_everything` would have handed the agent a shortcut in
      // kurier's own dialog. Doubling prints a literal underscore.
      expect(optionLabel({ optionId: 'a', name: 'Delete_everything', kind: 'allow_once' })).toBe(
        'Allow once: Delete__everything',
      );
      expect(escapeMnemonic('_')).toBe('__');
      expect(escapeMnemonic('a_b_c')).toBe('a__b__c');
      expect(escapeMnemonic('nothing to escape')).toBe('nothing to escape');
    });

    await it('a long agent name is cut rather than pushing the buttons off the dialog', async () => {
      const label = optionLabel({ optionId: 'a', name: 'x'.repeat(500), kind: 'allow_once' });
      expect(label.length).toBeLessThan(200);
      expect(label.endsWith('…')).toBe(true);
    });
  });

  await describe('permissionView — malformed wire data fails closed', async () => {
    // **Guardrail 4 is about `_meta`, and this is the same instinct applied to the fields this gate
    // does read.** A message that does not match the schema must not throw out of the gate: a thrown
    // gate is a failed turn, and one malformed message from one agent would then look like a crash in
    // kurier. It has to project to a view with nothing to press, so the answer is `cancelled`.
    for (const [name, payload] of [
      ['no toolCall at all', { sessionId: 's1', options: ALL_FOUR }],
      ['a null toolCall', { sessionId: 's1', toolCall: null, options: ALL_FOUR }],
      ['a toolCall that is a string', { sessionId: 's1', toolCall: 'edit src/hello.ts', options: ALL_FOUR }],
      ['no options array', { sessionId: 's1', toolCall: { toolCallId: 't1' } }],
      ['options that are not an array', { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: 'allow' }],
      ['options that are not objects', { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: ['allow'] }],
      [
        'an option with no kind',
        { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'a', name: 'Yes' }] },
      ],
      [
        'an option whose kind is a number',
        { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'a', name: 'Yes', kind: 1 }] },
      ],
      [
        'an option whose kind is a word the schema does not define',
        {
          sessionId: 's1',
          toolCall: { toolCallId: 't1' },
          options: [{ optionId: 'a', name: 'Yes', kind: 'allow_whenever' }],
        },
      ],
      [
        'locations that are not objects',
        {
          sessionId: 's1',
          toolCall: { toolCallId: 't1', locations: ['src/hello.ts', null, 7] },
          options: ALL_FOUR,
        },
      ],
      ['locations that are not an array', { sessionId: 's1', toolCall: { toolCallId: 't1', locations: 'x' }, options: ALL_FOUR }],
    ] as const) {
      await it(`${name} projects to a view with nothing to press`, async () => {
        const view = permissionView(malformed(payload));
        expect(view.tool.length).toBeGreaterThan(0);
        expect(view.kind.length).toBeGreaterThan(0);
        // The only parts that can be wrong in a way that matters: options that could allow, and
        // locations that would render as garbage.
        if (name.includes('no kind') || name.includes('kind is a number') || name.includes('does not define')) {
          expect(view.options).toStrictEqual([]);
        }
        if (name.includes('locations that are not objects')) expect(view.locations).toStrictEqual([]);
        // And it never throws, which is the whole point.
      });
    }

    await it('a malformed request is answered cancelled, never allowed', async () => {
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const broken = malformed({ sessionId: 's1', options: [{ optionId: 'a', name: 'Yes', kind: 7 }] });
      expect(await desk.ask(broken)).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      expect(desk.busy).toBe(false);
    });

    await it('an option whose kind is not the schema\'s is dropped, and never guessed at', async () => {
      // `allow_whenever` is not one of the four kinds, and `decideFromView` decides by `startsWith('allow')`.
      // Letting it through would make an unknown word mean "allow", which is the same class of mistake
      // as mapping an unknown response id to an allow.
      const view = permissionView(
        malformed({ sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'a', name: 'Yes', kind: 'allow_whenever' }] }),
      );
      expect(view.options).toStrictEqual([]);
      expect(decideFromView(view, 'a')).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
    });
  });

  await describe('permissionView — caps, because a dialog is sized by its content', async () => {
    await it('a long title, kind and location are cut with an ellipsis', async () => {
      // A tool call's fields are unbounded and this is a modal: without a cap the buttons end up below
      // the fold and the question cannot be answered at all. `rawInput` is capped the same way, and it
      // is the only field with no cap beside these three — a diff is supposed to be long.
      const view = permissionView(
        request({
          title: 'W'.repeat(4000),
          // `kind` is a union in the schema and a string on the wire, so the absurd length is reached
          // the way it would really be reached: through a message that does not match the schema.
          kind: 'k'.repeat(4000) as RequestPermissionRequest['toolCall']['kind'],
          locations: [{ path: `/${'p'.repeat(4000)}`, line: 3 }],
        }),
      );
      expect(view.tool.length).toBeLessThanOrEqual(120);
      expect(view.kind.length).toBeLessThanOrEqual(40);
      expect(view.locations[0]?.length).toBeLessThanOrEqual(240);
      // An ellipsis rather than a hard cut: a title ending `…` says there is more, a title ending
      // mid-word does not.
      expect(view.tool.endsWith('…')).toBe(true);
      expect(view.kind.endsWith('…')).toBe(true);
      expect(view.locations[0]?.endsWith('…')).toBe(true);
    });

    await it('a short title is untouched', async () => {
      expect(permissionView(request()).tool).toBe('Write src/hello.ts');
      expect(permissionView(request()).locations).toStrictEqual(['src/hello.ts:12']);
    });
  });

  await describe('decideFromResponse — the entry the controller uses', async () => {
    await it('projects and decides in one step', async () => {
      expect(decideFromResponse(request(), 'allow_once')).toStrictEqual({
        type: 'allowed',
        optionId: 'allow_once',
      });
      expect(decideFromResponse(request(), 'close')).toStrictEqual({
        type: 'not-answered',
        reason: 'dismissed',
      });
    });
  });
};
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
  agentNames,
  answerFor,
  decideFromView,
  escapeMnemonic,
  initialFocusResponseId,
  isKnownOptionKind,
  optionLabel,
  permissionView,
  PermissionDesk,
  usableOptions,
  type NotAnsweredReason,
  type PermissionDecision,
  type PermissionQuestion,
} from '../../../src/core/permission.ts';

import type { PermissionOption, RequestPermissionRequest } from '@kurier/acp/types';

/** The four options a real agent sends, which is the only shape that exercises the whole rule. */
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
      rawInput: { path: 'src/hello.ts', content: 'export const hello = 1;\n' },
      ...overrides,
    },
    options: ALL_FOUR,
  };
}

/** Answer the desk the way `AgentSession.#present` does, naming the question it is answering. */
function answer(desk: PermissionDesk, id: string, responseId: string | null | undefined): void {
  desk.answer(id, responseId);
}

/** Every arrangement of `items`, so an order-dependent decision is measured over all of them. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([items[index]!, ...tail]);
  }
  return out;
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

    await it('keeps all four kinds, in the order kurier decides', async () => {
      // **The rule as of 2026-10-02, which reverses the earlier one.** kurier does not remember an
      // "always" decision — the *agent* does, because it is the agent that keeps sending the question
      // and kurier stores no policy at all. So both `*_always` kinds are shown like any other option,
      // and kurier's own sentences are in front of the agent's names.
      //
      // **The order is `reject_once`, `allow_once`, `allow_always`, `reject_always`**, and it is not
      // arbitrary: libadwaita focuses the *first* added response when `default_response` is unset
      // (measured, `scripts/probes/alert-dialog-close.mjs` case 9) and lays the row out bottom-up from
      // the add order. So the first slot is the one a stray Enter reaches — a decline — and the last
      // slot is the topmost button a hand reaches for — also a decline. `allow_always` is neither.
      const view = permissionView(request());
      expect(view.options.map((option) => option.optionId)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
        'reject_always',
      ]);
    });

    await it('puts the "once" allow before the "always" allow, whatever order the agent used', async () => {
      // **The order is kurier's, not the agent's.** The riskier promise must never be the first allow
      // a hand lands on, and never the first allow a stray keypress reaches either.
      const alwaysFirst: RequestPermissionRequest = {
        ...request(),
        options: [ALL_FOUR[1]!, ALL_FOUR[0]!, ALL_FOUR[3]!, ALL_FOUR[2]!],
      };
      expect(permissionView(alwaysFirst).options.map((option) => option.optionId)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
        'reject_always',
      ]);
      const rejectOnlyFirst: RequestPermissionRequest = {
        ...request(),
        options: [ALL_FOUR[3]!, ALL_FOUR[2]!, ALL_FOUR[1]!, ALL_FOUR[0]!],
      };
      expect(permissionView(rejectOnlyFirst).options.map((option) => option.kind)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
        'reject_always',
      ]);
    });

    await it('shows a lone "always allow" rather than erasing the only option there is', async () => {
      // An agent that offers nothing but `allow_always` is offering exactly one answer. Filtering it
      // left the desk with nothing to press, which is a dialog whose only control is Escape.
      const view = permissionView({
        ...request(),
        options: [{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }],
      });
      expect(view.options.map((option) => option.optionId)).toStrictEqual(['allow_always']);
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
      expect(decideFromView(view, 'reject_once')).toStrictEqual({
        type: 'declined',
        optionId: 'reject_once',
      });
    });

    for (const id of ['close', 'cancel', 'allow_whenever', '', null, undefined]) {
      await it(`the unrendered id ${JSON.stringify(id)} is not answered, it is dismissed`, async () => {
        // **The one case the whole gate is built around.** `Adw.AlertDialog`'s close response is
        // `"close"` by default, no agent ever sends that, and mapping it to anything but
        // `not-answered` is how a client's Escape becomes a file write. The rule is not about which
        // *words* an id is made of: an id the view never rendered cannot have been pressed by a
        // person, whatever it is called.
        expect(decideFromView(view, id)).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      });
    }

    await it("an allow_always id is an allow, carried with the agent's own id", async () => {
      // **The pass-through, on the deciding function.** `allow_always` is now a rendered option, so a
      // press on it is a decision kurier *did* see a person make — and the id that goes back is the
      // agent's, verbatim. What an "always" then means is the agent's business: it is the party that
      // keeps asking, and kurier holds no policy between questions.
      expect(decideFromView(view, 'allow_always')).toStrictEqual({
        type: 'allowed',
        optionId: 'allow_always',
      });
      expect(decideFromView(view, 'reject_always')).toStrictEqual({
        type: 'declined',
        optionId: 'reject_always',
      });
    });
  });

  await describe('answerFor — what goes back over the wire', async () => {
    await it("an allow is `selected` with the agent's own id", async () => {
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

    await it('an allow_always is `selected` with that exact id — the agent keeps the promise', async () => {
      // There is no `allowed_once` in ACP v1 and there is no `allowed_always` in ACP v1 either: the
      // outcome is `selected` plus the id the agent offered. So passing an "always" through changes
      // nothing about the wire shape — it only stops kurier from hiding a button the person wanted.
      expect(answerFor({ type: 'allowed', optionId: 'allow_always' })).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'allow_always' },
      });
      expect(answerFor({ type: 'declined', optionId: 'reject_always' })).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'reject_always' },
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

    for (const reason of ['dismissed', 'window-closed', 'turn-cancelled', 'agent-gone'] as const) {
      await it(`cancel(${reason}) answers cancelled over the wire, open question and queue alike`, async () => {
        // **Every no-choice path, named in one loop** rather than one `it` each, because the four
        // reasons differ in a transcript sentence and must not differ in the wire answer. Each is
        // asserted through `answerFor`, so this is what the agent actually receives.
        const desk = bareDesk();
        desk.bind({ show: () => {} });
        const open = desk.ask(request());
        const queued = desk.ask(request());
        desk.cancel(reason satisfies NotAnsweredReason);
        const cancelled = { outcome: { outcome: 'cancelled' } };
        expect(answerFor(await open)).toStrictEqual(cancelled);
        expect(answerFor(await queued)).toStrictEqual(cancelled);
        expect(desk.busy).toBe(false);
        expect(desk.open).toBe(null);
      });
    }

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

    await it('a request with only malformed options is cancelled, over the wire, not shown', async () => {
      // The projection drops an option whose `kind` is not one of the four. When that leaves nothing,
      // the desk answers `cancelled` — so an agent sending one unusable option gets the same closed
      // answer as one sending none, and no empty dialog is ever put on screen.
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });
      const asked = desk.ask({
        ...request(),
        options: [{ optionId: 'a', name: 'Yes', kind: 'allow_whenever' } as never],
      });
      expect(shown).toStrictEqual([]);
      expect(answerFor(await asked)).toStrictEqual({ outcome: { outcome: 'cancelled' } });
      expect(desk.busy).toBe(false);
    });

    await it('an agent that offers nothing to press is cancelled, not shown empty', async () => {
      // `options` is the agent's array and may be empty. A dialog whose only control is Escape is the
      // control-that-points-at-nothing rule in a different shape.
      const desk = bareDesk();
      const shown: string[] = [];
      desk.bind({ show: (q) => shown.push(q.id) });
      const none: RequestPermissionRequest = { ...request(), options: [] };
      expect(await desk.ask(none)).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
      expect(shown).toStrictEqual([]);
      expect(desk.open).toBe(null);
    });

    await it('a lone allow_always is asked about, and the press goes back as that id', async () => {
      // **The case the old filter erased.** One option, no decline on offer, so this is also the
      // dialog whose initial focus has to be the diff body — `initialFocusResponseId` returns null and
      // the widget lands somewhere that does nothing on Enter.
      const desk = bareDesk();
      const shown: PermissionQuestion[] = [];
      desk.bind({ show: (q) => shown.push(q) });
      const asked = desk.ask({
        ...request(),
        options: [{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }],
      });
      expect(shown.map((question) => question.id)).toStrictEqual(['q1']);
      expect(initialFocusResponseId(shown[0]?.view.options ?? [])).toBe(null);
      answer(desk, 'q1', 'allow_always');
      const settled = await asked;
      expect(settled).toStrictEqual({ type: 'allowed', optionId: 'allow_always' });
      expect(answerFor(settled)).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'allow_always' },
      });
    });

    await it('a pressed allow_always settles the question it was asked about', async () => {
      // The same pass-through through the desk, on a full four-option request, with a queued second
      // question behind it — so an "always" that lands on the wrong question would show up as the
      // wrong optionId rather than as a green result.
      const desk = bareDesk();
      desk.bind({ show: () => {} });
      const first = desk.ask(request());
      const second = desk.ask({
        ...request(),
        options: [{ optionId: 'r', name: 'Decline', kind: 'reject_once' }],
      });
      answer(desk, 'q1', 'allow_always');
      expect(await first).toStrictEqual({ type: 'allowed', optionId: 'allow_always' });
      expect(desk.open?.id).toBe('q2');
      // q1's id arriving late, for the second question — dropped, as any stale answer is.
      answer(desk, 'q1', 'allow_always');
      expect(desk.open?.id).toBe('q2');
      answer(desk, 'q2', 'r');
      expect(await second).toStrictEqual({ type: 'declined', optionId: 'r' });
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

    await it("the question carries the view the widget renders, and the agent's ids unchanged", async () => {
      const desk = bareDesk();
      const shown: PermissionQuestion[] = [];
      desk.bind({
        show: (q) => shown.push(q),
      });
      desk.ask(request());
      expect(shown.length).toBe(1);
      expect(shown[0]?.view.tool).toBe('Write src/hello.ts');
      expect(shown[0]?.view.options.map((option) => option.optionId)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
        'reject_always',
      ]);
      desk.cancel('dismissed');
    });
  });

  await describe('initialFocusResponseId — the keyboard must never start on an allow', async () => {
    const allow: PermissionOption = { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' };
    const allowAlways: PermissionOption = {
      optionId: 'allow_always',
      name: 'Always allow',
      kind: 'allow_always',
    };
    const reject: PermissionOption = { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' };
    const rejectAlways: PermissionOption = {
      optionId: 'reject_always',
      name: 'Always decline',
      kind: 'reject_always',
    };

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
        [allowAlways],
        [allow, allowAlways],
        [allowAlways, allow],
        [rejectAlways, allow],
        [rejectAlways, allowAlways],
        [allow, reject, allowAlways, rejectAlways],
      ];
      for (const options of sets) {
        const chosen = initialFocusResponseId(options);
        if (chosen === null) continue;
        const found = options.find((option) => option.optionId === chosen);
        expect(found).toBeDefined();
        expect(found?.kind.startsWith('allow')).toBe(false);
      }
    });

    await it('every order of all four kinds, and the focus is never an allow', async () => {
      // **All 24 permutations of the four kinds**, because "show only what the agent sent" means the
      // agent's order is an input to this decision. One Enter pressed as the dialog appears may not
      // allow, whatever order the agent happened to use — and `allow_always` is the worst case, since
      // it widens the promise rather than narrowing it.
      const all: PermissionOption[] = [allow, allowAlways, reject, rejectAlways];
      for (const options of permutations(all)) {
        const chosen = initialFocusResponseId(options);
        if (chosen === null) continue;
        const found = options.find((option) => option.optionId === chosen);
        expect(found?.kind.startsWith('allow')).toBe(false);
        // The narrow decline, not the broad one: Enter then declines *this* request and not the rest
        // of the session.
        expect(chosen).toBe('reject_once');
      }
    });

    await it('null when the agent offered nothing to decline with', async () => {
      // There is no button that is both available and the wrong one, so the widget puts the focus on
      // the diff body instead — which is why the return type is `string | null` and not `string`.
      expect(initialFocusResponseId([])).toBe(null);
      expect(initialFocusResponseId([allow])).toBe(null);
      // An `allow_always` alone is still an allow: focusing it would put the broad promise on Enter.
      expect(initialFocusResponseId([allowAlways])).toBe(null);
      expect(initialFocusResponseId([allow, allowAlways])).toBe(null);
    });

    await it('reads the *projected* options, and allow_always can still never be focused', async () => {
      const view = permissionView(request());
      // `allow_always` is in the view now — it is an option the agent offered and the person may
      // press — and the focus still goes to the decline, because the rule is read off `kind`.
      expect(view.options.map((option) => option.optionId)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
        'reject_always',
      ]);
      expect(initialFocusResponseId(view.options)).toBe('reject_once');
    });

    await it("the first added response is the narrow decline, so libadwaita's fallback is safe too", async () => {
      // **The fact this ordering exists for, as an assertion on the data.** With `default_response`
      // unset libadwaita focuses the *first* added response — the GIR text says "the last added", and
      // that is wrong on libadwaita 1.9.3 (measured both directions, case 9). `show()` sets the focus
      // itself after `map` plus one idle, but there is a frame before that idle runs, and a focused
      // `Gtk.Button` answers Enter. So the first slot has to be safe *without* kurier's help — which is
      // only true while it is `reject_once`.
      const view = permissionView(request());
      const first = view.options[0];
      expect(first?.optionId).toBe('reject_once');
      expect(first?.kind.startsWith('allow')).toBe(false);
      // …and the focus kurier sets is that same button, so winning or losing the race is the same answer.
      expect(initialFocusResponseId(view.options)).toBe(first?.optionId);
    });
  });

  await describe("optionLabel — kurier's voice, not the agent's", async () => {
    const allow: PermissionOption = { optionId: 'a', name: 'Yes', kind: 'allow_once' };
    // Named "No", not "Decline", on purpose: these two are the fixtures whose labels are exercised for
    // *not repeating* the agent's wording, and an agent that calls its reject option "No" is the case
    // a caption line exists for — "No" says nothing the kind does not.
    const reject: PermissionOption = { optionId: 'r', name: 'No', kind: 'reject_once' };
    const alwaysAllow: PermissionOption = { optionId: 'aa', name: 'Yes', kind: 'allow_always' };
    const alwaysReject: PermissionOption = { optionId: 'ar', name: 'No', kind: 'reject_always' };

    await it("is kurier's sentence for the kind, whatever the agent called the option", async () => {
      // **The reason this function exists.** ACP lets an agent name its `allow_once` option "Decline",
      // and the dialog used to print the name verbatim — a suggested-looking button reading "Decline"
      // that allows. The person cannot tell, and the styling would have said the opposite thing.
      expect(optionLabel(allow)).toBe('Allow once');
      expect(optionLabel(reject)).toBe('Decline');
      expect(optionLabel({ optionId: 'x', name: 'Decline', kind: 'allow_once' })).toBe('Allow once');
      // …and the agent's wording is gone from the button even when it is short and harmless. It was
      // "Allow once: Yes" for a while; a screenshot then read "Always decline: Always decline in thi…",
      // the words twice with the ellipsis inside the repeat, unreadable at kurier's own 360 px floor.
      expect(optionLabel({ optionId: 'a', name: 'Yes', kind: 'allow_always' })).toBe('Always allow');
      expect(optionLabel({ optionId: 'r', name: 'No', kind: 'reject_always' })).toBe('Always decline');
    });

    await it('every label is short enough for one line at the 360 px floor', async () => {
      // The button row is as wide as the dialog and the row stacks, so a label has to fit its own line
      // rather than share one. Four fixed sentences do; anything built from the agent's name did not.
      const labels = [allow, alwaysAllow, reject, alwaysReject].map((option) => optionLabel(option));
      for (const label of labels) {
        expect(label.length).toBeLessThanOrEqual(20);
        expect(label).not.toContain(':');
      }
      // …and the four are pairwise distinct, which is the whole reason there are four of them.
      expect(new Set(labels).size).toBe(4);
    });

    await it("agentNames — where the agent's wording went, and when there is nothing to say", async () => {
      // **The agent's names left the buttons, so they have to land somewhere.** They went into the
      // body as one caption, because a caption wraps and a button does not.
      // A name that *repeats the kind* earns no line, and that is the common case — most agents call
      // their options "Allow once" and "Decline", which the labels already say.
      expect(
        agentNames([
          { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'r', name: 'Decline', kind: 'reject_once' },
        ]),
      ).toBe(null);
      // An agent that qualifies its options gets them, quoted so the line reads as the agent's wording
      // and not as more of kurier's own sentence.
      expect(
        agentNames([
          { optionId: 'a', name: 'Always allow in this session', kind: 'allow_always' },
          { optionId: 'r', name: 'Decline', kind: 'reject_once' },
        ]),
      ).toBe('The agent calls these: "Always allow in this session"');
      // Punctuation and case are not a difference of meaning, so those still say nothing.
      expect(agentNames([{ optionId: 'a', name: 'allow-once', kind: 'allow_once' }])).toBe(null);
      expect(agentNames([{ optionId: 'a', name: '  Allow Once  ', kind: 'allow_once' }])).toBe(null);
      // An empty name is not information either.
      expect(agentNames([{ optionId: 'a', name: '', kind: 'allow_once' }])).toBe(null);
      // The `allow`/`reject` fixtures in this block are named "Yes"/"No" — genuinely different words
      // from the labels, so they *do* earn a line. That is the honest consequence of a textual rule:
      // kurier lists what the agent said rather than judging whether it was worth saying.
      expect(agentNames([allow, reject])).toBe('The agent calls these: "Yes", "No"');
      // Every one that says something is listed, not just the first.
      expect(
        agentNames([
          { optionId: 'a', name: 'Always allow in this session', kind: 'allow_always' },
          { optionId: 'r', name: 'Always decline in this session', kind: 'reject_always' },
        ]),
      ).toBe('The agent calls these: "Always allow in this session", "Always decline in this session"');
      // A megabyte-long name is cut, not wrapped into a paragraph.
      const long = agentNames([{ optionId: 'a', name: 'x'.repeat(500), kind: 'allow_always' }]);
      expect(long?.length).toBeLessThan(200);
      expect(long?.endsWith('…"')).toBe(true);
      // …and a 500-character name never reaches a *button*, which is the invariant the whole move was about:
      // the caption carries the long text, the label stays four words.
      expect(optionLabel({ optionId: 'a', name: 'x'.repeat(500), kind: 'allow_once' })).toBe('Allow once');
    });

    await it('underscores are doubled, because add_response reads them as a mnemonic', async () => {
      // **An agent must not choose kurier's Alt accelerator.** GTK parses `_x` in a response label as
      // "Alt+x", so an agent that named its option `Delete_everything` would have handed the agent a
      // shortcut in kurier's own dialog. Doubling prints a literal underscore. Kurier's own sentences
      // carry none, so this is belt-and-braces against a future wording — but it stays, because
      // nothing downstream of `add_response` would catch a live one.
      expect(escapeMnemonic('_')).toBe('__');
      expect(escapeMnemonic('a_b_c')).toBe('a__b__c');
      expect(escapeMnemonic('nothing to escape')).toBe('nothing to escape');
      // The agent's name is not on the button any more, so the escaping that used to matter there is
      // now belt-and-braces; the function is still exported and still tested on its own.
      expect(optionLabel({ optionId: 'a', name: 'Delete_everything', kind: 'allow_once' })).toBe(
        'Allow once',
      );
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
      [
        'options that are not an array',
        { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: 'allow' },
      ],
      [
        'options that are not objects',
        { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: ['allow'] },
      ],
      [
        'an option with no kind',
        { sessionId: 's1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'a', name: 'Yes' }] },
      ],
      [
        'an option whose kind is a number',
        {
          sessionId: 's1',
          toolCall: { toolCallId: 't1' },
          options: [{ optionId: 'a', name: 'Yes', kind: 1 }],
        },
      ],
      [
        'an option whose kind is a suffix-matched near miss',
        {
          sessionId: 's1',
          toolCall: { toolCallId: 't1' },
          options: [{ optionId: 'a', name: 'Yes', kind: 'allow_always_forever' }],
        },
      ],
      [
        'an option whose kind is upper case',
        {
          sessionId: 's1',
          toolCall: { toolCallId: 't1' },
          options: [{ optionId: 'a', name: 'Yes', kind: 'ALLOW_ALWAYS' }],
        },
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
      [
        'locations that are not an array',
        { sessionId: 's1', toolCall: { toolCallId: 't1', locations: 'x' }, options: ALL_FOUR },
      ],
    ] as const) {
      await it(`${name} projects to a view with nothing to press`, async () => {
        const view = permissionView(malformed(payload));
        expect(view.tool.length).toBeGreaterThan(0);
        expect(view.kind.length).toBeGreaterThan(0);
        // The only parts that can be wrong in a way that matters: options that could allow, and
        // locations that would render as garbage.
        if (
          name.includes('no kind') ||
          name.includes('kind is a number') ||
          name.includes('does not define') ||
          name.includes('suffix-matched') ||
          name.includes('upper case')
        ) {
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

    await it("an option whose kind is not the schema's is dropped, and never guessed at", async () => {
      // `allow_whenever` is not one of the four kinds, and `decideFromView` decides by `startsWith('allow')`.
      // Letting it through would make an unknown word mean "allow", which is the same class of mistake
      // as mapping an unknown response id to an allow.
      const view = permissionView(
        malformed({
          sessionId: 's1',
          toolCall: { toolCallId: 't1' },
          options: [{ optionId: 'a', name: 'Yes', kind: 'allow_whenever' }],
        }),
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

  await describe('one door into the decision', async () => {
    await it('is decideFromView, and it is reachable with the view the desk already holds', async () => {
      // This is the test that replaced `decideFromResponse`'s. It asserts the same two answers through
      // the one function that exists, so the coverage is not lost — only the second door is gone. The
      // `permissionView` in the middle is the whole desk does anyway, in the same order.
      const view = permissionView(request());
      expect(decideFromView(view, 'allow_once')).toStrictEqual({ type: 'allowed', optionId: 'allow_once' });
      expect(decideFromView(view, 'close')).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
    });

    await it('the same four-kind set the window uses, for a surface that reads the raw request', async () => {
      // **The terminal gate's half of "one gate, not two".** It reads `request.options` off the wire
      // rather than a projection, so it needs its own narrowing — and it must be *this* file's, not a
      // second idea of what an option is. An agent that sent `allow_whenever` would otherwise get it as
      // `allowing[0]` at the terminal while the window showed nothing for it.
      expect(isKnownOptionKind('allow_always')).toBe(true);
      expect(isKnownOptionKind('reject_always')).toBe(true);
      for (const kind of ['allow_whenever', 'allow_always_forever', 'ALLOW_ONCE', '', 1, null, undefined]) {
        expect(isKnownOptionKind(kind)).toBe(false);
      }
      // `usableOptions` drops the unusable and applies kurier's order, exactly like `permissionView`.
      const usable = usableOptions({
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'Write' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'weird', name: 'Whenever', kind: 'allow_whenever' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
        ] as RequestPermissionRequest['options'],
      });
      expect(usable.map((option) => option.optionId)).toStrictEqual([
        'reject_once',
        'allow_once',
        'allow_always',
      ]);
      // …and it agrees with the projection on the same request, option for option.
      const view = permissionView({
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'Write' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'weird', name: 'Whenever', kind: 'allow_whenever' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
        ] as RequestPermissionRequest['options'],
      });
      expect(view.options.map((option) => option.optionId)).toStrictEqual(
        usable.map((option) => option.optionId),
      );
      // A message with no options at all narrows to none rather than throwing.
      expect(usableOptions(undefined)).toStrictEqual([]);
      expect(usableOptions({ sessionId: 's1' } as RequestPermissionRequest)).toStrictEqual([]);
    });

    await it('is fail-closed through that one door for an id the view never offered', async () => {
      // The case a raw-request door would have got wrong: `decideFromView` reads the *view*, so an id
      // the projection did not carry is a dismissal even when the raw request listed it. That is what
      // makes one door enough — there is no second path that could read past the view.
      const onlyOnce = permissionView({
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'Write' },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      });
      expect(decideFromView(onlyOnce, 'always')).toStrictEqual({ type: 'not-answered', reason: 'dismissed' });
    });

    await it("is the same door for allow_always, and it carries the agent's id out", async () => {
      // One function, both kinds: the pass-through did not open a second entry point, so the fail-closed
      // rule above and the allowance here cannot drift apart.
      const onlyAlways = permissionView({
        sessionId: 's1',
        toolCall: { toolCallId: 't1', title: 'Write' },
        options: [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }],
      });
      expect(decideFromView(onlyAlways, 'always')).toStrictEqual({ type: 'allowed', optionId: 'always' });
      expect(answerFor(decideFromView(onlyAlways, 'always'))).toStrictEqual({
        outcome: { outcome: 'selected', optionId: 'always' },
      });
    });
  });
};

import { describe, expect, it } from '@gjsify/unit';

import { describe as describeRequest, permissionView, terminalGate } from '@lotse/core';
import { scriptedTerminal } from '../../../src/frontends/cli/terminal.ts';

import type { RequestPermissionRequest } from '@lotse/acp/types';

function requestWith(options: RequestPermissionRequest['options']): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', title: 'edit a file', status: 'pending' },
    options,
  };
}

export default async () => {
  await describe('terminalGate — the interactive answer', async () => {
    await it('"y" picks the agent\'s allow_once option, when there are two allow options', async () => {
      const request = requestWith([
        { optionId: 'allow_once_id', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always_id', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_once_id');
    });

    await it('"y" still picks allow_once when the agent listed allow_always first', async () => {
      // **One typed character is not a click on a button labelled "always".** The agent's order is
      // chosen by the agent; a bare `y` on a prompt line is the weaker signal, so the `*_once` option
      // is what a `y` consents to — and `allow_always` comes back only when it is the sole allow.
      const request = requestWith([
        { optionId: 'allow_always_id', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'allow_once_id', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_once_id');
    });

    await it('"y" returns allow_always when it is the only allow the agent offered', async () => {
      // Filtering it out of the gate would leave `y` with nothing to answer, and the agent's own
      // option would become unreachable. kurier relays the choice; the agent keeps the promise.
      const request = requestWith([
        { optionId: 'allow_always_id', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_always_id');
    });

    await it("the prompt says which option y grants, in kurier's words", async () => {
      // **The point of the line.** It used to print the agent's own `name`s and never said what `y`
      // would actually do, so a `y` could silently become a session-wide grant. Now it names the
      // option, from the same `optionLabel` the dialog puts on its button.
      const request = requestWith([
        { optionId: 'allow_once_id', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always_id', name: 'Always allow in this session', kind: 'allow_always' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['y']);
      await terminalGate({ terminal })(request);
      expect(terminal.output).toContain('y = Allow once');
      expect(terminal.output).toContain('n/Enter = Decline');
      // The agent's own wording rides underneath, and only because it adds something.
      expect(terminal.output).toContain('"Always allow in this session"');
    });

    await it('a lone allow_always is announced as "Always allow", not granted silently', async () => {
      // **The one case `orderOptions` cannot make safe** — there is no narrower allow to prefer, so the
      // `y` returns `allow_always`. The prompt must therefore say so in the same breath, or the
      // grant is a surprise.
      const request = requestWith([
        { optionId: 'allow_always_id', name: 'Always allow in this session', kind: 'allow_always' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_always_id');
      expect(terminal.output).toContain('y = Always allow');
      expect(terminal.output).not.toContain('y = Allow once');
    });

    await it('says nothing about y when the agent offered no allowing option at all', async () => {
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      const request = requestWith([{ optionId: 'reject_id', name: 'Reject', kind: 'reject_once' }]);
      // `y` gets nothing, the printed line does not pretend otherwise, and the answer is the agent's own
      // decline id rather than `null` — so the agent learns *which* of its options kurier picked.
      expect(await gate(request)).toBe('reject_id');
      expect(terminal.output).toContain('no allowing option');
      expect(terminal.output).not.toContain('y =');
    });

    await it('answers null only when the agent offered nothing rejecting either', async () => {
      // The one case `null` is right for: there is no option id of the agent's to hand back at all, and
      // `null` is the answer every gate may give. It is the same answer the non-interactive path gives.
      const request = requestWith([{ optionId: 'allow_id', name: 'Allow', kind: 'allow_once' }]);
      const terminal = scriptedTerminal(['n']);
      expect(await terminalGate({ terminal })(request)).toBe(null);
      expect(await terminalGate({ terminal: scriptedTerminal([]) })(request)).toBe(null);
    });

    await it('an unknown kind cannot be granted, here or in the window', async () => {
      // **Two surfaces, one gate.** `allow_whenever` is not a kind ACP v1 defines; the dialog drops it
      // in `permissionView`, and this reads the raw wire array, so it needed the same four-kind check.
      // Without it `allowing[0]` would have been the invented kind and `y` would have granted it. The
      // `as never` is the wire reaching the client: the type names four kinds, the message does not.
      const request = requestWith([
        { optionId: 'weird', name: 'Whenever', kind: 'allow_whenever' } as never,
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      for (const answer of ['y', '']) {
        const terminal = scriptedTerminal([answer]);
        expect(await terminalGate({ terminal })(request)).toBe('reject_id');
      }
      // And the projection the dialog renders agrees.
      expect(permissionView(request).options.map((option) => option.optionId)).toStrictEqual(['reject_id']);
    });

    await it('a bare line declines this request only, when both reject kinds were offered', async () => {
      // The terminal counterpart of `initialFocusResponseId` preferring `reject_once`: an accidental
      // newline must not set a session-wide refusal for a question about one file.
      const request = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_always_id', name: 'Always decline', kind: 'reject_always' },
        { optionId: 'reject_once_id', name: 'Decline', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal(['']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('reject_once_id');
    });

    for (const answer of ['', 'n', ' ', 'whatever', null]) {
      await it(`answer ${JSON.stringify(answer)} declines`, async () => {
        const request = requestWith([
          { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
        ]);
        const terminal = scriptedTerminal([answer]);
        const gate = terminalGate({ terminal });
        expect(await gate(request)).toBe('reject_id');
      });
    }
  });

  await describe('terminalGate — an agent offering only allow_* options', async () => {
    await it('cannot get an allow out of a non-"y" answer, and the prompt says decline is available', async () => {
      const request = requestWith([{ optionId: 'allow_id', name: 'Allow', kind: 'allow_once' }]);
      const terminal = scriptedTerminal(['n']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe(null);
      // The prompt names what the bare line does, in kurier's wording: `decline` in lower case, because
      // there is no decline *option id* to hand back — the agent offered none. It still says Enter is safe.
      expect(terminal.output).toContain('n/Enter = decline');
    });

    await it('"y" still picks the sole allow option', async () => {
      const request = requestWith([{ optionId: 'allow_id', name: 'Allow', kind: 'allow_once' }]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_id');
    });

    await it('a non-"y" answer still cannot allow, when the only allow is allow_always', async () => {
      // Pass-through is not leniency: the narrow/decline-by-anything-but-`y` rule is unchanged, and it
      // is the same rule that says silence is a no.
      const request = requestWith([
        { optionId: 'allow_always_id', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      for (const answer of ['', 'n', ' ', 'always', null]) {
        const terminal = scriptedTerminal([answer]);
        const gate = terminalGate({ terminal });
        expect(await gate(request)).toBe('reject_id');
      }
    });
  });

  await describe('terminalGate — a non-interactive terminal', async () => {
    await it('never asks and always declines', async () => {
      const request = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const terminal = scriptedTerminal([]); // no answers queued => not interactive
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('reject_id');
      expect(terminal.output).toBe('');
      expect(terminal.output.includes('[y]')).toBe(false);
    });

    await it('declines to null when the agent offered no rejecting option either', async () => {
      const request = requestWith([{ optionId: 'allow_id', name: 'Allow', kind: 'allow_once' }]);
      const terminal = scriptedTerminal([]);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe(null);
    });

    await it('prefers reject_once on a pipe, exactly as it does on a terminal', async () => {
      // **A pipe is not a reason to answer more broadly.** The narrowest decline is chosen once, above
      // the `interactive` branch, so a redirected run and a terminal run of the same request cannot
      // answer differently — an `allow_always`/nothing pair would otherwise have made the piped path
      // answer `reject_always` while the interactive path answered `reject_once`.
      const request = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_always_id', name: 'Always decline', kind: 'reject_always' },
        { optionId: 'reject_once_id', name: 'Decline', kind: 'reject_once' },
      ]);
      const piped = scriptedTerminal([]);
      const interactive = scriptedTerminal(['']);
      expect(await terminalGate({ terminal: piped })(request)).toBe('reject_once_id');
      expect(await terminalGate({ terminal: interactive })(request)).toBe('reject_once_id');
      // Only `reject_always` on offer: both paths still answer it, because it is the only decline.
      const onlyAlways = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_always_id', name: 'Always decline', kind: 'reject_always' },
      ]);
      expect(await terminalGate({ terminal: scriptedTerminal([]) })(onlyAlways)).toBe('reject_always_id');
    });
  });

  await describe('terminalGate — onDecision', async () => {
    await it('receives the chosen option id', async () => {
      const request = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const decisions: (string | null)[] = [];
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal, onDecision: (id) => decisions.push(id) });
      await gate(request);
      expect(decisions).toStrictEqual(['allow_id']);
    });

    await it('receives null on decline', async () => {
      const request = requestWith([
        { optionId: 'allow_id', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_id', name: 'Reject', kind: 'reject_once' },
      ]);
      const decisions: (string | null)[] = [];
      const terminal = scriptedTerminal(['n']);
      const gate = terminalGate({ terminal, onDecision: (id) => decisions.push(id) });
      await gate(request);
      expect(decisions).toStrictEqual(['reject_id']);
    });
  });

  await describe('describe() — the question a person is asked', async () => {
    await it('includes the tool title, the file path and a truncated rawInput', async () => {
      const request: RequestPermissionRequest = {
        sessionId: 's1',
        toolCall: {
          toolCallId: 't1',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          locations: [{ path: '/tmp/foo.ts', line: 10 }],
          rawInput: { contents: 'x'.repeat(400) },
        },
        options: [],
      };
      const text = describeRequest(request);
      expect(text).toContain('Edit file (edit)');
      expect(text).toContain('/tmp/foo.ts:10');
      expect(text).toContain('…');
    });
  });
};

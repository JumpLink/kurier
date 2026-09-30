import { describe, expect, it } from '@gjsify/unit';

import { describe as describeRequest, terminalGate } from '../../../src/core/policy.ts';
import { scriptedTerminal } from '../../../src/frontends/cli/terminal.ts';

import type { RequestPermissionRequest } from '@kurier/acp/types';

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
      expect(terminal.output).toContain('[n/Enter] decline');
    });

    await it('"y" still picks the sole allow option', async () => {
      const request = requestWith([{ optionId: 'allow_id', name: 'Allow', kind: 'allow_once' }]);
      const terminal = scriptedTerminal(['y']);
      const gate = terminalGate({ terminal });
      expect(await gate(request)).toBe('allow_id');
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

import { describe, expect, it } from '@gjsify/unit';

import type { RequestPermissionRequest } from '@lotse/acp/types';

import {
  callDigest,
  describeCall,
  serveGate,
  stripAlways,
  type AskOutcome,
  type GateDecision,
} from '@lotse/core';

const ALL_FOUR: RequestPermissionRequest['options'] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Always decline', kind: 'reject_always' },
];

function request(rawInput: Record<string, unknown> = { path: 'a.txt', text: 'x' }): RequestPermissionRequest {
  return {
    sessionId: 'ses_1',
    toolCall: { toolCallId: `call_${Math.random()}`, title: 'write', kind: 'edit', rawInput },
    options: ALL_FOUR,
  };
}

function harness(rights: 'read' | 'confirm' | 'released', answers: AskOutcome[]) {
  const asked: string[] = [];
  const decisions: GateDecision[] = [];
  const gate = serveGate({
    rights,
    released: rights === 'released' ? [{ tool: 'read', kind: null }] : [],
    now: () => 0,
    ask: async (_request, _action, text) => {
      asked.push(text);
      return answers.shift() ?? 'no';
    },
    onDecision: (decision) => decisions.push(decision),
  });
  return { gate, asked, decisions };
}

export default async () => {
  await describe('stripAlways and callDigest', async () => {
    await it('only the once options survive', async () => {
      expect(stripAlways(ALL_FOUR).map((option) => option.kind)).toStrictEqual(['allow_once', 'reject_once']);
    });

    await it('the digest ignores key order and the call id, and sees the input', async () => {
      expect(callDigest(request({ a: 1, b: 2 }))).toBe(callDigest(request({ b: 2, a: 1 })));
      expect(callDigest(request({ a: 1 }))).not.toBe(callDigest(request({ a: 2 })));
    });

    await it('the question shows the input verbatim', async () => {
      expect(describeCall(request({ path: 'a.txt' }))).toContain('input: {"path":"a.txt"}');
    });
  });

  await describe('serveGate', async () => {
    await it('read rights decline without asking', async () => {
      const { gate, asked, decisions } = harness('read', []);
      expect(await gate(request())).toBe('reject_once');
      expect(asked.length).toBe(0);
      expect(decisions[0]!.why).toBe('read-only');
    });

    await it('a released area is allowed once, without a question', async () => {
      const { gate, asked } = harness('released', []);
      const read = { ...request(), toolCall: { ...request().toolCall, title: 'read' } };
      expect(await gate(read)).toBe('allow_once');
      expect(asked.length).toBe(0);
    });

    await it('a yes allows exactly one call; the same call again asks again', async () => {
      const { gate, asked, decisions } = harness('confirm', ['yes', 'no']);
      expect(await gate(request())).toBe('allow_once');
      expect(await gate(request())).toBe('reject_once');
      expect(asked.length).toBe(2);
      expect(decisions.map((decision) => decision.why)).toStrictEqual(['yes', 'no']);
    });

    await it('never selects an always option', async () => {
      const { gate } = harness('confirm', ['yes']);
      const onlyAlways = {
        ...request(),
        options: ALL_FOUR.filter((option) => option.kind.endsWith('always')),
      };
      expect(await gate(onlyAlways)).toBeNull();
    });

    await it('an expired question is cancelled, not a no', async () => {
      const { gate, decisions } = harness('confirm', ['expired']);
      expect(await gate(request())).toBeNull();
      expect(decisions[0]!.why).toBe('expired');
    });

    await it('a refused question (ceiling) declines', async () => {
      const { gate } = harness('confirm', ['refused']);
      expect(await gate(request())).toBe('reject_once');
    });
  });
};

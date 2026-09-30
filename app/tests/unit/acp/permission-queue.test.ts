/**
 * Permission requests arrive one at a time, whatever the agent does.
 *
 * This is a guardrail-adjacent property, not a nicety. A `PermissionGate` is a decision, and a
 * decision needs one person about one thing. `opencode` doing parallel tool calls can send two
 * `session/request_permission` requests before the first is answered; a modal dialog — which is what
 * the Adwaita surface will be — has one window, and without a queue the second question either hides
 * behind the first or overwrites it. The approval would then be for the wrong call, which is the one
 * failure a gate must not have.
 *
 * The fixture sends a *burst* on purpose: all N requests before any answer. A sequential fixture
 * would pass whether the client queues or not, so it could not see this either way.
 */

import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@kurier/acp/client';
import type { ClientGate } from '@kurier/acp/gate';
import type { PermissionOption, RequestPermissionRequest } from '@kurier/acp/types';

import { FixtureAgent } from '../../support/fixture-agent.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

/**
 * A gate that records how many requests were open at the same time.
 *
 * Concurrency is the whole assertion: two requests answered one after the other show a peak of 1,
 * while two delivered together show 2. Nothing else distinguishes the two cases, which is why the
 * counter is incremented on entry and decremented on exit rather than merely counting calls.
 */
function countingGate(answer = 'yes'): {
  gate: ClientGate;
  peak: () => number;
  seen: () => string[];
} {
  let open = 0;
  let peak = 0;
  const order: string[] = [];
  return {
    peak: () => peak,
    seen: () => order,
    gate: {
      permission: async (request: RequestPermissionRequest) => {
        open += 1;
        peak = Math.max(peak, open);
        order.push(String((request.toolCall as { toolCallId?: string }).toolCallId));
        // A real gate takes time — a person reads the diff. The delay is what makes an overlap
        // observable: without a real await between entry and exit, both requests would be delivered
        // before either returned even if the client did nothing.
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return answer;
      },
    },
  };
}

export default async () => {
  await describe('AcpClient — session/request_permission is serialised', async () => {
    await it('delivers a burst of three to the gate one at a time', async () => {
      const fixture = new FixtureAgent({ permissionOptions: OPTIONS, permissionBurst: 3 });
      const { gate, peak } = countingGate();
      const client = new AcpClient({ transport: fixture.transport, gate });

      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.ask(session.sessionId, 'edit three files');

      // The property, stated directly.
      expect(peak()).toBe(1);
      client.close();
    });

    await it('answers every request in the burst, in arrival order', async () => {
      const fixture = new FixtureAgent({ permissionOptions: OPTIONS, permissionBurst: 3 });
      const { gate, seen } = countingGate();
      const client = new AcpClient({ transport: fixture.transport, gate });

      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.ask(session.sessionId, 'edit three files');

      // Order matters as much as count: answering them out of order is how a person ends up
      // approving the second file having read the first question.
      expect(seen()).toEqualArray(['call_1', 'call_2', 'call_3']);
      expect(fixture.permissionOutcomes.length).toBe(3);
      client.close();
    });

    await it('a refusal in the middle still answers the rest of the queue', async () => {
      // A gate that throws mid-burst must not poison the queue. If the chain rejected, every request
      // behind the failing one would go unanswered — and an unanswered JSON-RPC request hangs the
      // agent's turn for ever, with no error anywhere to explain it.
      const fixture = new FixtureAgent({ permissionOptions: OPTIONS, permissionBurst: 3 });
      let calls = 0;
      const gate: ClientGate = {
        permission: () => {
          calls += 1;
          if (calls === 2) throw new Error('the gate is broken');
          return 'yes';
        },
      };
      const client = new AcpClient({ transport: fixture.transport, gate });

      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const response = await client.ask(session.sessionId, 'edit three files');

      // All three were answered — the middle one declined rather than thrown, so the agent sees a
      // refusal (fail closed) instead of a hang.
      expect(fixture.permissionOutcomes.length).toBe(3);
      expect(calls).toBe(3);
      // A refusal mid-turn ends it as a refusal rather than end_turn.
      expect(response.stopReason).toBe('refusal');
      client.close();
    });

    await it('still asks for nothing when the gate declines every request', async () => {
      // The fail-closed path through the queue: `denyAll` returns null, and null means cancelled,
      // which is not an option id and must never be sent as one.
      const fixture = new FixtureAgent({ permissionOptions: OPTIONS, permissionBurst: 2 });
      const client = new AcpClient({ transport: fixture.transport });

      await client.initialize();
      const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const response = await client.ask(session.sessionId, 'do something');

      expect(fixture.permissionOutcomes.length).toBe(2);
      for (const outcome of fixture.permissionOutcomes) {
        expect(outcome?.outcome.outcome).toBe('cancelled');
      }
      expect(response.stopReason).toBe('refusal');
      client.close();
    });
  });
};

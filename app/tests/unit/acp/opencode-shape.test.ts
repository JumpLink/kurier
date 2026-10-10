import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';

import { FixtureAgent } from '../../support/fixture-agent.ts';

/**
 * The literal measured answer from the plan (`kurier-acp-client.md` §2, "Gemessen, nicht
 * angenommen"), pinned here so this file is the thing that goes red when opencode's shape moves —
 * not `fixture-agent.ts`'s comment, which nobody re-reads once it is trusted.
 */
const MEASURED_OPENCODE_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: false },
      promptCapabilities: { embeddedContext: true, image: true },
      // `fork` is NOT in the v1 schema. That is the point: real agents ship extensions ahead of
      // the schema, and unknown capability markers must never be an error.
      sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} },
    },
    authMethods: [
      {
        description: 'Run `opencode auth login` in the terminal',
        name: 'Login with opencode',
        id: 'opencode-login',
      },
    ],
    agentInfo: { name: 'OpenCode', version: '2.0.19' },
  },
} as const;

export default async () => {
  await describe('FixtureAgent — pinned to the measured opencode acp 2.0.19 shape', async () => {
    await it('the fixture default answer is structurally the same shape as the measured one', async () => {
      const measured = MEASURED_OPENCODE_INITIALIZE.result;
      const fixture = new FixtureAgent({
        chattyMeta: true,
        authMethods: [
          {
            id: 'opencode-login',
            name: 'Login with opencode',
            description: 'Run `opencode auth login` in the terminal',
            kind: 'agent',
          },
        ],
      });
      const client = new AcpClient({ transport: fixture.transport });
      const result = await client.initialize();

      // Same sessionCapabilities marker keys, `fork` included — deliberately ahead of the schema.
      expect(Object.keys(result.agentCapabilities?.sessionCapabilities ?? {}).sort()).toStrictEqual(
        Object.keys(measured.agentCapabilities.sessionCapabilities).sort(),
      );

      // Same promptCapabilities.
      expect(result.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(
        measured.agentCapabilities.promptCapabilities.embeddedContext,
      );
      expect(result.agentCapabilities?.promptCapabilities?.image).toBe(
        measured.agentCapabilities.promptCapabilities.image,
      );

      // Same mcpCapabilities.
      expect(result.agentCapabilities?.mcpCapabilities?.http).toBe(
        measured.agentCapabilities.mcpCapabilities.http,
      );
      expect(result.agentCapabilities?.mcpCapabilities?.sse).toBe(
        measured.agentCapabilities.mcpCapabilities.sse,
      );

      // Same authMethods[0] keys: description, name, id — no `type` tag, and `description` is
      // not in the schema either.
      const authMethod = result.authMethods?.[0] as Record<string, unknown>;
      expect('description' in authMethod).toBe(true);
      expect('name' in authMethod).toBe(true);
      expect('id' in authMethod).toBe(true);
      expect('type' in authMethod).toBe(false);

      // agentInfo present, name/version as strings (the fixture names itself, not "OpenCode" —
      // this test pins the SHAPE, not the fixture's own identity).
      expect(typeof result.agentInfo?.name).toBe('string');
      expect(typeof result.agentInfo?.version).toBe('string');

      // `_meta` present at the top level.
      expect(result._meta).toBeTruthy();
    });
  });
};

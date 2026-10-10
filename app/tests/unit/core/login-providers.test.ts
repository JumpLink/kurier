/**
 * Which providers the login offers, read off a catalog body shaped like opencode 2.0.22's
 * `GET /api/integration`. The ids and labels are the measured ones; every credential-looking value is
 * synthetic.
 */

import { describe, expect, it } from '@gjsify/unit';

import { LOGIN_POLICY, parseIntegrations, parseLoginPolicy } from '@lotse/core';

const oauth = (id: string, label: string, form?: unknown[]) => ({
  type: 'oauth',
  id,
  label,
  ...(form ? { form } : {}),
});

const CATALOG = {
  location: { directory: '/synthetic' },
  data: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      methods: [{ type: 'key' }, { type: 'env', names: ['X'] }],
      connections: [],
    },
    { id: 'xai', name: 'xAI', methods: [oauth('device', 'SuperGrok Subscription')], connections: [] },
    { id: 'poe', name: 'Poe', methods: [oauth('browser', 'Login with Poe (browser)')], connections: [] },
    {
      id: 'openai',
      name: 'OpenAI',
      methods: [
        { type: 'key' },
        oauth('chatgpt-token-sharing', 'Sign in with ChatGPT'),
        oauth('chatgpt-headless', 'ChatGPT Pro/Plus (headless)'),
      ],
      connections: [{ id: 'conn_synthetic' }],
    },
    {
      id: 'opencode',
      name: 'OpenCode Console',
      methods: [
        oauth('device', 'OpenCode Console account', [
          {
            key: 'server',
            hidden: true,
            type: 'string',
            format: 'uri',
            default: 'https://opencode.example/console',
          },
        ]),
      ],
      connections: [],
    },
    {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      methods: [
        oauth('device', 'Login with GitHub Copilot', [
          {
            key: 'deploymentType',
            title: 'Select GitHub deployment type',
            required: true,
            type: 'string',
            options: [
              { value: 'github.com', label: 'GitHub.com', description: 'Public' },
              { value: 'enterprise', label: 'GitHub Enterprise' },
            ],
          },
          {
            key: 'enterpriseUrl',
            title: 'Enter your GitHub Enterprise URL or domain',
            required: true,
            type: 'string',
            when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }],
          },
        ]),
      ],
      connections: [],
    },
    {
      id: 'numbers',
      name: 'Numeric form',
      methods: [oauth('x', 'X', [{ key: 'n', type: 'number' }])],
      connections: [],
    },
    {
      id: 'odd-op',
      name: 'Odd op',
      methods: [oauth('x', 'X', [{ key: 'a', type: 'string', when: [{ key: 'b', op: 'ne', value: 'c' }] }])],
      connections: [],
    },
    { id: 'broken', methods: [oauth('x', 'X')] },
  ],
};

export default async () => {
  await describe('parseIntegrations', async () => {
    const providers = parseIntegrations(CATALOG);
    const ids = providers.map((p) => p.id);

    await it('offers a provider that has only an API key method', async () => {
      const anthropic = providers.find((p) => p.id === 'anthropic')!;
      expect(anthropic.methods.map((m) => `${m.kind}:${m.id}`).join(',')).toBe('key:key');
    });

    await it('lists the browser logins before the key, and drops the env method', async () => {
      const openai = providers.find((p) => p.id === 'openai')!;
      expect(openai.methods.map((m) => m.id).join(',')).toBe('chatgpt-token-sharing,chatgpt-headless,key');
    });

    await it('marks the featured and the European providers from the policy', async () => {
      const policy = parseLoginPolicy({ excluded: [], preferred: ['scaleway'], europe: ['scaleway'] });
      const catalog = {
        data: [
          { id: 'scaleway', name: 'Scaleway', methods: [{ type: 'key' }], connections: [] },
          { id: 'other', name: 'Other', methods: [{ type: 'key' }], connections: [] },
        ],
      };
      const [first, second] = parseIntegrations(catalog, policy);
      expect([first!.id, first!.featured, first!.europe].join()).toBe('scaleway,true,true');
      expect([second!.featured, second!.europe].join()).toBe('false,false');
    });

    await it('drops a provider the policy excludes, however it is spelled in the catalog', async () => {
      expect(ids.includes('xai')).toBe(false);
    });

    await it('puts the preferred providers first, in their order, and the rest by name', async () => {
      expect(ids.join(',')).toBe('opencode,openai,github-copilot,anthropic,poe');
    });

    await it('says which provider already holds a connection', async () => {
      expect(providers.find((p) => p.id === 'openai')!.connected).toBe(true);
      expect(providers.find((p) => p.id === 'poe')!.connected).toBe(false);
    });

    await it('reads a hidden field with its default, a select with its options and a conditional field', async () => {
      const console_ = providers.find((p) => p.id === 'opencode')!.methods[0]!.fields[0]!;
      expect(console_.hidden).toBe(true);
      expect(console_.default).toBe('https://opencode.example/console');
      const copilot = providers.find((p) => p.id === 'github-copilot')!.methods[0]!.fields;
      expect(copilot[0]!.options!.map((o) => o.value).join(',')).toBe('github.com,enterprise');
      expect(copilot[0]!.options![0]!.description).toBe('Public');
      expect(copilot[1]!.when![0]!.value).toBe('enterprise');
    });

    await it('leaves out a method it has no widget for, and a provider it cannot read', async () => {
      expect(ids.includes('numbers')).toBe(false);
      expect(ids.includes('odd-op')).toBe(false);
      expect(ids.includes('broken')).toBe(false);
    });

    await it('rejects a body that is not the catalog at all', async () => {
      let message = '';
      try {
        parseIntegrations({ nope: true });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.includes('no `data` list')).toBe(true);
    });
  });

  await describe('the shipped policy', async () => {
    await it('does not offer xAI, and says why', async () => {
      expect(LOGIN_POLICY.excluded.get('xai')!.length > 0).toBe(true);
    });

    await it('lists opencode’s own popular providers first and Scaleway among the European ones', async () => {
      expect(LOGIN_POLICY.preferred.slice(0, 2).join()).toBe('opencode,opencode-go');
      expect(LOGIN_POLICY.europe.has('scaleway')).toBe(true);
      expect(LOGIN_POLICY.preferred.includes('scaleway')).toBe(true);
    });

    await it('rejects an entry without a reason', async () => {
      let thrown = false;
      try {
        parseLoginPolicy({ excluded: [{ id: 'x' }], preferred: [] });
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(true);
    });
  });
};

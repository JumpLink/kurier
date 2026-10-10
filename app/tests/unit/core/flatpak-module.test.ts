/**
 * The generated Flatpak module for a bundled agent: it must equal what kurier's own manifest ships today
 * (golden, key order included), and refuse what it cannot pin.
 */

import { describe, expect, it } from '@gjsify/unit';

import { BUNDLED_AGENTS, flatpakAgentModule } from '@lotse/core';
import manifest from '../../../../eu.jumplink.Lotse.json' with { type: 'json' };
import pkg from '../../../../package.json' with { type: 'json' };

type Named = { name: string };
const pinned = (modules: unknown) => (modules as Named[]).find((m) => m.name === 'opencode');

const opencode = BUNDLED_AGENTS.find((agent) => agent.id === 'opencode')!;

export default async () => {
  await describe('flatpakAgentModule', async () => {
    await it("is byte-for-byte the module in kurier's package.json", async () => {
      const shipped = pinned((pkg as { gjsify: { flatpak: { modules: unknown } } }).gjsify.flatpak.modules);
      expect(JSON.stringify(flatpakAgentModule(opencode))).toBe(JSON.stringify(shipped));
    });

    await it("is byte-for-byte the module in kurier's generated manifest", async () => {
      const shipped = pinned((manifest as { modules: unknown }).modules);
      expect(JSON.stringify(flatpakAgentModule(opencode))).toBe(JSON.stringify(shipped));
    });

    await it('restricts to the requested arch and keeps the unpack script', async () => {
      const module = flatpakAgentModule(opencode, ['aarch64']);
      const extra = module.sources.filter((s) => s['type'] === 'extra-data');
      expect(extra.length).toBe(1);
      expect((extra[0]!['only-arches'] as string[]).join()).toBe('aarch64');
      expect(module.sources[module.sources.length - 1]!['dest-filename']).toBe('apply_extra');
    });

    await it('refuses an arch the entry has no pin for', async () => {
      const x86Only = { ...opencode, dist: opencode.dist.filter((d) => d.arch === 'x86_64') };
      let message = '';
      try {
        flatpakAgentModule(x86Only, ['aarch64']);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.includes('no pinned archive for aarch64')).toBe(true);
    });

    await it('refuses an empty arch list', async () => {
      let threw = false;
      try {
        flatpakAgentModule(opencode, []);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
};

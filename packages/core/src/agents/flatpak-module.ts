/**
 * The Flatpak module that bundles one catalog agent as `extra-data`.
 *
 * **Why generated.** The module is a function of the catalog entry: url, sha256 and size per arch, the
 * unpack directory and the binary's path. Written by hand in each host's manifest it is a second copy of
 * the pin that drifts on the next refresh. Lotse's own manifest and a host's (Steuererklärung) both take
 * this output, so what a host installs is what lotse installs.
 *
 * **No download here.** The catalog validator already refuses an entry without a 64-hex sha256 and a
 * positive size, so a missing checksum fails when the catalog is parsed — this function never fetches or
 * computes one.
 */

import type { BundledAgent, BundledArch } from './catalog.ts';

/** A flatpak-builder module (JSON form). Only the fields this generator writes. */
export interface FlatpakAgentModule {
  readonly name: string;
  readonly buildsystem: 'simple';
  readonly 'build-commands': readonly string[];
  readonly sources: readonly Record<string, unknown>[];
}

/**
 * @param arches Restrict to these architectures; default is every arch the catalog pins.
 * @throws when `arches` names an arch the entry has no pin for, or is empty.
 */
export function flatpakAgentModule(agent: BundledAgent, arches?: readonly BundledArch[]): FlatpakAgentModule {
  const wanted = arches ?? agent.dist.map((dist) => dist.arch);
  if (wanted.length === 0) throw new Error(`flatpak module: no architecture requested for ${agent.id}`);
  const filename = `${agent.id}.tar.gz`;
  const sources: Record<string, unknown>[] = wanted.map((arch) => {
    const dist = agent.dist.find((entry) => entry.arch === arch);
    if (dist === undefined) throw new Error(`flatpak module: ${agent.id} has no pinned archive for ${arch}`);
    return {
      type: 'extra-data',
      filename,
      'only-arches': [arch],
      url: dist.url,
      sha256: dist.sha256,
      size: dist.size,
    };
  });
  sources.push({
    type: 'script',
    'dest-filename': 'apply_extra',
    commands: [
      'set -e',
      `mkdir -p ${agent.installPath}`,
      `tar -xzf /app/extra/${filename} -C ${agent.installPath}`,
      `chmod 0755 ${agent.installPath}/${agent.binary}`,
      `rm -f /app/extra/${filename}`,
    ],
  });
  return {
    name: agent.id,
    buildsystem: 'simple',
    'build-commands': ['install -Dm755 apply_extra /app/bin/apply_extra'],
    sources,
  };
}

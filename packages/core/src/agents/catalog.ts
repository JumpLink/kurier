/**
 * The bundled-agent catalog: which agents a build ships inside itself, validated once at load.
 *
 * **Where the data lives.** `packages/core/data/bundled-agents.json` is a list somebody refreshes by reading a
 * release page, so it carries its own dates and pins (version, per-arch url, sha256, size). It is imported
 * with an import attribute and inlined by the bundler, exactly like `free-models.json`: nothing reads
 * the data directory at runtime, and there is no source tree in the bundle to read from anyway.
 *
 * **Why the copy is OFF PATH.** `/app/bin` is on a Flatpak's PATH. A bundled `opencode` there would be
 * found by `which()` before the host is asked and would shadow the person's own opencode — the one that
 * carries their login, their config and their model choice. So the archive is unpacked under
 * `BUNDLED_PREFIX`, which no PATH contains, and detection (`detect.ts`) ignores a host hit under it.
 * `BUNDLED_PREFIX` is the only place the prefix is written in code; the data file's `installPath` must
 * agree with it and `parseBundledCatalog` refuses a file that does not.
 *
 * **Why `/app/extra`.** The Flatpak ships the archive as `extra-data`: it is downloaded at install time,
 * not at build time, and the one directory written then is `/app/extra` — the rest of `/app` is the
 * read-only build result. `apply_extra` unpacks there, so the prefix is under it. See `data/README.md`.
 *
 * **What `env` is.** A set of flags the agent's launcher passes at spawn (`AgentCommand.env`), such as
 * `OPENCODE_DISABLE_AUTOUPDATE`. It is never a credential: AGENTS.md § Privacy bans one in a launcher
 * `env`, and the validator only checks that values are strings — it cannot tell a flag from a token, so
 * that rule is a review rule for whoever edits the file.
 */

import raw from '../../data/bundled-agents.json' with { type: 'json' };

/** Where bundled agents are unpacked. Off PATH on purpose — see the file header. */
export const BUNDLED_PREFIX = '/app/extra/agents';

const ARCHES = ['x86_64', 'aarch64'] as const;

export type BundledArch = (typeof ARCHES)[number];

/** One downloadable archive, pinned by hash and size. */
export interface BundledDist {
  readonly arch: BundledArch;
  readonly url: string;
  /** 64 lowercase hex characters. */
  readonly sha256: string;
  readonly size: number;
}

export interface BundledAgent {
  /** The launcher id this copy stands in for. */
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly license: string;
  readonly dist: readonly BundledDist[];
  /** Arguments after the binary, e.g. `['acp']`. */
  readonly command: readonly string[];
  /** Flags for the agent's environment. Never credentials. */
  readonly env: Readonly<Record<string, string>>;
  /** ISO date this entry's pins were read off the release page. */
  readonly refreshed: string;
  /** Directory the archive is unpacked into: `${BUNDLED_PREFIX}/${id}`. */
  readonly installPath: string;
  /** The binary's path inside the archive, relative — read off `tar -tzf`, not derived from the id. */
  readonly binary: string;
}

export interface BundledCatalog {
  /** ISO date the catalog as a whole was last checked. */
  readonly checked: string;
  readonly agents: readonly BundledAgent[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`bundled catalog: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`bundled catalog: unknown field "${key}" in ${where}`);
  }
}

function text(value: Record<string, unknown>, key: string, where: string): string {
  const found = value[key];
  if (typeof found !== 'string' || found === '') {
    throw new Error(`bundled catalog: ${where}.${key} must be a non-empty string`);
  }
  return found;
}

function date(value: Record<string, unknown>, key: string, where: string): string {
  const found = text(value, key, where);
  if (!ISO_DATE.test(found)) throw new Error(`bundled catalog: ${where}.${key} must be an ISO date`);
  return found;
}

function parseDist(value: unknown, where: string): BundledDist {
  const dist = object(value, where);
  onlyKeys(dist, ['arch', 'url', 'sha256', 'size'], where);
  const arch = dist['arch'];
  if (!ARCHES.includes(arch as BundledArch)) {
    throw new Error(`bundled catalog: ${where}.arch must be one of ${ARCHES.join(', ')}`);
  }
  const url = text(dist, 'url', where);
  if (!url.startsWith('https://') || url.length === 'https://'.length) {
    throw new Error(`bundled catalog: ${where}.url must be an https URL`);
  }
  const sha256 = text(dist, 'sha256', where);
  if (!SHA256.test(sha256)) {
    throw new Error(`bundled catalog: ${where}.sha256 must be 64 lowercase hex characters`);
  }
  const size = dist['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw new Error(`bundled catalog: ${where}.size must be a positive integer`);
  }
  return { arch: arch as BundledArch, url, sha256, size };
}

function parseAgent(value: unknown, where: string): BundledAgent {
  const entry = object(value, where);
  onlyKeys(
    entry,
    ['id', 'title', 'version', 'license', 'dist', 'command', 'env', 'refreshed', 'installPath', 'binary'],
    where,
  );
  const id = text(entry, 'id', where);
  const installPath = text(entry, 'installPath', where);
  if (installPath !== `${BUNDLED_PREFIX}/${id}`) {
    throw new Error(`bundled catalog: ${where}.installPath must be ${BUNDLED_PREFIX}/${id}`);
  }
  const binary = text(entry, 'binary', where);
  if (
    binary.startsWith('/') ||
    binary.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`bundled catalog: ${where}.binary must be a relative path inside the archive`);
  }

  const distList = entry['dist'];
  if (!Array.isArray(distList) || distList.length === 0) {
    throw new Error(`bundled catalog: ${where}.dist must be a non-empty list`);
  }
  const dist = distList.map((item, index) => parseDist(item, `${where}.dist[${index}]`));
  const seen = new Set<string>();
  for (const item of dist) {
    if (seen.has(item.arch)) throw new Error(`bundled catalog: ${where}.dist lists ${item.arch} twice`);
    seen.add(item.arch);
  }

  const command = entry['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((word) => typeof word !== 'string' || word === '')
  ) {
    throw new Error(`bundled catalog: ${where}.command must be a non-empty list of non-empty strings`);
  }

  const envRaw = object(entry['env'], `${where}.env`);
  const env: Record<string, string> = {};
  for (const [key, flag] of Object.entries(envRaw)) {
    if (typeof flag !== 'string') throw new Error(`bundled catalog: ${where}.env.${key} must be a string`);
    env[key] = flag;
  }

  return {
    id,
    title: text(entry, 'title', where),
    version: text(entry, 'version', where),
    license: text(entry, 'license', where),
    dist,
    command: command as string[],
    env,
    refreshed: date(entry, 'refreshed', where),
    installPath,
    binary,
  };
}

/** Validate a parsed JSON value into a typed catalog. Throws on the first thing wrong. */
export function parseBundledCatalog(value: unknown): BundledCatalog {
  const root = object(value, 'root');
  onlyKeys(root, ['checked', 'agents'], 'root');
  const checked = date(root, 'checked', 'root');
  const list = root['agents'];
  if (!Array.isArray(list)) throw new Error('bundled catalog: root.agents must be a list');
  const agents = list.map((item, index) => parseAgent(item, `agents[${index}]`));
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`bundled catalog: agent "${agent.id}" listed twice`);
    ids.add(agent.id);
  }
  return { checked, agents };
}

/** The file lotse ships, validated once when this module loads. */
export const BUNDLED_CATALOG: BundledCatalog = parseBundledCatalog(raw);

export const BUNDLED_AGENTS: readonly BundledAgent[] = BUNDLED_CATALOG.agents;

/** The absolute path of the agent's binary: its path inside the archive, under the install directory. */
export function bundledProgram(entry: BundledAgent): string {
  return `${entry.installPath}/${entry.binary}`;
}

/**
 * Where kurier keeps things — the shape, not the policy.
 *
 * Core never reads `HOME`, `XDG_*` or `LOTSE_*`: a `LotsePaths` arrives as an argument, built once
 * where the process starts. That is what lets a host put kurier's conversation inside its own data
 * directory, and what lets a test point it at a temp dir. The app's own XDG resolver (`lotsePaths`,
 * and the `LOTSE_*` overrides) stays in the app, in `app/src/core/paths.ts`, because which directory
 * a *CLI* writes to is the CLI's decision.
 *
 * The one promise the app side carries: **nothing is ever written inside the repository.**
 */

import { join } from 'node:path';

/**
 * Every place kurier writes, as one value, handed down so nothing below the entry resolves a
 * directory itself. A bundled agent's `HOME` and `XDG_*` follow `dataDir` (`agents/isolation.ts`), so
 * moving `dataDir` moves them too.
 */
export interface LotsePaths {
  readonly dataDir: string;
  readonly configDir: string;
  readonly sessionsFile: string;
  readonly settingsFile: string;
  readonly noticesFile: string;
}

/** Everything under one root: `<root>/data` and `<root>/config`, the layout a host app gives kurier. */
export function lotsePathsUnder(root: string): LotsePaths {
  const data = join(root, 'data');
  const config = join(root, 'config');
  return {
    dataDir: data,
    configDir: config,
    sessionsFile: join(data, 'sessions.json'),
    settingsFile: join(config, 'settings.json'),
    noticesFile: join(data, 'notices.json'),
  };
}

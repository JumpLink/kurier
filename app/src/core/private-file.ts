/**
 * The one private-file writer: a sibling temp file, fsync, rename — so a crash leaves the old file or the
 * new one. File `0600`, a directory kurier creates `0700`. An existing directory is left alone: an
 * override variable may point into a shared one, and narrowing its mode is not ours to do.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function writePrivateFile(path: string, text: string, tempPrefix: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const temp = join(dir, `.${tempPrefix}-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    const handle = openSync(temp, 'r+');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

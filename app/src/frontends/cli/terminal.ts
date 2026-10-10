/**
 * The terminal, as a `Terminal`.
 *
 * **One readline interface for the whole process, with its own line queue.** A second interface on
 * the same stdin loses whatever the first already buffered, which is exactly what happens when
 * answers are piped in — and a permission gate that silently swallows a piped "y" is a gate that
 * looks broken. Every command that both asks a question and runs a turn shares this one object.
 *
 * Questions go to **stderr**, answers come from stdin: that keeps a piped stdout machine-readable,
 * which is what makes `lotse start "…"` composable in a shell.
 */

import { createInterface, type Interface } from 'node:readline';

import type { Terminal } from '@lotse/core';

export function processTerminal(): Terminal {
  const interactive = Boolean((process.stdin as { isTTY?: boolean }).isTTY);
  // `terminal: false` is what makes piped input work at all: with a terminal mode readline eats
  // keystrokes rather than lines, and a here-doc answers nothing.
  const rl: Interface = createInterface({ input: process.stdin, terminal: interactive });
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    ended = true;
    // Every question still outstanding gets "no answer", which the gate reads as a decline.
    for (const next of waiting.splice(0)) next(null);
  });

  return {
    interactive,
    write: (text: string) => {
      process.stderr.write(text);
    },
    read: () => {
      const ready = buffered.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => waiting.push(resolve));
    },
    close: () => {
      rl.close();
    },
  };
}

/** A terminal for tests: scripted answers, no process. */
export function scriptedTerminal(answers: (string | null)[]): Terminal & { output: string } {
  const queue = answers.slice();
  const state = { output: '' };
  return {
    interactive: answers.length > 0,
    write: (text: string) => {
      state.output += text;
    },
    read: () => Promise.resolve(queue.shift() ?? null),
    close: () => {},
    get output() {
      return state.output;
    },
  };
}

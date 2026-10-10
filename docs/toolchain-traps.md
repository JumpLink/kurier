# Toolchain traps

The incidents behind the toolchain rules in [AGENTS.md](../AGENTS.md#conventions). The rules stay
there; the measurements that produced them live here, so a rule is never "simplified" back into
the bug.

## A green test run that tested a stale bundle

**A green `gjsify test` meant "the last build is green", not "the source is green" — on every gjsify
before 0.53.0.** Measured here: editing `packages/session/src/model.ts` and re-running left
`app/dist/test.*.mjs` untouched (mtime unchanged) and printed **136 tests passed** for code that no
longer existed. Touching the entry, `app/tests/test.mts`, forced the rebuild. The cause was scope,
not staleness arithmetic: `packageBuildInputs` walks the package directory, and a workspace sibling
is reached only through a `node_modules` symlink pointing **outside** it. CI never saw it — a fresh
container has no `dist/`, so it always built, which is why the trap survived the whole 0.5x series
and then needed an `rm -rf` here after every source edit.

**0.53.0 carries the fix** (gjsify [#1896](https://github.com/gjsify/gjsify/pull/1896),
[#1905](https://github.com/gjsify/gjsify/issues/1905)): the build records what it actually READ into
`<outfile>.inputs.json` beside the bundle, from the bundler's own module graph. Re-verified here on
the release rather than on a checkout — `app/dist/test.gjs.mjs.inputs.json` lists
`packages/acp/src/*.ts` and `packages/session/src/*.ts` by exact path, and appending a line to
`packages/session/src/model.ts` moved the bundle's mtime with no `rm -rf`. **The failure mode is a
green run, which is the one thing a test suite cannot report about itself**, so that measurement is
worth repeating whenever the toolchain moves; treat a suspiciously fast green as this, not as a win.

**The same family, one level over: a regression test that passes on the code it was meant to fix.**
A test that cannot fail without its fix is decoration, not a guard — and the most expensive green,
because it reads as one. **Run a fix's new test against the unfixed code first**; the failure is the
only evidence it is testing. Worked example, and the test shape that exposed it:
[the 2026-09-30 review](reviews/2026-09-30-code-review-findings.md).

One trap survives, and it is the same family: **the `gjsify` on `PATH` is the one that decides.** A
global install in `~/.local/share/gjsify/global/` wins over this repo's `node_modules/.bin/gjsify`,
so a run that looks like it used the pinned toolchain was a released CLI — and it happily reports a
test result for a bundle from an earlier run. `./node_modules/.bin/gjsify …` whenever the version
matters, which under the freshness rule means always.

## `node:child_process`, not `@gjsify/child_process`

> **In a gjsify project you import `node:child_process` — not `@gjsify/child_process`.**

Measuring the GJS chain failed twice: under Node `ERR_UNSUPPORTED_ESM_URL_SCHEME: gi:`, under GJS
`Module not found`. Both were the same error — the **package** specifier instead of the **module**
specifier. The bundler is the resolution path: `gjsify build` → `gjsify run` is the chain. **Not a
gjsify bug**: `@gjsify/child_process` carries `runtimes.node: "none"` because there would be
nothing to port under Node, and `test.node.mjs` (48 KB) is a parity suite against the real
`node:child_process`, not a Node port.

## Named imports from a `.blp`

> **No file in this repo imports anything but the default from a `.blp`.**

`gjsify` generates a sidecar beside every Blueprint file — `window.d.blp.ts`, `chat.d.blp.ts`,
`permission-body.d.blp.ts` — that declares the template's object ids, so a named import looks like
the obvious way to type them. It does not compile. The repo's TypeScript is 6.0.3 without
`allowArbitraryExtensions`, so `import … from './chat.blp'` is resolved by the ambient
`declare module '*.blp'` instead of by the sidecar; that declaration exports a default and nothing
else, and the named import fails with **TS2614** (*"Module has no exported member"*) pointing at a
file that plainly has it.

What works, and what every template in the repo therefore does (`window.ts`, `chat.ts`,
`permission-dialog.ts`): import only the default, pass a literal `InternalChildren` array to
`GObject.registerClass`, and `declare readonly _id: Type` one field per id. The array and the
sidecar must agree by hand — `build:app` regenerates the sidecar, so a mismatch shows up there as a
missing or extra id. The sidecars stay on disk as the record of what the template defines; nothing
imports them.

## Why `@gjsify/napi` is not pinned

All `@gjsify/*` packages are pinned to the same exact version. One is absent: `@gjsify/napi`,
which nothing in lotse imports — its rewrite only fires for a compiled `.node` addon inside a
bundle, and every addon in this tree is build-time tooling that runs under Node. It was also
unpublishable through 0.53.0 (`packages/napi/**` is not a workspace member — its release leg builds
a meson prebuild per platform first, and the 0.53.0 tarball never landed); 0.54.0 publishes it
again, so the pin can come back if a build ever does carry an addon.

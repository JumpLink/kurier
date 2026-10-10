#!/usr/bin/env node
/**
 * Does the metainfo still carry the app id and the rename?
 *
 * `data/eu.jumplink.Lotse.metainfo.xml` is **generated** from `package.json#gjsify.flatpak`, and
 * `gjsify flatpak init --force` overwrites it. Two of its elements have no field in that config and
 * are hand-written into the output: `<provides><id>` and `<replaces><id>`, which say that this
 * component is the one that used to be `eu.jumplink.Kurier`. Without them a regeneration quietly
 * orphans every installed copy and every ODRS review of the old id — and nothing else in the build
 * would notice, because the file stays valid AppStream either way.
 *
 * So this runs inside `npm run packaging:validate`, beside the two real validators:
 * `desktop-file-validate` and `appstreamcli validate` check that the XML is *correct*, and this
 * checks that it is still *about this app*. `appstreamcli` cannot know the old name.
 *
 *   node scripts/check-metainfo.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'eu.jumplink.Lotse';
const OLD_APP_ID = 'eu.jumplink.Kurier';
const FILE = join('data', `${APP_ID}.metainfo.xml`);

const xml = readFileSync(join(ROOT, FILE), 'utf8');
const problems = [];

const id = /<id>([^<]+)<\/id>/.exec(xml)?.[1];
if (id !== APP_ID) {
  problems.push(`the component id is ${id ?? 'missing'}, not ${APP_ID}`);
}

// Both elements, because they say different things: `provides` keeps the old id resolvable (reviews,
// a reference from somewhere else), `replaces` says the two cannot be installed side by side.
if (!new RegExp(`<provides>[\\s\\S]*<id>${OLD_APP_ID}</id>[\\s\\S]*</provides>`).test(xml)) {
  problems.push(`<provides> does not list the old id ${OLD_APP_ID} — see data/README.md`);
}
if (!new RegExp(`<replaces>\\s*<id>${OLD_APP_ID}</id>\\s*</replaces>`).test(xml)) {
  problems.push(`<replaces> does not name the old id ${OLD_APP_ID} — see data/README.md`);
}

// The binaries come from the config, so a stale one here means the generated file is stale.
for (const binary of ['lotse', 'lotse-app']) {
  if (!xml.includes(`<binary>${binary}</binary>`))
    problems.push(`<provides> is missing <binary>${binary}</binary>`);
}
if (/<binary>kurier/.test(xml)) {
  problems.push('<provides> still names a kurier binary — regenerate from package.json');
}

if (problems.length > 0) {
  console.error(`${FILE} check FAILED (${problems.length}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`${FILE} ok — ${APP_ID}, provides and replaces ${OLD_APP_ID}`);

/**
 * What the preferences dialog lists, decided without a widget: rows in order, which one is selected, and
 * the one note a person should read.
 *
 * Pure over facts — detections, the catalog and the saved settings — so a test hands in a synthetic machine
 * and the dialog (`frontends/gui/preferences.ts`) only renders what it is given. Fixed English, no `Intl`.
 *
 * **An unavailable choice is shown and marked, never dropped.** A person may have chosen it on another
 * machine, or removed the install since; hiding the row would make the saved choice vanish from the very
 * dialog that is meant to explain it. A saved choice that names an id this build does not know gets a row
 * of its own for the same reason.
 *
 * Row keys are `auto`, `<id>:host` and `<id>:bundled`; `lotse agents --use` takes the last two as they
 * are and spells Automatic `none`.
 *
 * **A host install may still be unknown.** Inside a Flatpak finding one means asking the host, which takes
 * a moment, so the dialog draws first with `hostPending` rows ("Checking…") and draws again from the same
 * function once the answer is in. The pending view and the detected one list the same keys in the same
 * order, so the merge is just this function called twice — and a test can say so.
 *
 * **A file lotse must not overwrite locks the rows** (`readOnly`, decided by `saveDecision`), and the note
 * says why; a file it will first move aside says so too.
 */

import {
  bundledProgram,
  resolveAgent,
  type AgentChoice,
  type AgentDetection,
  type BundledAgent,
} from '@lotse/core';
import { saveDecision, type Settings, type SettingsProblemKind } from './settings.ts';

export const AUTOMATIC_KEY = 'auto';

export interface ChoiceRow {
  readonly key: string;
  readonly title: string;
  /** A path, a version or the reason this row cannot run here. Never empty. */
  readonly subtitle: string;
  readonly available: boolean;
  /** A host row whose detection has not answered yet; `available` is `false` meanwhile. */
  readonly pending: boolean;
  readonly selected: boolean;
}

export interface ChoicesView {
  readonly rows: readonly ChoiceRow[];
  /** The file problem and/or the unavailable-choice sentence, one per line; `null` when there is nothing to say. */
  readonly note: string | null;
  /** True when a save would be refused (see `saveDecision`): the rows must not be offered as choices. */
  readonly readOnly: boolean;
}

export interface ChoicesFacts {
  /** Whether the bundled program for `id` exists even when a host install shadows it in `detections`. */
  readonly bundledAvailable?: (id: string) => boolean;
  /** Why the settings file was not used (`readSettings().problem`), or `null`. */
  readonly problem?: string | null;
  /** What kind of problem it was (`readSettings().problemKind`); decides whether saving is allowed. */
  readonly problemKind?: SettingsProblemKind | null;
  /** Where a save moves a file it did not accept, for the note. */
  readonly backupPath?: string;
  /** The host detection has not finished: host rows show "Checking…" instead of "Not found". */
  readonly hostPending?: boolean;
}

export function choiceKey(choice: AgentChoice | null): string {
  return choice === null ? AUTOMATIC_KEY : `${choice.id}:${choice.source}`;
}

/** The choice a row key stands for: `null` for Automatic, `undefined` for a key that is not one. */
export function choiceFromKey(key: string): AgentChoice | null | undefined {
  if (key === AUTOMATIC_KEY) return null;
  const [id = '', source = '', ...rest] = key.split(':');
  if (id === '' || rest.length > 0 || (source !== 'host' && source !== 'bundled')) return undefined;
  return { id, source };
}

function hostTitle(name: string, version: string | null): string {
  return `Installed (${name}${version ? ` ${version}` : ''})`;
}

function bundledTitle(name: string, version: string | null): string {
  return `Bundled (${name}${version ? ` ${version}` : ''})`;
}

export function settingsChoicesView(
  detections: readonly AgentDetection[],
  catalog: readonly BundledAgent[],
  settings: Settings,
  facts: ChoicesFacts = {},
): ChoicesView {
  const nameOf = (id: string) => catalog.find((entry) => entry.id === id)?.title ?? id;
  const bundledAvailable =
    facts.bundledAvailable ??
    ((id: string) => detections.find((entry) => entry.id === id)?.source === 'bundled');
  const selectedKey = choiceKey(settings.agent);

  const hostPending = facts.hostPending === true;
  const rows: Omit<ChoiceRow, 'selected'>[] = [];
  for (const detection of detections) {
    const found = detection.source === 'host';
    const pending = hostPending && !found;
    rows.push({
      key: `${detection.id}:host`,
      title: hostTitle(nameOf(detection.id), found ? detection.version : null),
      subtitle: found
        ? (detection.path ?? 'On your PATH')
        : pending
          ? 'Checking…'
          : 'Not found on this machine',
      available: found,
      pending,
    });
  }
  for (const entry of catalog) {
    const available = bundledAvailable(entry.id);
    rows.push({
      key: `${entry.id}:bundled`,
      title: bundledTitle(entry.title, entry.version),
      subtitle: available ? bundledProgram(entry) : 'Not included in this install',
      available,
      pending: false,
    });
  }
  if (!rows.some((row) => row.key === selectedKey) && settings.agent) {
    const { id, source } = settings.agent;
    rows.push({
      key: selectedKey,
      title: source === 'bundled' ? bundledTitle(id, null) : hostTitle(id, null),
      subtitle: 'Not known to this version of lotse',
      available: false,
      pending: false,
    });
  }

  // What Automatic would start now: the same rule the window resolves with, with no setting.
  const { detection: automatic } = resolveAgent({
    setting: null,
    detections,
    bundledAvailable,
    catalog,
  });
  const nowTitle = automatic
    ? automatic.source === 'bundled'
      ? bundledTitle(nameOf(automatic.id), automatic.version)
      : hostTitle(nameOf(automatic.id), automatic.version)
    : null;
  const automaticRow: Omit<ChoiceRow, 'selected'> = {
    key: AUTOMATIC_KEY,
    title: 'Automatic',
    subtitle: `Your own install first, else the bundled one. Now: ${
      hostPending ? 'checking…' : (nowTitle ?? 'no agent is available')
    }`,
    available: true,
    pending: false,
  };

  const ordered = [automaticRow, ...rows].map(
    (row): ChoiceRow => ({ ...row, selected: row.key === selectedKey }),
  );

  const lines: string[] = [];
  if (facts.problem) lines.push(facts.problem);
  const decision = saveDecision(facts.problemKind ?? null);
  if (decision === 'refuse') {
    lines.push('lotse will not overwrite that file, so choosing an agent is turned off here.');
  } else if (decision === 'backup-then-write' && facts.backupPath) {
    lines.push(`Your next choice first moves that file to ${facts.backupPath}.`);
  }
  const chosen = ordered.find((row) => row.selected);
  if (settings.agent && chosen && !chosen.available && !chosen.pending) {
    lines.push(
      `Your saved choice, ${chosen.title}, is not available here, so lotse starts ` +
        `${nowTitle ?? 'no agent (none is available)'} instead.`,
    );
  }
  return {
    rows: ordered,
    note: lines.length > 0 ? lines.join('\n') : null,
    readOnly: decision === 'refuse',
  };
}

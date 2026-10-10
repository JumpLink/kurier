/**
 * Which agent a person picked — the value, not the file it is kept in.
 *
 * `AgentChoice` names a launcher id *and* a source, so "the bundled opencode" and "my opencode" are two
 * different choices: they keep separate logins and histories (`agents/isolation.ts`). `detect.ts` and
 * `resolve.ts` take one as an argument, which is why it lives here rather than beside the settings
 * file; reading and writing `settings.json` is the app's job (`app/src/core/settings.ts`), and a host
 * that embeds lotse may have no such file at all.
 */

export type AgentChoiceSource = 'host' | 'bundled';

export interface AgentChoice {
  readonly id: string;
  readonly source: AgentChoiceSource;
}

/** "the bundled opencode" / "your own opencode" — one phrase, so every message names a choice alike. */
export function describeChoice(choice: AgentChoice): string {
  return choice.source === 'bundled' ? `the bundled ${choice.id}` : `your own ${choice.id}`;
}

/**
 * A recorded tool line, taken apart for drawing.
 *
 * The transcript stores a tool call as the one string `"<title> — <status>"` (`core/transcript.ts`) and
 * records neither the tool's kind nor its input, so everything here is read back out of that text. That
 * makes the icon a guess from the title's wording, and the guess is the surface's: it never reaches the
 * record. No `gi://` import, so Node can test it.
 */

export type ToolStatus = 'running' | 'done' | 'failed';

export interface ToolLine {
  /**
   * The title the agent sent, or `''` when this line carries only a status.
   *
   * A `tool_call_update` may arrive with a status and no title (`core/transcript.ts` writes
   * `"— completed"`), and that is a real shape rather than a malformed line. It stays empty here: a
   * heading invented here ("Tool call") would put a name on the agent that the agent never sent.
   */
  readonly title: string;
  readonly status: { readonly label: string; readonly tone: ToolStatus } | null;
}

const STATUSES: Record<string, { label: string; tone: ToolStatus }> = {
  pending: { label: 'Pending', tone: 'running' },
  in_progress: { label: 'Running', tone: 'running' },
  completed: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'failed' },
};

export function parseToolLine(summary: string): ToolLine {
  const match = /^(.*?)\s*— (\w+)$/su.exec(summary.trim());
  const status = match?.[2] ? STATUSES[match[2]] : undefined;
  if (!match || !status) return { title: summary.trim(), status: null };
  return { title: match[1]?.trim() ?? '', status };
}

/** Icon names checked against the Adwaita theme with `scripts/probes/icon-names.mjs`. */
const ICONS: readonly (readonly [RegExp, string])[] = [
  [/^(read|open|cat|view)\b/i, 'document-open-symbolic'],
  [/^(edit|write|create|patch|update|modify)\b/i, 'document-edit-symbolic'],
  [/^(delete|remove|rm)\b/i, 'edit-delete-symbolic'],
  [/^(move|rename|mv)\b/i, 'folder-symbolic'],
  [/^(search|find|grep|glob|list)\b/i, 'edit-find-symbolic'],
  [/^(fetch|http|web|download|curl)\b/i, 'network-workgroup-symbolic'],
  [/^(run|exec|execute|bash|shell|\$)/i, 'system-run-symbolic'],
];

/** The icon for a tool nothing above matched, and for a status line that names no tool at all. */
export const TOOL_FALLBACK_ICON = 'system-run-symbolic';

/** The icon for a tool title, or for an ACP `kind` word — the permission dialog has the real one. */
export function toolIcon(text: string): string {
  for (const [pattern, icon] of ICONS) if (pattern.test(text.trim())) return icon;
  return TOOL_FALLBACK_ICON;
}

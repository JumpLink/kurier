/**
 * The free-model hint: which model ids to put at the top of a model dropdown, and the one pure function
 * that does it.
 *
 * **A hint, and the word is load-bearing in all four of its senses.** Plan §3 rejected both alternatives
 * and this file is what the rejection left behind: lotse never *chooses* a model (a hardcoded id would
 * be a policy table in a client, and it rots), and it never *probes* (burning a turn on each candidate
 * until one answers is slow and costs quota). What it does is move the ids a maintainer wrote down into
 * the first rows of a list the **agent** supplied — so the person still picks, the agent still decides
 * what exists, and the only thing lotse added is order.
 *
 * **Three things it deliberately does not do**, and each of them is a rule rather than an omission:
 *
 * - **Never selects.** `freeModelFirst` returns the same list, reordered. Nothing here writes a
 *   `currentValue`, and the agent's `currentValue` is still what `core/config.ts` projects as the
 *   selection — a client that picked a model would be holding configuration authority over the agent,
 *   which is the "always allow" mistake in different clothes (`core/config-row.ts`'s header).
 * - **Never hides.** Every id the agent offered is still in the list, in its original relative order
 *   within its group. A model lotse stopped showing is a model a person cannot go back to.
 * - **Never guesses.** The hint is a set of exact id strings. An id this file has never heard of is not
 *   free, is not paid, and is simply not matched — which is also why the list can rot harmlessly: a
 *   model that disappears leaves a stale entry that matches nothing.
 *
 * **The data is a JSON file rather than an array in here, because it is a list somebody maintains by
 * reading a web page.** `packages/core/data/free-models.json` carries the ids, the date they were last checked,
 * the criterion they were chosen by and the link they were read from — so "why is this id in here" is
 * answerable without reading this file, and a stale entry can be recognised as stale. The bundler
 * inlines it, so nothing at runtime reads a file or needs one installed.
 *
 * The sort itself is `freeModelFirst`, and it is pure over its arguments — the ids are a parameter, not
 * a global read — so a test can sort a list against a hint that has nothing to do with the shipped file.
 */

// The import attribute is required, not decorative: this file is an ECMAScript module and `module` is
// `NodeNext` in `tsconfig.json`, so TypeScript demands it (TS1543). The bundler inlines the file's
// contents at build time — nothing reads the data directory at runtime, and no file has to be installed beside
// the bundle for the hint to work.
import list from '../data/free-models.json' with { type: 'json' };

/**
 * The maintainer's list, verbatim: ids, the date it was checked, the criterion and the link.
 *
 * Exported whole because a *hint* is only honest if a person can see what it is made of, and the only
 * way to see it is for it to exist as a value.
 */
export const FREE_MODELS: FreeModelList = list;

/** The ids themselves, in the order the file lists them. */
export const FREE_MODEL_IDS: readonly string[] = FREE_MODELS.ids;

/** The shape of `packages/core/data/free-models.json`, written out so a broken file is a type error and not a runtime surprise. */
export interface FreeModelList {
  /** ISO date the ids were last read off the provider's own page. */
  readonly checked: string;
  /** Where they were read. The only authority lotse has on this. */
  readonly link: string;
  /** Why these ids and not the merely-free ones. */
  readonly criterion: string;
  /** What the hint is allowed to do. A policy, in prose, next to the data it governs. */
  readonly rule: string;
  readonly ids: string[];
}

/**
 * Move every value whose id is in `ids` to the front, **in the hint's own order**, and keep the caller's
 * order for everything after them.
 *
 * **The order of `ids` is a priority, not a set.** `FREE_MODEL_IDS` is written down by a maintainer
 * reading a provider's page, and the order of that list says which of the two is the one to reach first;
 * a `Set` and a partition would have flattened it to a set and quietly thrown the ranking away. So the
 * front group is built by walking `ids` and picking each match out of `values`, which costs
 * `ids.length × values.length` comparisons — two times four hundred, on a row that is rebuilt only when
 * the agent answers about its options.
 *
 * **Everything after the front group keeps the order the *agent* sent it in**, because that order is a
 * statement the agent made (`core/config.ts`: "an agent that puts its recommended model first knows
 * something about its user") and this hint has no business overriding it for the two thirds of the list
 * it says nothing about. Inside the front group the hint wins, by design.
 *
 * **A duplicated id in the hint is skipped, not honoured twice.** `free-models.json` is a hand-maintained
 * file; if one id is listed twice the value would appear twice in the dropdown, and a dropdown offering
 * the same model in two rows is a defect rather than a duplicate preference. The `Set` doubles as the
 * "have I placed this one already" mark, which is why it is kept from the first version.
 *
 * **Generic over the value, so the call site keeps its own type.** It is applied to `ConfigValue[]` and
 * the projection reads the result back, and a function that returned `ConfigValue[]` would make the one
 * future caller with a different value shape cast at the call site instead of here.
 */
export function freeModelFirst<T extends { readonly value: string }>(
  values: readonly T[],
  ids: readonly string[] = FREE_MODEL_IDS,
): T[] {
  // An empty hint is a no-op, and it is worth one line: without it the function would walk the list twice
  // on every rebuild of a 400-entry model list, for a caller that passed nothing.
  if (ids.length === 0) return [...values];
  const placed = new Set<string>();
  const first: T[] = [];
  for (const id of ids) {
    if (placed.has(id)) continue;
    placed.add(id);
    for (const value of values) if (value.value === id) first.push(value);
  }
  return [...first, ...values.filter((value) => !placed.has(value.value))];
}

// GENERATED from window.blp — do not edit. ADR 0088 says what these exports mean.
// Regenerate with `gjsify blueprint types`; `scripts/check-blueprint-sidecars.mjs` holds it.

import type Adw from 'gi://Adw?version=1';
import type Gtk from 'gi://Gtk?version=4.0';

/** The GtkBuilder XML this `.blp` compiles to. */
declare const xml: string;
export default xml;

/** The class `template $KurierMainWindow` defines. */
export declare const GTypeName: 'KurierMainWindow';

/**
 * Every id inside the template, in source order — what `registerClass` is given.
 *
 * A MUTABLE tuple, and the `readonly` is missing for a reason that is not ours: `@girs`
 * declares `GObject.MetaInfo['InternalChildren']` as `string[]`, so a `readonly` tuple is
 * refused at the call site with TS4104 and the consumer would have to spread it — the
 * boilerplate ADR 0088 exists to remove. The tuple still pins the exact ids and arity,
 * which is the property that matters. `status/open-todos/blueprint.md` carries the
 * upstream half.
 */
export declare const InternalChildren: [
    'split',
    'sidebarPage',
    'sidebarHost',
    'sidebarTitle',
    'contentPage',
    'contentStack',
    'transcriptHost',
    'contentHeader',
    'configHost',
    'composerHost',
];

/** The `_`-prefixed members GJS installs for them. Merge it into the class interface. */
export interface Children {
    _split: Adw.NavigationSplitView;
    _sidebarPage: Adw.NavigationPage;
    _sidebarHost: Adw.Bin;
    _sidebarTitle: Adw.WindowTitle;
    _contentPage: Adw.NavigationPage;
    _contentStack: Gtk.Stack;
    _transcriptHost: Adw.Bin;
    _contentHeader: Adw.HeaderBar;
    _configHost: Adw.Bin;
    _composerHost: Adw.Bin;
}

/**
 * The login dialog: draws `LoginController`'s state and passes the person's choices back.
 *
 * **Nothing here decides anything.** Which step comes next, what a missing field is, when the agent is
 * restarted — all of it is `core/login/controller.ts`, tested without a display. This file turns one
 * `LoginState` into widgets and a click into a controller call, so a step that is wrong shows up in a
 * unit test and not only on a screen.
 *
 * Every string that comes from the provider (a name, a field title, the instructions with the device
 * code, an error) goes into a label with `useMarkup: false` — a provider's text is not kurier's to trust
 * as markup. The dialog is one `Adw.Dialog` whose content is replaced on every state, which is why it has
 * no per-step teardown to get wrong.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import type { LoginController, LoginState } from '../../core/login/controller.ts';
import type { LoginField, LoginMethod, LoginProvider } from '../../core/login/providers.ts';

const CLAMP_PX = 420;

/** `selectable` only where a person copies something (the code, an error): a selectable label takes focus. */
function plainLabel(text: string, cssClasses: string[] = [], selectable = false): Gtk.Label {
  return new Gtk.Label({
    label: text,
    wrap: true,
    xalign: 0,
    useMarkup: false,
    selectable,
    cssClasses,
  });
}

function button(label: string, onClick: () => void, suggested = false): Gtk.Button {
  const widget = new Gtk.Button({
    label,
    cssClasses: suggested ? ['suggested-action', 'pill'] : ['pill'],
    halign: Gtk.Align.CENTER,
  });
  widget.connect('clicked', onClick);
  return widget;
}

export class LoginDialog {
  #dialog: Adw.Dialog | null = null;
  #controller: LoginController | null = null;
  #unsubscribe: (() => void) | null = null;
  #content: Gtk.Box | null = null;
  /** Read by `ready()`: the step the dialog is showing. A dev hook waits on it. */
  #step: LoginState['step'] = 'starting';

  get open(): boolean {
    return this.#dialog !== null;
  }

  get step(): LoginState['step'] {
    return this.#step;
  }

  show(parent: Gtk.Widget, controller: LoginController): void {
    if (this.#dialog) return;
    const dialog = new Adw.Dialog({ title: 'Log in', contentWidth: CLAMP_PX });
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      marginTop: 18,
      marginBottom: 24,
      marginStart: 18,
      marginEnd: 18,
    });
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    view.set_content(content);
    dialog.set_child(view);

    this.#dialog = dialog;
    this.#controller = controller;
    this.#content = content;
    this.#unsubscribe = controller.subscribe((state) => this.#render(state));
    dialog.connect('closed', () => {
      // The dialog going away is the cancel: the controller stops its server and settles the attempt.
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#dialog = null;
      this.#content = null;
      const closing = this.#controller;
      this.#controller = null;
      void closing?.close();
    });
    this.#render(controller.state);
    dialog.present(parent);
    void controller.open();
  }

  close(): void {
    this.#dialog?.close();
  }

  #clear(): Gtk.Box | null {
    const content = this.#content;
    if (!content) return null;
    let child = content.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      content.remove(child);
      child = next;
    }
    return content;
  }

  #render(state: LoginState): void {
    this.#step = state.step;
    const content = this.#clear();
    const controller = this.#controller;
    if (!content || !controller) return;
    switch (state.step) {
      case 'starting':
      case 'beginning':
        content.append(new Gtk.Spinner({ spinning: true, widthRequest: 32, heightRequest: 32 }));
        content.append(
          plainLabel(
            state.step === 'starting' ? 'Starting the login…' : `Contacting ${state.provider.name}…`,
          ),
        );
        return;
      case 'unavailable':
        content.append(plainLabel('Logging in from this window is not possible'));
        content.append(plainLabel(state.reason));
        content.append(button('Close', () => this.close()));
        return;
      case 'providers':
        this.#renderProviders(content, controller, state.providers);
        return;
      case 'methods': {
        content.append(plainLabel(`How do you want to log in to ${state.provider.name}?`));
        const group = new Adw.PreferencesGroup();
        for (const method of state.provider.methods) {
          const row = new Adw.ActionRow({
            title: method.label,
            subtitle:
              method.kind === 'key' ? 'Paste a key from the provider’s console' : 'Log in in the browser',
            activatable: true,
            useMarkup: false,
          });
          row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
          row.connect('activated', () => void controller.pickMethod(state.provider, method));
          group.add(row);
        }
        content.append(group);
        content.append(button('Back', () => void controller.showProviders()));
        return;
      }
      case 'fields':
        this.#renderFields(content, controller, state.provider, state.method, state.missing);
        return;
      case 'key':
        this.#renderKey(content, controller, state.provider);
        return;
      case 'waiting': {
        content.append(plainLabel(`Log in to ${state.provider.name}`, ['title-3']));
        if (state.prompt.instructions) content.append(plainLabel(state.prompt.instructions, [], true));
        content.append(
          new Gtk.LinkButton({
            uri: state.prompt.url,
            label: 'Open the login page',
            halign: Gtk.Align.START,
          }),
        );
        // The URL itself is not drawn: an OAuth URL is one unbreakable line of a few hundred characters
        // and widened the whole dialog past the window (measured, 1378 px in a 1024 px window). The link
        // opens it and Copy hands it to a browser on another machine.
        const copy = new Gtk.Button({
          label: 'Copy the link',
          halign: Gtk.Align.START,
          cssClasses: ['flat'],
        });
        copy.connect('clicked', () => {
          copy.get_clipboard().set(state.prompt.url);
          copy.set_label('Copied');
        });
        content.append(copy);
        if (state.prompt.mode === 'code') {
          const entry = new Adw.EntryRow({ title: 'Code from the page' });
          const go = (): void => controller.submitCode(entry.get_text());
          entry.connect('entry-activated', go);
          const group = new Adw.PreferencesGroup();
          group.add(entry);
          content.append(group);
          content.append(button('Continue', go, true));
        } else {
          const waiting = new Gtk.Box({ spacing: 12 });
          waiting.append(new Gtk.Spinner({ spinning: true }));
          waiting.append(plainLabel('Waiting until you are done in the browser…'));
          content.append(waiting);
        }
        content.append(button('Cancel', () => controller.cancel()));
        return;
      }
      case 'connected':
        content.append(plainLabel(`Logged in to ${state.provider.name}.`, ['title-3']));
        content.append(
          plainLabel('Send your prompt again; the agent has been restarted with the new login.'),
        );
        content.append(button('Done', () => this.close(), true));
        return;
      case 'failed':
        content.append(plainLabel('The login did not work', ['title-3']));
        content.append(plainLabel(state.message, [], true));
        content.append(button('Close', () => this.close()));
        return;
      case 'expired':
        content.append(plainLabel('The login ran out of time', ['title-3']));
        content.append(button('Try again', () => void controller.showProviders(), true));
        return;
      case 'closed':
        return;
    }
  }

  #providerRow(provider: LoginProvider, controller: LoginController): Adw.ActionRow {
    const ways = [
      ...new Set(provider.methods.map((method) => (method.kind === 'key' ? 'API key' : 'Browser login'))),
    ];
    const notes = [
      ...(provider.connected ? ['Logged in'] : []),
      ...(provider.europe ? ['Europe'] : []),
      ways.join(' · '),
    ];
    const row = new Adw.ActionRow({
      title: provider.name,
      subtitle: notes.join(' · '),
      activatable: true,
      useMarkup: false,
    });
    row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
    row.connect('activated', () => void controller.pickProvider(provider));
    return row;
  }

  /**
   * opencode's popular providers and the European ones first, everything else after, and a search over
   * both: the catalog is 200+ names long. The list scrolls inside the dialog so the search stays in view.
   */
  #renderProviders(content: Gtk.Box, controller: LoginController, providers: readonly LoginProvider[]): void {
    content.append(
      plainLabel('Use your own subscription, account or API key. kurier stores nothing: the agent keeps it.'),
    );
    const search = new Gtk.SearchEntry({ placeholderText: 'Search providers' });
    content.append(search);
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
    const entries: Array<{ row: Adw.ActionRow; haystack: string }> = [];
    const groups: Array<{ group: Adw.PreferencesGroup; rows: Adw.ActionRow[] }> = [];
    for (const [title, wanted] of [
      ['Popular', true],
      ['Other', false],
    ] as const) {
      const group = new Adw.PreferencesGroup({ title });
      const rows: Adw.ActionRow[] = [];
      for (const provider of providers.filter((candidate) => candidate.featured === wanted)) {
        const row = this.#providerRow(provider, controller);
        group.add(row);
        rows.push(row);
        entries.push({ row, haystack: `${provider.name} ${provider.id}`.toLowerCase() });
      }
      if (rows.length === 0) continue;
      groups.push({ group, rows });
      list.append(group);
    }
    search.connect('search-changed', () => {
      const query = search.get_text().trim().toLowerCase();
      for (const entry of entries) entry.row.set_visible(query === '' || entry.haystack.includes(query));
      for (const { group, rows } of groups) group.set_visible(rows.some((row) => row.get_visible()));
    });
    content.append(
      new Gtk.ScrolledWindow({
        child: list,
        hscrollbarPolicy: Gtk.PolicyType.NEVER,
        propagateNaturalHeight: true,
        // The floor matters in a small window: without it the dialog is squeezed to a one-row sliver.
        minContentHeight: 240,
        maxContentHeight: 380,
      }),
    );
    search.grab_focus();
  }

  #renderKey(content: Gtk.Box, controller: LoginController, provider: LoginProvider): void {
    content.append(plainLabel(`${provider.name}: API key`, ['title-3']));
    content.append(
      plainLabel(
        'Paste the key from the provider’s console. It goes to the agent, which stores it; kurier keeps nothing.',
      ),
    );
    const entry = new Adw.PasswordEntryRow({ title: 'API key' });
    const group = new Adw.PreferencesGroup();
    group.add(entry);
    content.append(group);
    const go = (): void => void controller.submitKey(provider, entry.get_text());
    entry.connect('entry-activated', go);
    const next = button('Continue', go, true);
    // Nothing to send until something is typed: a dead button would say nothing.
    next.set_sensitive(false);
    entry.connect('changed', () => next.set_sensitive(entry.get_text().trim() !== ''));
    content.append(next);
    content.append(button('Back', () => void controller.showProviders()));
    entry.grab_focus();
  }

  #renderFields(
    content: Gtk.Box,
    controller: LoginController,
    provider: LoginProvider,
    method: LoginMethod,
    missing: readonly LoginField[],
  ): void {
    content.append(plainLabel(`${provider.name}: ${method.label}`, ['title-3']));
    const group = new Adw.PreferencesGroup();
    const read: Array<() => [string, string]> = [];
    for (const field of missing) {
      if (field.options && field.options.length > 0) {
        const options = field.options;
        const row = new Adw.ComboRow({
          title: field.title,
          useMarkup: false,
          model: Gtk.StringList.new(options.map((option) => option.label)),
        });
        const at = Math.max(
          0,
          options.findIndex((option) => option.value === field.default),
        );
        row.set_selected(at);
        group.add(row);
        read.push(() => [field.key, options[row.get_selected()]?.value ?? '']);
      } else {
        const row = new Adw.EntryRow({ title: field.title, useMarkup: false });
        if (field.default) row.set_text(field.default);
        group.add(row);
        read.push(() => [field.key, row.get_text().trim()]);
      }
    }
    content.append(group);
    content.append(
      button(
        'Continue',
        () => void controller.submitFields(provider, method, Object.fromEntries(read.map((get) => get()))),
        true,
      ),
    );
    content.append(button('Back', () => void controller.showProviders()));
  }
}

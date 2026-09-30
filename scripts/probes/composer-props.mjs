#!/usr/bin/env -S gjs -m
/**
 * Which of the composer's GTK properties exist at runtime, and which the build cannot see?
 *
 * `composer.ts` avoids `Gtk.TextView:placeholder-text` and says why: the property is there on the GTK
 * this runs against and absent from the `@girs/gtk-4.0` typings the repo compiles against. That is a
 * claim about two versions of two things, and it drifts — the next `gjsify install` can move either
 * side of it. This prints both sides, so a reader can re-check instead of believing, and so a version
 * bump that makes the property typed shows up here rather than as a silent behaviour change.
 *
 *   gjs -m scripts/probes/composer-props.mjs
 *
 * It also prints the icon names the composer uses, through the same `Gtk.IconTheme.has_icon` the
 * comments claim — `icon-names.mjs` is the wider list.
 */
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

Adw.init();

/** Set a property by name and report what came back, without a `find_property` call that does not exist. */
function trySet(label, target, property, value) {
  try {
    target[property] = value;
    print(`  ${label}: set -> ${JSON.stringify(target[property])}`);
  } catch (error) {
    print(`  ${label}: THROWS ${error.message}`);
  }
}

print(`GTK ${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`);

print('\nGtk.TextView (the property composer.ts does NOT use, and why):');
const textView = new Gtk.TextView();
trySet('placeholder-text', textView, 'placeholder_text', 'Message to the agent…');
trySet('show-placeholder', textView, 'show_placeholder', true);

print('\nGtk.ScrolledWindow (the bounds that ARE typed in @girs/gtk-4.0 4.6.0, and are used):');
const scroller = new Gtk.ScrolledWindow();
trySet('min-content-height', scroller, 'min_content_height', 56);
trySet('max-content-height', scroller, 'max_content_height', 180);
trySet('propagate-natural-height', scroller, 'propagate_natural_height', true);

print('\nAdw.Clamp:');
const clamp = new Adw.Clamp({ maximum_size: 720, tightening_threshold: 720 });
print(`  maximum-size: ${clamp.maximum_size}, tightening-threshold: ${clamp.tightening_threshold}`);

print('\nGdk key values the Enter-to-send handler compares against:');
print(`  KEY_ISO_Enter: ${Gdk.KEY_ISO_Enter}, KEY_KP_Enter: ${Gdk.KEY_KP_Enter}`);
print(`  SHIFT_MASK: ${Gdk.ModifierType.SHIFT_MASK}`);

print('\nIcons used by the composer (a MISSING name renders as a broken-image placeholder):');
const display = Gdk.Display.get_default();
if (!display) throw new Error('no display — this probe needs a session bus; run it from the desktop');
const theme = Gtk.IconTheme.get_for_display(display);
for (const name of ['mail-send-symbolic', 'process-stop-symbolic', 'send-symbolic']) {
  print(`  ${theme.has_icon(name) ? 'ok     ' : 'MISSING'} ${name}`);
}

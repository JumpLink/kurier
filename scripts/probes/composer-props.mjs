#!/usr/bin/env -S gjs -m
/**
 * Which of the composer's GTK properties exist at runtime, and which the build cannot see?
 *
 * `composer.ts` draws its placeholder as a label over the entry, because `Gtk.TextView` has no
 * `placeholder-text` property. This probe is what answers that, and the shape of the answer is the
 * point: **ask `GObject.Object.find_property`, never an assignment.** The first version of this file
 * set `textView.placeholder_text` and read the value back — and in GJS an assignment to a name that is
 * not a GObject property quietly creates a plain JS field, so that probe returned the string it had
 * just stored, for any name at all. It reported the property as present, `composer.ts` wrote a comment
 * saying so, and the window had no placeholder for as long as both were believed.
 *
 *   gjs -m scripts/probes/composer-props.mjs
 *
 * It also prints the icon names the composer uses, through the same `Gtk.IconTheme.has_icon` the
 * comments claim — `icon-names.mjs` is the wider list.
 */
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

Adw.init();

/**
 * Does this class really have this GObject property?
 *
 * `GObject.Object.find_property` called against the instance's constructor: GJS puts the class method
 * there, and it answers with a `ParamSpec` or with `null`. A `null` is the whole reason this file
 * exists — see the header on the assignment that cannot say it.
 */
function hasProperty(label, target, property) {
  let spec = null;
  try {
    spec = GObject.Object.find_property.call(target.constructor, property);
  } catch (error) {
    print(`  ${label}: find_property THROWS ${error.message}`);
    return;
  }
  print(`  ${spec ? 'present' : 'ABSENT '} ${label}`);
}

print(`GTK ${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`);

print('\nGtk.TextView (the properties composer.ts does NOT use, and why):');
const textView = new Gtk.TextView();
hasProperty('placeholder-text', textView, 'placeholder-text');
hasProperty('show-placeholder', textView, 'show-placeholder');
print('  the control, on the widget the name comes from:');
hasProperty('placeholder-text (Gtk.Entry)', new Gtk.Entry(), 'placeholder-text');
print('  and two that are used, so an all-ABSENT run reads as a broken probe:');
hasProperty('wrap-mode', textView, 'wrap-mode');
hasProperty('left-margin', textView, 'left-margin');

print('\nGtk.ScrolledWindow (the bounds that ARE typed in @girs/gtk-4.0 4.6.0, and are used):');
const scroller = new Gtk.ScrolledWindow();
hasProperty('min-content-height', scroller, 'min-content-height');
hasProperty('max-content-height', scroller, 'max-content-height');
hasProperty('propagate-natural-height', scroller, 'propagate-natural-height');

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
for (const name of ['go-up-symbolic', 'process-stop-symbolic', 'arrow-up-symbolic']) {
  print(`  ${theme.has_icon(name) ? 'ok     ' : 'MISSING'} ${name}`);
}

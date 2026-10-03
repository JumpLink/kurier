/**
 * The `.blp` module shape, for `tsc`.
 *
 * **`declare module "*.blp"` in a file with no top-level `import`/`export`**, which is why this file
 * has no `export {}` at the end: a module-augmentation `declare module` only applies to modules
 * *inside* that module's scope, so a wildcard pattern in a module file matches nothing and the
 * import fails with TS2307. In a script file it is a global ambient declaration and matches every
 * `.blp` in the program.
 *
 * The value is a **compiled GtkBuilder XML string, not markup** — `@gjsify/vite-plugin-blueprint`
 * runs the Blueprint compiler in the build, so what reaches `GObject.registerClass({ Template })` is
 * the same thing a `.ui` file would have produced. That is why the type is `string` and nothing
 * more: there is no Blueprint AST at run time to describe.
 */
declare module '*.blp' {
  const content: string;
  export default content;
}

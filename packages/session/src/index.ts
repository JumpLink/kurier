/**
 * `@kurier/session` — what a session is, and where the records live.
 *
 * The model, the transcript and the store. No ACP client, no agent adapter, no `gi://`, and no
 * opinion about where the file belongs: the store takes a path, the app resolves XDG, a test
 * passes a temp directory.
 */

export * from './model.ts';
export * from './store.ts';

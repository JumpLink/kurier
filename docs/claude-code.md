# Claude Code as a second agent

Status: **decided, not built.** Claude Code is offered next to opencode, through an ACP adapter
(Zed's `claude-agent-acp`, which wraps the Claude Agent SDK). Checked 2026-10-04 against Anthropic's
"Legal and compliance" page for Claude Code; re-read it before building, it has changed three times
this year.

## Why not through opencode

opencode removed its Claude Pro/Max login on 2026-03-19 (PR #18186, after a legal request), and
Anthropic rejects those tokens server-side since January. A Claude subscription is therefore not
reachable through opencode at all. Only an API key is.

## What the terms say

- An end user may sign in to the **unmodified Claude Code binary** with their own subscription, also
  where a platform hosts it.
- A developer may not offer Claude.ai login in their own app, route requests through Free/Pro/Max
  credentials on the user's behalf, or collect, store or intermediate Claude.ai credentials. Sign-in
  must complete through Anthropic's own flow.
- Products built on the Agent SDK are pointed at API-key authentication.
- Preinstalling or running Claude Code inside a product needs the Commercial Terms, and the binary
  must stay unmodified.

## The grey zone, accepted

The adapter sits on the Agent SDK, and the page does not say whether a user with a subscription is
then "in the unmodified Claude Code" or in Agent SDK use. Zed's own docs leave it at "authenticate
with Claude Code where supported". The decision (2026-10-04) is to accept that risk. It is not legal
advice, and nothing here is promised to users: ask Anthropic before advertising it.

## Rules for the adapter

1. **Host install only, never bundled.** Same order as every agent: the person's own copy. Bundling
   needs the Commercial Terms.
2. **No Claude login in kurier.** Kurier shows "sign in with `claude` in a terminal", exactly like
   `lotse auth`. It never opens, proxies or stores a Claude flow. This also rules out a
   provider-connect screen for Claude, whatever the screen for other providers becomes.
3. **API key is the documented way,** a subscription is the person's own choice.
4. **Say it in plain text.** "Runs Claude Code" is allowed; the name or logo in kurier's own name or
   logo is not.

## Open: billing

Sources disagree on whether, since 2026-06-15, Agent SDK and third-party use is metered from a
separate credit pool at API rates instead of the subscription limits (one report says Anthropic
shelved the split before it took effect). Unresolved. If the split applies, a subscriber gets a small
monthly credit through kurier, not their full plan, and the "use your own subscription" pitch does
not hold. Measure it with a real account before building the user-facing text.

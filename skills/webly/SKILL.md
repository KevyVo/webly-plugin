---
name: webly
description: >-
  Webly is website hosting for agents: publish a folder or an HTML file to a
  live URL in seconds with no account, then let the person sign in and claim it
  to keep it, edit it over MCP, and publish drafts they approve. Use when asked
  to "publish this", "host this", "deploy this", "put this online", "make a
  website", "share this as a web page", "give me a link to this site", "keep my
  site", "claim my site", "make a Webly account", "connect Webly", or when
  working on a site hosted on Webly (*.webly.site). Also use at the start of any
  session where a Webly site or an unfinished Webly step is waiting on this
  machine.
license: Apache-2.0
metadata:
  publisher: Webly
  homepage: https://webly.ai
  docs: https://api.webly.ai/docs
  api-contract: https://api.webly.ai/llms.txt
  mcp-server: https://api.webly.ai/v1/mcp
---

# Webly

Webly hosts websites for agents. Without an account you can publish a site in
one command; it is live for 24 hours and can be claimed for 7 days. Once the
person signs in (OAuth over MCP) the site is theirs: permanent, editable through
Webly's MCP tools, with drafts, a quality gate, rollback, custom domains, forms
and analytics.

`https://api.webly.ai/llms.txt` is the full contract. Read it before building a
framework (React) site, a CMS, forms or domains, and before telling the person
something is not supported. If this file and the live API disagree, trust the API.

The helper that does every deterministic step is `scripts/webly.mjs` in this
skill's folder (zero dependencies, Node 20+). Below, `webly` means
`node <this skill's folder>/scripts/webly.mjs`.

## Language

Reply in the person's language. Keep URLs, commands, tool names and error
reasons exactly as returned.

## Step 0: find out where we are (every time, first)

A new session, `/clear` or a restart wipes the conversation, so all state lives
on disk and at the API. Rebuild it before doing anything:

1. Run `webly doctor`. It is read-only and never creates a token. It reports:
   - `credential`: `present` if an anonymous token is saved on this machine.
   - `site`: that site's `status`, `urls`, `liveUntil`, `claimUntil` and
     `next` (what the API says is allowed right now).
   - `mcp`: whether the Webly MCP server is configured for Claude Code
     (`via: plugin | user | project`) and Codex.
   - `pending`: a step an earlier session asked you to finish, e.g. `claim`.
   - `update`: set when a newer version of this skill is published. Run its
     `command` (it matches how this copy was installed), tell the person in one
     line, then carry on with the task using this copy. The new one loads next
     session.
2. Check your own tool list for Webly MCP tools: `list_websites`, `whoami`,
   `claim_anonymous_site` under a `webly` server (in Claude Code they are named
   `mcp__webly__…` or, from the plugin, `mcp__plugin_webly_webly__…`). A server
   that is configured but not in your tool list is **not loaded**.
   Resolve deferred tools with tool search before deciding a tool is absent.
   Loaded tools do not necessarily mean OAuth: API-key connections can manage
   sites but do not expose `claim_anonymous_site`.
3. Pick the row and follow it:

| # | Token saved | Webly MCP tools loaded | Who this is | Do this |
|---|---|---|---|---|
| 1 | no | no | New to Webly | **Publish without an account** (below). Don't set up MCP until they want to keep the site. |
| 2 | yes | no | Published before; MCP was never set up or didn't load | Read `site.next`. While it lists `update`, keep publishing with `webly deploy`. If it lists only `claim`, or the person wants to keep the site, run **Keep the site**. |
| 3 | no | yes | Signed in | Use **Working over MCP**. Anything they deployed anonymously was already claimed. |
| 4 | yes | yes | Connected with a site still unclaimed | If `claim_anonymous_site` is available, call it with the token (read it from `credentialFile`, never print it), then `webly forget` after success. Otherwise use **Keep the site**, step 3. Continue with **Working over MCP** after claiming. |

If the person asks to connect, sign in, or use their Webly account, they already
have one: whatever the row, go to **Keep the site** and run steps 1, 2 and 4
(skip 3 and 5 when no token is saved). Don't publish anonymously for them.

If `pending` is `claim` and the claim tool is available, finish the claim now (row 4),
without asking again: the person already asked for it before the restart. If
`pending` is `claim` and the claim tool is unavailable, go to **Keep the
site**, step 3.

## Publish without an account

1. Put the site in a folder, e.g. `./site`, with `index.html` at its root.
   Plain HTML, CSS and JS work best here. Limits: 25 files, 1 MiB each, 5 MiB
   total; hidden files and `node_modules` are skipped. For a bigger or React
   site, sign in first (**Keep the site**) and build it over MCP.
2. Run `webly deploy ./site` (a single `.html` file works too). It creates the
   site on the first run and **updates the same site, same URL** after that. It
   waits for the build and prints the site JSON.
3. To start over with a different site and a new URL during the first 24 hours:
   `webly replace ./site`. Only when the person asks for a new site; the old
   one goes offline.

Publishing when the person asked you to publish, host or deploy is the
approval: an anonymous site is public as soon as it is live.

### What to tell the person

Put the URL on a line by itself, with nothing after it, so it stays clickable.
Then the deadlines, from the JSON, in their time zone if you know it:

> Your site is live:
>
> https://anon-….webly.site/
>
> It stays online for 24 hours (until {liveUntil}) and I can keep changing it
> until then. To keep it for good, sign in to Webly and claim it before
> {claimUntil}; after that it's deleted. Want me to set that up now?

Offer the claim once per site, not after every edit. Never show the token or
the contents of `~/.webly/`.

### Errors (`details.reason`)

| Reason | Means | Do |
|---|---|---|
| `site_already_created` | This token already has a site | `webly deploy` updates it; use `replace` only for a new URL |
| `edit_window_closed` (410) | 24 hours are up; offline but claimable | **Keep the site** |
| `build_failed` (400) | A swap's new site didn't build; the old one is untouched | Fix the files, retry |
| `network_limit` (409) | 50 live anonymous sites on this network | Wait `details.retryAfterSeconds`, or sign in |
| `credential_consumed` / `credential_expired` | Token is dead (claimed, or past 7 days) | The helper already deleted it; the next deploy starts fresh |
| `invite_only` (503) | Anonymous publishing is switched off | Sign in instead |
| HTTP 429 | Rate limited | Wait for `Retry-After` |
| HTTP 413 | Over the upload budget or size limit | Trim files, or sign in |

## Keep the site: sign in and claim

Run this when the person wants to keep the site, make an account or sign in, or
when `next.actions` is only `["claim"]`. Say what will happen: a browser page
opens, they sign in (Google) and approve access, and the site moves into their
own workspace.

1. **Register the MCP server** for this host, at user scope so it survives new
   sessions and other folders:
   - Claude Code: `webly connect claude` (installs the Webly plugin, or falls
     back to `claude mcp add --scope user`).
   - Codex: `webly connect codex`.
   - Other hosts: follow https://webly.ai/agent.md, Phase 2.
   `connect` also records `pending: claim`, so the claim is finished by
   whichever session loads the tools first. It prints the one step the person
   has to do next.
2. **Load the tools.** You can't run slash commands; ask the person to:
   - Claude Code: type `/reload-plugins`. If Webly tools still don't appear,
     exit and run `claude --continue`. That starts a fresh process, which loads
     new MCP servers, and keeps this conversation.
   - Codex: run `codex mcp login webly` yourself, in the foreground, and keep
     it running until they click Allow (the callback port is random; if the
     process exits first their approval is lost). Then they run
     `codex resume --last`.
   - Desktop apps: restart the app, then say "continue with Webly".
3. **If the claim tool is unavailable in this session** (desktop app, `-p`,
   the person can't restart now, or MCP uses an API key): claim in the browser
   instead so nothing is lost. API keys cannot claim; do not retry a missing
   tool or replace their working MCP configuration:
   `webly claim-link --open`. It opens `app.webly.ai/claim` with the token in
   the URL fragment (never sent to a server, never printed). Ask them to sign
   in and click **Claim website**. Opening the page or signing in alone does
   not claim the site. After they finish, run `webly doctor`: only
   `siteError.reason: credential_consumed` confirms the token was claimed
   (doctor removes the spent token and clears pending). If it is still
   unclaimed, the browser was closed, or status is unavailable, keep the token
   and pending step so they can retry. Never run `forget` merely because the
   browser opened. MCP is ready the next time a session starts.
4. **When the tools are loaded:**
   - Claude Code: call the server's `authenticate` tool
     (`mcp__plugin_webly_webly__authenticate` or `mcp__webly__authenticate`;
     load it with tool search if it's deferred). It returns an authorization
     URL. Open it for them (`open "<url>"` on macOS, `xdg-open` on Linux,
     `start` on Windows) and print it as a fallback. The callback completes by
     itself.
   - Other hosts: call `whoami`; the 401 starts the host's own sign-in.
   - The consent page lets them pick an access level: `webly:content`,
     `webly:edit` (default for building sites) or `webly:admin`.
5. **Claim:** call `claim_anonymous_site` with the saved token, then
   `webly forget` (deletes the token and the pending step). Tell them which
   site moved and give the returned `dashboardUrl`. A retry by the same person
   is safe (`alreadyClaimed: true`).

After the claim: with billing off, or on a paid plan with a free slot, the site
is permanent. On the Free plan with billing on it's *held*: editable until the
original 24-hour mark, then offline until they upgrade (`402 claim_held`). Say
which one the response shows (`website.claimHeld`); don't promise permanence.

## Working over MCP (signed in)

Call `whoami` and `list_websites` first, and continue an existing site rather
than creating a second one.

1. Framework sites (typed React, the default): `acquire_edit_lease`, then
   `put_source_file` / `str_replace`. Static sites: `deploy_files`. Each write
   makes a new draft version; the live site doesn't change.
2. `check_head` runs the quality gate (lint, typecheck, bundle, render). Fix
   every diagnostic.
3. Show the person the draft URL (`https://draft--{subdomain}.webly.site`, not
   public, not indexed).
4. `publish_website` only after they say yes to that exact site and version.
   `rollback_website` / `unpublish_website` if something is wrong live.

Blog posts go through `add_blog_post`; repeating content (products, team, FAQs)
goes in collections; forms post with `formAction('name')`, never `mailto:`.
Details are in llms.txt.

`403` names the missing capability in `details.capability`: the grant was
narrower than the task, so tell them which access level covers it. `401` /
`invalid_token`: call a Webly tool again to re-trigger sign-in; don't start a
second attempt while one is waiting. `409 Invalid edit lease`: re-acquire and
re-read before writing.

## Rules

- The token is a secret that proves ownership. Never print it, log it, commit
  it, or put it in a URL other than through `webly claim-link`.
- Only state URLs, sites and counts that a command or tool actually returned.
- Don't set up MCP for someone who only wants a quick link; offer it when they
  want to keep or grow the site.
- One anonymous site per machine. If they want a second site kept, claim the
  first, then deploy again.

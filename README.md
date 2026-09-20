# Webly plugin for Claude Code

Build, preview and publish websites on [Webly](https://webly.ai) from Claude Code.
Ships the hosted Webly MCP server plus a skill that teaches Claude the safe
workflow: write source → run the quality gate → show you a private draft →
publish only after you say yes.

## Install

```shell
/plugin marketplace add KevyVo/webly-plugin
/plugin install webly@webly
```

Then connect — Claude opens a consent page where you pick an access level:

| Scope | Role | What the agent may do |
| --- | --- | --- |
| `webly:content` | `content_editor` | Read sites and pages; create, update and publish CMS items and blog posts; upload assets |
| `webly:edit` | `full_editor` | The above plus source files, deploys, publish / rollback / unpublish, CMS schema, domains |
| `webly:admin` | `admin` | The above plus create/rename/delete websites, manage API keys, read the audit log |

`tools/list` only returns the tools your granted role can call.

No browser on this machine (server, container, CI)? Create a key at
[app.webly.ai/dashboard/keys](https://app.webly.ai/dashboard/keys) and add a
user-scope server instead:

```bash
claude mcp add --scope user --transport http \
  --header "Authorization: Bearer wb_your_key" \
  webly-key https://api.webly.ai/v1/mcp
```

Restart Claude Code afterwards, and disable the plugin's `webly` server so the
two don't both answer. The key is a secret — keep it out of version control.

## What you can ask for

- "Make me a coffee-shop site called Kuro Coffee" — Claude writes typed React
  source, runs the gate, and sends a draft link.
- "Add a blog post about our new espresso machine" — lands in a CMS collection
  you can edit yourself in the dashboard.
- "Publish it" / "roll that back" / "take it offline".
- "Point kurocoffee.com at it" — Claude returns the exact DNS records; you
  publish them, Claude verifies.
- "Add a contact form" — submissions land in your dashboard, not a third party.

Nothing goes public without an explicit yes from you. Drafts are `noindex,
no-store`, every write is a new version, and publish/rollback are pointer moves,
so nothing destroys history. Manage everything at
[app.webly.ai/dashboard](https://app.webly.ai/dashboard) — including an Activity
log of exactly what the agent did.

## Contents

```
.claude-plugin/marketplace.json     marketplace manifest
plugins/webly/
  .claude-plugin/plugin.json        plugin manifest
  .mcp.json                         Webly MCP server (https://api.webly.ai/v1/mcp)
  skills/webly-connect/SKILL.md     connect + working loop
```

The full tool and endpoint reference lives at
[api.webly.ai/llms.txt](https://api.webly.ai/llms.txt).

## Development

```bash
claude plugin validate .
/plugin marketplace add ./path/to/webly-plugin   # test locally
```

## License

Apache-2.0

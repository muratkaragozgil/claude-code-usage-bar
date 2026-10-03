# Privacy Policy

**Usage Bar for Claude Code** (the `usage-bar` plugin). Effective October 3, 2026.

This policy explains what the plugin reads, where it sends requests, and what it keeps. The plugin is open source, so you can check every statement here against [`hooks/register.tsx`](hooks/register.tsx).

## What the plugin reads

- **From Claude Code, on your machine:**
  - The 5-hour and weekly plan-limit percentages and their reset times.
  - The session's cost.
  - The token counts of each turn: input, output, cache read and cache write.
- **From Anthropic's usage endpoint:** your plan's usage limits, including per-model weekly limits, with their percentages and reset times.

The plugin never reads the content of your conversation: no prompts, replies, files, memory or chat history.

## Where it sends requests

The plugin's only network request is `GET https://api.anthropic.com/api/oauth/usage`, made when a session starts, every five minutes, and when a limit moves, at most once a minute.

The request goes to Anthropic, the same provider Claude Code already talks to. It is authenticated with Claude Code's own credential through an opaque handle (`$.session.authorize()`), so the plugin never sees your token. The request has no body.

The plugin sends nothing to any other service. It has no analytics, telemetry or tracking.

## What it keeps

Everything the plugin reads lives in Claude Code's in-memory session state and is discarded when the session ends. The plugin writes no files and keeps nothing between sessions. Your show/hide choice from `/usage-bar` also lasts for the session only.

## Children

The plugin is a developer tool and is not directed at people under 18.

## Changes

Changes to this policy are published in this repository with a new effective date. The commit history is the record of every version.

## Contact

Questions about this policy go to [GitHub Issues](https://github.com/MuratKaragozgil/claude-code-usage-bar/issues). For anything sensitive, use the private channel described in [SECURITY.md](SECURITY.md).

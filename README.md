# Usage Bar for Claude Code

A one-line usage bar above the Claude Code prompt. It keeps your plan limits in view (the 5-hour window, the weekly window, and per-model weekly limits such as Fable), each with its reset countdown, next to the tokens and cost of the current session.

![The usage bar above the Claude Code prompt, dark theme](docs/screenshot.png)

## What it shows

| Item | Meaning |
| --- | --- |
| `5h ▬ 26% · 2h 16m` | 5-hour plan limit: share used, time until it resets |
| `7d ▬ 28% · 4d 2h` | Weekly limit across all models |
| `Fable ▬ 12% · 4d 2h` | A per-model weekly limit, shown when your plan has one |
| `↑ 1.2k` | Input tokens this session (the part not served from the prompt cache) |
| `↓ 26.1k` | Output tokens this session |
| `⟲ 5.00M` | Prompt-cache tokens this session (read + written) |
| `$ 4.87` | Session cost at API prices, the same figure `/cost` shows |

The bar stays on a single line at any width. When space runs out it drops the least useful parts first: the per-model countdown, the weekly countdown, cache, input and output tokens, the 5-hour countdown, then cost. The bars and percentages always stay.

## Install

You need Claude Code **2.1.287 or newer**; mods are on by default from that version.

Run these two commands in a terminal:

```bash
claude plugin marketplace add MuratKaragozgil/claude-code-usage-bar
claude plugin install usage-bar@claude-code-usage-bar
```

Then start a new Claude Code session. The bar appears above the prompt, in the terminal and in the Code tab of the Claude desktop app.

You can also install from inside a terminal Claude Code session:

```text
/plugin marketplace add MuratKaragozgil/claude-code-usage-bar
/plugin install usage-bar@claude-code-usage-bar
/reload-plugins
```

## Use

There is nothing to configure. Type `/usage-bar` to hide the bar, and again to bring it back.

The plan limits need a claude.ai login (Pro, Max, Team or Enterprise). Signed in with an API key, the bar shows tokens and cost only.

## Update or remove

```bash
claude plugin marketplace update claude-code-usage-bar
claude plugin update usage-bar@claude-code-usage-bar
```

```bash
claude plugin uninstall usage-bar@claude-code-usage-bar
claude plugin marketplace remove claude-code-usage-bar
```

## How it works

The plugin is a [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/): one readable TypeScript module of function hooks, [`hooks/register.tsx`](hooks/register.tsx).

Each hook, and what it does with what it sees:

| Hook | What it does |
| --- | --- |
| `session.start` | Reads the session's usage figures from Claude Code and registers the `/usage-bar` command. Starts a timer that moves the countdowns every 30 seconds and refreshes the plan limits every five minutes, the first time right after the session starts. Passes the event on unchanged. |
| `session.measure` | Copies the 5-hour and weekly percentages, their reset times and the session cost into the bar. Passes the event on unchanged. |
| `turn.complete` | Adds the turn's token counts to the session totals, subagent turns included. It reads only the counts, never the text of the turn. Passes the event on unchanged. |
| `session.end` | On `/clear`, sets the token totals back to zero. Passes the event on unchanged. |
| `command.run` | Matches only `/usage-bar`, which it answers by hiding or showing the bar. It never sees, runs or changes any other command. |
| `ui.render` | Matches only the `AbovePrompt` site, where it draws the bar: SVG bars on the desktop, text bars in the terminal. It leaves the rest of the screen to Claude Code. |

## What it fetches, sends and runs

- **Fetches:** `GET https://api.anthropic.com/api/oauth/usage`, Anthropic's endpoint behind the desktop app's usage card and `/usage`. It returns the plan's usage limits, including the per-model weekly ones that the API's rate-limit headers don't carry.
  - **When:** when a session starts, every five minutes, and when a limit moves, at most once a minute.
  - **Credential:** the request carries Claude Code's own credential through `$.session.authorize()`. That call returns an opaque handle, so your token never reaches the plugin.
- **Sends:** only that request, which has no body. None of what the plugin reads (usage figures, token counts, cost) leaves your machine, and nothing goes to any other host.
- **Runs:** nothing. No processes, shell commands, tools, agents or MCP calls. It installs no packages and writes no files.
- **Keeps:** everything it reads stays in Claude Code's memory for the session and is discarded when the session ends.

The full privacy policy is in [PRIVACY.md](PRIVACY.md).

The endpoint is undocumented and may change. If it fails, the 5-hour and weekly bars keep working from the session's own data, and a single line in the transcript says why the per-model limits are missing.

## Troubleshooting

- **The bar doesn't appear.** Check `claude --version` (2.1.287 or newer) and that `claude plugin list` shows `usage-bar@claude-code-usage-bar` as enabled. Then start a new session; a running session doesn't pick up a new install. If you typed `/usage-bar` earlier, the bar is hidden, so type it again.
- **No 5h or 7d bars.** You're signed in with an API key, where plan limits don't apply. Or the session hasn't had a reply yet and the usage endpoint was unreachable; the bars appear after the first reply.
- **No per-model bar (Fable).** Your plan may have no per-model limit right now. Otherwise, look for a transcript line starting `usage-bar: per-model limits unavailable`:
  - `answered 401`: sign in again with `/login`.
  - `answered 429`: the plugin waits ten minutes and tries again.
  - `signed in with an API key`: per-model limits apply to claude.ai plans only.
- **Countdowns or token counts are missing.** The window is too narrow, so the bar dropped them to stay on one line. Widen the window.

## Support

Report bugs and ask questions in [GitHub Issues](https://github.com/MuratKaragozgil/claude-code-usage-bar/issues). For security concerns, see [SECURITY.md](SECURITY.md).

## Development

```bash
git clone https://github.com/MuratKaragozgil/claude-code-usage-bar
cd claude-code-usage-bar
claude --plugin-dir .                       # load it from disk for one session
claude plugin validate --strict ./.claude-plugin/plugin.json
claude plugin test .
```

The tests mount the band on the terminal and desktop surfaces, with the usage endpoint answering and refusing, at a wide and a narrow width. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes, along with the API's type declarations, the first time it loads the plugin from your folder.

```text
.claude-plugin/plugin.json        the plugin manifest
.claude-plugin/marketplace.json   makes this repository a one-plugin marketplace
hooks/hooks.json                  points Claude Code at the module
hooks/register.tsx                the whole mod
types/index.d.ts                  the types of the values it keeps in $.state
tests/render.test.ts              claude plugin test suite
```

## License

[MIT](LICENSE). This is a community project, not affiliated with or endorsed by Anthropic.

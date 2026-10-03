# usage-bar

The plugin behind [Claude Code Usage Bar](../../README.md): a one-line row above the prompt with the 5-hour, weekly and per-model plan limits, their reset countdowns, and the session's tokens and cost.

Install it from the marketplace this repository defines:

```bash
claude plugin marketplace add MuratKaragozgil/claude-code-usage-bar
claude plugin install usage-bar@claude-code-usage-bar
```

Work on it from a clone:

```bash
claude --plugin-dir ./plugins/usage-bar
claude plugin validate --strict ./plugins/usage-bar
claude plugin test ./plugins/usage-bar
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. Claude Code writes that file, along with the API's type declarations, the first time it loads the plugin from your folder. It stays out of git.

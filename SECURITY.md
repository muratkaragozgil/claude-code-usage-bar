# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue. Use [Report a vulnerability](https://github.com/MuratKaragozgil/claude-code-usage-bar/security/advisories/new) under this repository's **Security** tab. GitHub delivers the report to the maintainer only.

Include what you found, how to reproduce it, and the plugin version from `.claude-plugin/plugin.json`. You will get a reply within a few days.

## Supported versions

Only the latest release receives fixes. Update with:

```bash
claude plugin marketplace update claude-code-usage-bar
claude plugin update usage-bar@claude-code-usage-bar
```

## What the plugin can do

The plugin is a single readable TypeScript module, [`hooks/register.tsx`](hooks/register.tsx). It runs no scripts, starts no processes, installs no packages and writes no files. Its only network request is to Anthropic's usage endpoint, as [PRIVACY.md](PRIVACY.md) describes.

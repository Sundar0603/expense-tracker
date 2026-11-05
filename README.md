# Expense Tracker

A local-first Mac app that tracks personal spending from an HDFC Bank savings account.
Transactions come from HDFC's alert emails (read from Gmail over IMAP) and from statement
files; cash spends are added by hand. Everything lives in a SQLite file on your Mac.

Features: automatic sync on open or on demand · traceless delete · categories and rules
(ignore Zerodha, auto-categorize Swiggy…) · weekly/monthly budgets with pace and in-app
alerts · insights charts · statement import (XLS/CSV/PDF) · provider-agnostic AI assistant
(Ollama, LM Studio, OpenRouter, Groq, OpenAI, Anthropic, any OpenAI-compatible URL) ·
CSV export · encrypted backups.

## Setup

1. **HDFC alerts**: NetBanking → InstaAlerts → enable email alerts for every debit type
   (UPI, debit card, NEFT/IMPS, SI/ACH, ATM). Alerts come from `alerts@hdfcbank.net`.
2. **Gmail**: enable IMAP in Gmail settings, then under *Settings → Gmail* click **Sign in with Google**
   (one-time Google Cloud setup in [docs/gmail-oauth-setup.md](docs/gmail-oauth-setup.md), no 2-Step
   Verification needed). If you already use 2-Step Verification, an app password works too.
   They are stored encrypted in the macOS Keychain.
3. **AI (optional)**: install [Ollama](https://ollama.com) and `ollama pull qwen2.5:7b` for a
   free local model, or add an OpenRouter/OpenAI/Anthropic key under *AI assistant → Provider*.

## Development

```bash
npm install          # also rebuilds better-sqlite3 for Electron
npm run dev          # hot-reloading dev build
npm test             # vitest: parsers, rules, periods, database
npm run typecheck
npm run package      # unsigned .app in dist/mac-arm64/
```

Useful env vars while developing: `ET_USER_DATA=<dir>` points the app at a scratch data
directory; `ET_SCREENSHOT_DIR=<dir> ET_ROUTES=/,/transactions` captures screenshots and quits;
`ET_AI_SMOKE=<file.json>` runs the AI pipeline once and writes the result.

## Parser samples

Drop redacted HDFC alert emails and statement headers in `docs/samples/` (git-ignored) and
extend `tests/hdfc-email.test.ts` / `tests/hdfc-statement.test.ts`. Unparsed alerts never
disappear: they land in *Transactions → Needs review*.

## Privacy notes

- Deleting a transaction hard-deletes the row with SQLite `secure_delete`, keeps only a salted
  hash so re-sync won't re-import it, and can optionally trash the alert email in Gmail.
- The AI assistant sends aggregates only by default; switch to *Allow transaction rows* if you
  want row-level answers. With a local model nothing leaves the Mac.
- Time Machine snapshots of `~/Library/Application Support/expense-tracker/` will still hold
  deleted rows; exclude that folder if that matters to you.

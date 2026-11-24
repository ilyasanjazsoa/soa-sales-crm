# Security Of America Sales CRM: build kit for Claude Code

Everything Claude Code needs to build the sales CRM for 5 account executives and a sales manager.

## What's here

| File | What it is |
|---|---|
| `CLAUDE.md` | The standing rules Claude Code reads at the start of every session |
| `docs/ARCHITECTURE.md` | The specification: scope, technology, data, AI, email, meetings, proposals, security, hosting, testing |
| `docs/DATA_MODEL.sql` | The database schema (24 tables; loads cleanly on PostgreSQL 16) |
| `docs/API.md` | Every route and every configuration variable |
| `docs/MILESTONES.md` | Nine build steps, each with the prompt to paste and the checks that prove it works |
| `docs/DECISIONS.md` | Choices already made, and 12 questions the company must answer |
| `docs/LAUNCH_CHECKLIST.md` | What the company has to do that software can't |
| `reference/sales-demo.jsx` | The sales screens from the demo, as the visual and wording reference |
| `.claude/settings.json` | Stops Claude Code from reading secret files |

## How to start

1. Create a private GitHub repository and copy this folder's contents into it. Commit.
2. Answer item B in `docs/DECISIONS.md` (AWS account and region). The email system is already decided: Microsoft 365.
3. Open the repository in Claude Code and paste the Milestone 0 prompt from `docs/MILESTONES.md`.
4. Work through the milestones in order. Don't skip the acceptance checks or the review prompt.

## What to expect

- Milestones 0 to 7 run entirely on your computer with fake email, calendar, AI, maps and e-signature, so you can build and click through the whole product before any account exists.
- Real accounts are needed from milestone 3 (AI), 4 (email), 5 (calendar, maps) and 6 (e-signature) to test against the real services, and for milestone 8 (hosting).
- The app is ready for the 5 AEs when milestone 8 passes and `docs/LAUNCH_CHECKLIST.md` is complete.

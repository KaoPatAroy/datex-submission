# DaTex — AI Concierge

DaTex is an AI Concierge prototype for organizational information and workflow support, built for the **CU-TU Biztania Camp 2026 — Engineering Track**.

This public repository is a clean submission mirror of the private development repository. It intentionally excludes private development history, local databases, credentials, internal handoff material, and machine-specific artifacts.

## What DaTex demonstrates

- Role-aware AI assistance for synthetic organizational data
- Grounded answers with dated evidence
- Result saving and Dashboard workflows
- Controlled sharing and recipient scope
- Review/confirm flows before business actions
- Ticket, History, receipt, and workflow state
- Synthetic HR workflow demonstrations
- Scripted Demo mode for reproducible evaluation

All demo data is synthetic. No real retail or employee dataset is included.

## Run locally

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm ci
cp .env.example .env.local
```

For a local scripted demonstration, configure the values described in `.env.example`, then run:

```bash
npm run seed
npm run dev
```

For live AI or hosted storage, provider/storage credentials must be configured locally. **Do not commit credentials to this repository.**

## Verification commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Competition submission

Repository: https://github.com/KaoPatAroy/datex-submission

The repository URL is stable so it can be used in the submission form and QR code while the pre-deadline candidate is refined. The final qualifying-round snapshot will be frozen with a Git tag before submission closes.

## Security / repository scope

This mirror is generated from a reviewed source snapshot and uses a fresh Git history. It excludes the private repository history and local-only files such as `.env.local`, SQLite databases, logs, captures, internal coordination documents, and credentials.

© 2026 DaTex project team. All rights reserved.

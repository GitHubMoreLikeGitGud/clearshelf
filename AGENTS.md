# ClearShelf: rules for coding agents

ClearShelf is an allergen clearance and recall watch agent for online grocers (Open Agent Hackathon 2026, Track 3: Reasoning Architecture). Every decision is cited and every release is signed. The topic rules live in `.cursor/rules/*.mdc`; this file is the summary that always applies.

## Layout

| Path | What it holds |
|---|---|
| `engines/` | Meterless reference engines (H-MEM, Markovian, World Model) and their conformance suites, vendored unchanged. See `engines/UPSTREAM.md`. |
| `gateway/` | Python 3.12 Zetaris gateway (FastAPI + JayDeBeApi) on 127.0.0.1:8791: named SQL templates, allowlist, registrar, contract checks, onboarding. |
| `zetaris/` | `manifest.json`, `sql/NN_*_create.sql` / `_select.sql` pairs, `README.md` with verified row counts. |
| `ops/` | nginx config and compose file that serve `data/ops/` to Zetaris as `http://clearshelf-ops` on the `zetaris_default` network. |
| `agent/` | Node 22 + TypeScript (run with tsx, no runtime dependencies): agent loop, verifiers, policy, memory, world model, server and CLI. Tests in `agent/test/`. |
| `ui/` | Plain HTML, CSS and ES modules, no build step, served by the agent server on 127.0.0.1:8790. |
| `data/reference/`, `data/manifest/` | Committed: the cited market allergen table and the intake manifest (GTIN, market, reference labels; no Open Food Facts text). |
| `data/*` (everything else) | Runtime state, gitignored. |
| `docs/` | Conformance results, evaluation report, source notes, Cursor task files. |
| `scripts/` | Warm-up and dev-time manifest curation. |

## Rules that always apply

1. **Zetaris SQL.** Lightning SQL only (not Spark or Hive SQL). One statement per call, no trailing semicolon, qualified names. A multi-table `COMPILE USL` is sent as one statement. The agent never builds SQL: it sends a template id and parameters to the gateway. Details in `.cursor/rules/zetaris.mdc`.
2. **Zetaris scope.** Touch only the `CLEARSHELF_*` Lightning databases and `lightning.metastore.clearshelf`. Never `DROP`, `GRANT`, `REVOKE` or `INVALIDATE CACHE` from code. Never call port 8889.
3. **Engines are read-only.** Never edit anything under `engines/`. Extend from `agent/src/` (subclass, wrap, compose). The conformance suites must stay green; results are in `docs/conformance.md`. Details in `.cursor/rules/meterless.mdc`.
4. **The model never decides.** Nemotron extracts, plans and drafts. The deterministic policy (`agent/src/policy/decide.ts`) decides, the statement builder writes statements, and every count comes from SQL. HOLD and BLOCK may be applied automatically; CLEAR, CLEAR_WITH_STATEMENT and RELEASE need an officer-approved, HMAC-signed execution contract. Details in `.cursor/rules/safety.mdc`.
5. **One data path.** At runtime the agent reads Open Food Facts, openFDA and the UK FSA only through Zetaris. The only exception is the dev-time curation script in `scripts/`. No cloud model calls: the model runs in local Ollama.
6. **Source etiquette.** openFDA at most 1,000 requests a day. Open Food Facts product API at least 2.5 s between calls, with the `CLEARSHELF_USER_AGENT` header. FSA: modest polling. Never invent or reuse a contact e-mail.
7. **Secrets.** Credentials and `CLEARSHELF_CONTRACT_SECRET` live only in `.env.local` (gitignored). Never put them in prompts, logs, code, tests, fixtures or commit messages.
8. **Licences and data.** Attribute every source as in `NOTICE`. No bulk Open Food Facts data and no Open Food Facts ingredient text in committed files. Firm street addresses are never selected. Details in `.cursor/rules/data-licences.mdc`.
9. **Integrity.** Never fabricate supplier confirmations, statements by real firms or officer history. Synthetic fixtures are labelled synthetic. Replayed events are labelled as replays. Report only measured numbers, each with its label (`measured` or `estimated`).

## Commands

```bash
# Meterless conformance (once per engine: cd engines/<engine>/reference && npm install)
cd engines/hmem/reference && npx tsx ../conformance/runner.ts
cd engines/markovian/reference && npx tsx ../conformance/runner.ts
cd engines/world-model/reference && npx tsx ../conformance/runner.ts
cd engines/world-model/reference && npx tsx scripts/idempotency-check.ts

# Agent
cd agent && npm install && npm test

# Gateway (Python 3.12, venv at the repo root)
python -m venv .venv && .venv/Scripts/pip install -r gateway/requirements.txt
```

## Git

- Stage explicit paths only (`git add <path> ...`), never `git add -A` or `git add .`.
- Commits made by Cursor Agent use the message `Cn: <task> (Cursor Agent)`.
- Never commit `.env.local`, runtime `data/`, transcripts or notes.
- `AGENTS.md` and `.cursor/rules/` are the only agent instruction files in this repository; do not add others.

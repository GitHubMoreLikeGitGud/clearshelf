# Cursor task files

ClearShelf is developed in Cursor. Larger pieces of work are written up as task files in this folder and handed to Cursor Agent, which runs headless against the repository. Each task file is a self-contained brief: Cursor Agent reads it, does the work, and runs the listed checks until they pass. The task files and their commits are the record of how Cursor was used. A summary, `docs/how-cursor-was-used.md`, is planned (written in task C7; the file does not exist yet).

## File naming

- One file per task: `Cn-<short-slug>.md`, for example `C3-lexicon-and-verifiers.md`.
- `n` is the task number from the build plan (C1 to C8). Numbers are never reused; a task that needs a second pass gets a new section in the same file, not a new number.
- This `README.md` describes the convention and is not a task.

## Sections in a task file

Every task file uses these headings, in this order:

1. **Goal.** One or two sentences: what exists when the task is done.
2. **Workspace.** The folder Cursor Agent runs in. Usually the repository root; a task that works in another folder says so here.
3. **Read first.** The files to read before starting: `AGENTS.md`, the relevant `.cursor/rules/*.mdc`, and any sample data or guides.
4. **Inputs.** Sample responses, contracts, schemas or fixtures the task builds from, with their paths.
5. **Deliverables.** The exact paths to create or change. Anything not listed is out of bounds.
6. **Constraints.** Task-specific rules on top of `AGENTS.md` (for example "read-only", "no new dependencies", "never edit `engines/`").
7. **Checks.** The commands that must pass, such as `cd agent && npm test` or `.venv/Scripts/python -m pytest gateway/tests`. The task is done when they are green. Tests are never weakened or skipped to get there.
8. **Out of scope.** What the task must not do.
9. **Commit.** The commit message to use: `Cn: <task> (Cursor Agent)`.

A task file names environment variables (for example `ZETARIS_JDBC_JAR`) but never contains their values. Credentials stay in `.env.local`, which is gitignored.

## Running a task

From the repository root, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.cmd" -p --trust --force --workspace . --output-format text "Read docs/cursor-tasks/<file>.md and complete it. Run the listed checks until green."
```

- Keep the prompt short; the task file carries the detail. Windows limits the length of a command line.
- Never put secrets in the prompt.
- A task whose **Workspace** is another folder is run with `--workspace <that folder>`.

## Review and commit

1. Before the run: commit or stash everything, so the diff afterwards shows only Cursor Agent's work.
2. After the run: review `git status` and `git diff`. Check that only the paths under **Deliverables** changed, that the checks pass when run again by hand, and that no secret, private path or bulk source data was added.
3. Stage the deliverables by explicit path (`git add <path> ...`, never `git add -A`) and commit with the message from the task file: `Cn: <task> (Cursor Agent)`. Plain messages only, with no trailers.
4. Transcripts of runs are kept privately, outside the repository. Each transcript starts with the exact command line of the run (no secrets), followed by the start time, wall time and exit code.

## Task index

| Task | File | Scope | Status |
|---|---|---|---|
| C1 | C1-zetaris-preflight.md | read-only Zetaris JDBC preflight | done 2026-10-23: preflight NOT READY on Windows (path false negatives); read-only JDBC confirmed directly (see the run record) |
| C2 | C2-lightning-sql-and-usl.md | decision write-back SQL (pair 14), per-SKU OFF template, DQ rule docs, review of pairs 00 to 13, static SQL tests | done 2026-10-23, reviewer fixes in a separate commit (see the run record) |
| C3 | C3-lexicon-and-verifiers.md | multilingual lexicon, jurisdiction, GTIN normaliser, claim tester and tests | done 2026-10-23; the run stopped at the Free plan usage limit after its first test run (99 of 100 passing); reviewer fixes in a separate commit (see the run record) |
| C4 | C4-ui-screens.md | the four UI screens | planned |
| C5 | C5-evidence-drawer-and-ledger.md | evidence drawer and ledger trace view | planned |
| C6 | C6-eval-runner.md | eval runner and report | planned |
| C7 | C7-readme-drafts.md | README and how-cursor-was-used drafts | planned |
| C8 | C8-rehearsal-fixes.md | interactive fixes during rehearsal | planned (file not yet written) |

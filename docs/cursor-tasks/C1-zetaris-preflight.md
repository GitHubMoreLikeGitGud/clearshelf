# C1: Zetaris JDBC preflight

## Goal

Cursor Agent connects to the local Zetaris instance over JDBC using the Zetaris getting-started repository's own starter prompt, and confirms read-only access: the preflight, `SELECT 1`, `SHOW LIGHTNING DATABASES` and `SHOW NAMESPACES OR TABLES IN lightning.metastore`.

## Workspace

A local clone of the Zetaris getting-started repository (https://github.com/zetaris/getting-started), not this repository. Run with `--workspace <path to the getting-started clone>`.

## Read first

- The getting-started `AGENTS.md` (connection, SQL and safety rules).
- `docs/connections/cursor-connection.md` and `docs/connections/client-setup.md` sections 2, 4, 5 and 7 in that repository.

## Inputs

- `.env.local` at the root of the getting-started clone (gitignored there), with `ZETARIS_JDBC_URL`, `ZETARIS_JDBC_JAR`, `ZETARIS_USERNAME` and `ZETARIS_PASSWORD` set for the local instance. Values are never shown in prompts, output or this file.
- A `.venv` in the clone with `scripts/requirements.txt` installed (JayDeBeApi and JPype1), and a JDK 11 or later.

## Prompt

The JDBC starter prompt from `docs/connections/client-setup.md` section 5, with the goal filled in. On the command line it is passed as a single line.

```text
Read AGENTS.md and follow it. Run python3 scripts/preflight.py --jdbc and show
me the result. Report JDBC and REST checks separately. Stop on JDBC failures and report
what is missing. REST failures alone do not block JDBC. If the driver JAR path is not set, ask me
for it. Once readiness checks pass, connect over JDBC to the instance
configured in .env.local and confirm with SELECT 1 and SHOW LIGHTNING DATABASES.

If a local port check returns `Operation not permitted`, retry the same
read-only check with approved network access before reporting the endpoint as
closed. Distinguish missing Python runner dependencies (`.venv` or
`jaydebeapi`) from direct Java JDBC readiness; do not install dependencies
without asking.

Goal: confirm read-only JDBC access to the local instance: SELECT 1, SHOW LIGHTNING
DATABASES and SHOW NAMESPACES OR TABLES IN lightning.metastore, and report each
result. This machine runs Windows: the venv interpreter is .venv\Scripts\python.exe
and Java is bin\java.exe under JAVA_HOME. If a preflight check fails only because of
a Windows path difference, say so and confirm the connection with a direct read-only
jaydebeapi connection from .venv. Do not create or edit files in the repository, and
keep credentials out of the output.

Dry-run before creating anything and wait for my go-ahead.
```

## Constraints

- Read-only: `SHOW`, `DESCRIBE` and `SELECT` only. Nothing is created, dropped, granted or cached.
- No installs, no file changes in the getting-started clone, no credentials in any output.
- REST is not configured (no API key); REST failures are expected and do not block JDBC.

## Checks

- The preflight output is shown, with JDBC and REST results reported separately.
- `SELECT 1` returns 1 over JDBC.
- `SHOW LIGHTNING DATABASES` and `SHOW NAMESPACES OR TABLES IN lightning.metastore` return without error; their rows are reported.
- `git status` in the getting-started clone shows no tracked changes afterwards.

## Out of scope

Creating ClearShelf objects in Zetaris (that is C2 and the gateway onboarding), the REST channel, and any change to the getting-started scripts.

## Commit

This task changes no files in this repository; the task file and its run record are committed here. The run transcript is kept privately.

## Run record (2026-10-23)

Cursor Agent CLI 2026.10.22, model `Auto`, headless (`-p --trust --force`), workspace = the getting-started clone. Wall time 65.8 s; the CLI reported 59.8 s of agent time, 20,930 input tokens, 2,862 output tokens and 127,744 cached input tokens. Exit code 0.

What Cursor Agent did, in order:

1. Read `docs/connections/cursor-connection.md`, then ran `python3 scripts/preflight.py --jdbc`. On this Windows machine `python3` is the Microsoft Store alias, so the command failed (exit 9009).
2. Checked for `.venv\Scripts\python.exe`, `.env.local` and `JAVA_HOME\bin\java.exe` (all present), then ran `.venv\Scripts\python.exe scripts/preflight.py --jdbc` (exit 1, `NOT READY: 4 check(s) failed`):

   | Check | Result |
   |---|---|
   | env file | PASS |
   | `ZETARIS_API_KEY` | FAIL (missing; REST is not configured) |
   | `ZETARIS_USERNAME`, `ZETARIS_PASSWORD` | PASS (set) |
   | `ZETARIS_USER_AGENT` | INFO (not set) |
   | REST | FAIL (no API key) |
   | JDBC port 10000 | PASS (open) |
   | Java (JDK 11+) | FAIL: "none found" |
   | `.venv` | FAIL: "missing" |
   | jaydebeapi | PASS (importable) |
   | driver JAR | PASS (file exists) |

3. Read `scripts/zetaris_sql.py` and identified the Java and `.venv` failures as Windows path false negatives: the script looks for `bin/java` and `.venv/bin/python`, while Windows has `bin\java.exe` and `.venv\Scripts\python.exe`. It confirmed `java -version` (Temurin 21.0.12.1) and that jaydebeapi imports from `.venv`.
4. Its first attempt at a direct connection was refused by the CLI's own command check (a PowerShell quoting problem, nothing ran). It retried with a PowerShell here-string piped to `.venv\Scripts\python.exe -`, loading `.env.local` without printing values and connecting with `com.zetaris.lightning.jdbc.LightningDriver`:

   | Statement | Result |
   |---|---|
   | `SELECT 1` | `1` |
   | `SHOW LIGHTNING DATABASES` | 6 rows: `CLEARSHELF_FDA`, `CLEARSHELF_FSA`, `CLEARSHELF_OFF`, `CLEARSHELF_OPS` (created earlier the same morning by the onboarding gates), `NY_TAXI`, `TPCDS_DB` |
   | `SHOW NAMESPACES OR TABLES IN lightning.metastore` | 1 row: namespace `clearshelf`, 0 USLs |

5. Reported JDBC as ready and REST as not configured, installed nothing, changed no files, and stopped to wait for a go-ahead before any create work.

Afterwards `git status` in the getting-started clone showed no tracked changes; the only new file is Python's gitignored `scripts/__pycache__/`. No credential value appears in the run output.

Finding for the gateway: the getting-started JDBC helpers assume macOS/Linux paths. ClearShelf's adapted `gateway/jdbc.py` accepts `bin\java.exe` as well as `bin/java`.

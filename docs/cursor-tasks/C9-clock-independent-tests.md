# C9: Clock-independent runtime tests

## Goal

`cd agent && npm test` passes 419 of 419 on any day, not only on 23 Oct 2026. The runtime takes an optional `today` that tests pin, and the deliberate replay cases in `agent/test/runtime.test.ts` still run as replays.

## Workspace

This repository (a fresh clone of the public repository). Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/style.mdc`.
- `agent/src/runtime.ts`: `Runtime`, `RuntimeOptions`, `openRuntime`, `investigate` and `asReplay`. An as-of date before today makes a clearance a replay; "today" is read from the wall clock with `localIso().slice(0, 10)` in three places.
- `agent/src/watch/` and the `agentWatch` deps in `runtime.ts`: the watch already takes an injected `today` (`deps.today`), which the tests pin to `2026-10-23`. Follow the same pattern.
- `agent/test/runtime.test.ts`: the helper `env()` that calls `openRuntime`, and the tests that pass `asOf: "2026-10-23"`.

## Inputs

The problem, measured on a fresh clone on 25 Oct 2026: `npm test` gives `Tests 3 failed | 416 passed (419)`. The runtime tests pin `asOf: "2026-10-23"` and expect a live (non-replay) clearance, but the runtime compares the as-of date with the wall clock. From 24 Oct 2026 the same tests turn into replays: memory is filtered by the as-of date, intake no longer registers through the registrar, and the decision row is a replay row. The three failures are in `agent/test/runtime.test.ts` (one of them is the registrar assertion `expect(calls).toEqual([...])` in the intake test).

The deliberate replay cases use as-of dates well before 23 Oct (`2026-08-15`, `2026-09-15`, `2026-10-10`) and must stay replays.

## Deliverables

| File | Change |
|---|---|
| `agent/src/runtime.ts` | An optional `today?: () => string` (local date, `YYYY-MM-DD`) on `RuntimeOptions` and on `Runtime`, passed through by `openRuntime`. `investigate` (both places) and `asReplay` use it, falling back to the wall clock (`localIso().slice(0, 10)`) when it is not given. Product behaviour without the option is unchanged. |
| `agent/test/runtime.test.ts` | The `env()` helper pins `today: () => "2026-10-23"` in its `openRuntime` call. No assertion is changed, removed or skipped. |

## Constraints

- Change only the two files above. Do not edit `engines/`, other tests, `agent/package.json`, `agent/tsconfig.json`, the server, the CLI or the UI.
- No new dependencies. ES modules, TypeScript run by tsx.
- Tests are never weakened, skipped or deleted to get to green. The replay tests (as-of `2026-08-15`, `2026-09-15`, `2026-10-10`) keep their assertions.
- The default (no `today` given) must still be the wall clock, so the server and the CLI behave as before.

## Checks

- `cd agent && npm test` reports `Tests 419 passed (419)`.
- `cd agent && npm run typecheck` exits 0 with no output from `tsc`.
- If the design allows, run the suite once more with the wall clock faked to a later date, to show the result no longer depends on the day. In PowerShell, write this preload to a file outside the repository and run the tests with it; do not add the file to the repository:

  ```powershell
  Set-Content -Path "$env:TEMP\clock-later.mjs" -Value 'const R = Date; const s = 60 * 864e5; class D extends R { constructor(...a) { if (a.length === 0) super(R.now() + s); else super(...a); } static now() { return R.now() + s; } } globalThis.Date = D;'
  $env:NODE_OPTIONS = "--import=file:///$($env:TEMP -replace '\\','/')/clock-later.mjs"; npm test; Remove-Item Env:NODE_OPTIONS
  ```

  The expected result is again `Tests 419 passed (419)`.

## Out of scope

Changing which dates count as a replay, the replay labels, the watch, the server or the CLI; CI; any other test file.

## Commit

`C9: clock-independent runtime tests (Cursor Agent)`

Do not commit; leave the changes in the working tree.

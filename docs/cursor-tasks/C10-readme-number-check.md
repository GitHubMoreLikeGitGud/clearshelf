# C10: Check the README's headline numbers against `docs/eval/*.json`

## Goal

One command fails when a headline number in `README.md` no longer matches the committed score-only JSON it comes from. `cd agent && npm run check:readme` recomputes each number from `docs/eval/*.json`, formats it the way the README prints it, and exits 1 on any mismatch, naming the check, the expected text and the JSON field.

## Workspace

This repository (a fresh clone of the public repository). Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/style.mdc`, `.cursor/rules/data-licences.mdc`.
- `README.md`: the top section (lines 1 to 55) and the NVIDIA and Evaluation sections. The table under "The measured runs behind the numbers are committed as score-only JSON" says which file backs which number.
- The JSON files in `docs/eval/`: `eval-2026-10-25-aeb5b92.json`, `extraction-q4-2026-10-25.json`, `extraction-q8-2026-10-25.json`, `full-history-2026-10-25.json`, `watch-polls-2026-10-23.json`.

## Inputs

The README phrases to check, each with the JSON it comes from. Find the field in the JSON yourself; recompute derived values (medians, percentages, rounding) from the stored numbers instead of copying a pre-rounded field where both exist.

| Check | README text (as printed today) | Source |
|---|---|---|
| watch median | `median 68.4 s over 10 runs (57.5 to 93.5 s` | `watch-polls-2026-10-23.json`: the median, count, minimum and maximum of the runs' `wall_ms`, in seconds to one decimal |
| re-run citations | `95 of 95 cited records re-ran` | `eval-2026-10-25-aeb5b92.json`: evidence quality, the re-run counts |
| evidence completeness | `200/200 complete, 95/95 re-run` | the same file: completeness and re-run counts |
| planner validity | `planner validity (59/65)` | the same file: the planner totals (valid on the first try / calls) |
| scenarios | every place the README says the scenarios passed, for example `10/10` or `10 of 10` next to "scenarios" | the same file: passed and total scenarios |
| full-history tokens | `4,641 and 6,829 tokens` | `full-history-2026-10-25.json`: the measured full-history prompt of each run's last chunk |
| full-history saving | `48% and 58% fewer prompt tokens` | the same file: each run's measured saving, as a whole percentage |
| model alone | `precision 1.00 and recall 0.78 with 0 of 15 trap false alarms` | `extraction-q4-2026-10-25.json`: system N, micro precision and recall to two decimals, trap false alarms |
| keyword rule | `keyword rule 0.71 / 0.99, 5 of 15` | the same file: system K |
| lexicon alone | `the lexicon alone scores 0.97 / 0.97` | the same file: system L |
| Q8_0 | the README's Q8_0 precision and recall for the model alone (`1.00 / 0.84` or `1.00/0.84`) | `extraction-q8-2026-10-25.json`: system N |

A README phrase that is missing is a failure too (the README may have been reworded without updating the check), with a message that says so.

## Deliverables

| File | Change |
|---|---|
| `scripts/check-readme-numbers.mjs` | New. Plain Node ES module, no dependencies (Node 22). One table of checks at the top of the file (id, the README text it builds, the JSON file and how the number is computed). Prints one line per check (`PASS` or `FAIL`, the id, and on failure the expected text and the JSON field) and a summary line `N of M checks passed`. Exit 0 when all pass, 1 otherwise. Paths resolve from the script's own location, so it runs from any working directory. A `--readme <path>` argument checks another copy of the README (default: the repository's `README.md`). |
| `agent/package.json` | One new script: `"check:readme": "node ../scripts/check-readme-numbers.mjs"`. No other change. |

## Constraints

- Change only the two files above. Do not edit `README.md`, `docs/`, `engines/`, the tests, CI or any other file. If a README number does not match its JSON, report it in your final message; do not change either file to make the check pass.
- No new dependencies.
- The check must recompute from the JSON. It must never read the expected value from the README itself.
- Keep the output free of local paths (print paths relative to the repository root).

## Checks

- `cd agent && npm run check:readme` exits 0 and prints `11 of 11 checks passed` (or the number of checks you wrote, all passing).
- Negative check: copy `README.md` to a file in the system temp folder (outside the repository), change `68.4 s` to `68.5 s` in the copy, and run `node scripts/check-readme-numbers.mjs --readme <that copy>` from the repository root. It must exit 1 and name the watch-median check. Delete the copy afterwards.
- `cd agent && npm test` still reports `Tests 421 passed (421)`, and `npm run typecheck` exits 0.

## Out of scope

Changing any number, the README text, the JSON files or CI; checking numbers that no JSON in `docs/eval/` backs.

## Commit

`C10: README headline numbers checked against docs/eval (Cursor Agent)`

Do not commit; leave the changes in the working tree.

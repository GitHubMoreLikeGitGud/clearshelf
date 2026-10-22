# Meterless conformance results

Run on 2026-10-23 against the engines vendored in `engines/` (upstream `Meterless/Meterless` commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`, see `engines/UPSTREAM.md`). Windows 11, Node v22.13.1, npm 10.9.2. Each engine was installed with `npm install` in its `reference/` folder, then run exactly as its README says.

## Summary

| Check | Command (working directory) | Result | Exit code |
|---|---|---|---|
| H-MEM conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/hmem/reference`) | **13/13 passed** | 0 |
| Markovian conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/markovian/reference`) | **8/8 passed** | 0 |
| World Model conformance, vendored reference | `npx tsx ../conformance/runner.ts` (`engines/world-model/reference`) | **8/8 passed** | 0 |
| World Model idempotency check | `npx tsx scripts/idempotency-check.ts` (`engines/world-model/reference`) | **diff: empty** (pass) | 0 |
| World Model idempotency check, negative control | `npx tsx scripts/idempotency-check.ts --mutate` | diff: NON-EMPTY, as expected (shows the check can fail) | 0 |
| H-MEM smoke tests | `npm test` (`engines/hmem/reference`) | 10/10 passed | 0 |
| Markovian smoke tests | `npm test` (`engines/markovian/reference`) | 10/10 passed | 0 |
| World Model smoke tests | `npm test` (`engines/world-model/reference`) | 10/10 passed | 0 |
| Markovian measured run | `npx tsx scripts/measured-run.ts` (`engines/markovian/reference`) | completed; output below | 0 |

Pending, recorded here when they exist:
- H-MEM conformance against the ClearShelf facade: `HMEM_IMPL=<abs path>/agent/src/memory/hmemFacade.ts npx tsx engines/hmem/conformance/runner.ts`.
- `agent/test/world-idempotency.test.ts`: re-ingest the same Zetaris rows, expect an empty diff.

## Details

### H-MEM (13 checks)

| Group | Checks |
|---|---|
| record-validation | rv-001, rv-002 |
| feedback-deltas | fd-001 to fd-005 |
| ranking-order | ro-001, ro-002 |
| sleep-guardrails | sg-001 |
| conflict-gate | cg-001 |
| ledger-audit | la-001 |
| dream-boundary | db-001 |

All PASS.

### Markovian (8 checks)

eff-001, snap-001, snap-002, ovl-001, lab-001, ref-001, mrk-001, cfg-001. All PASS.

### World Model (8 checks)

sid-001, sid-002, band-001, prov-001, idem-001, idem-002, bitemp-001, audit-001. All PASS.

### World Model idempotency check output

```
run 1: processed=3 clusters=1 changed=true
run 2: processed=0 skipped=3 changed=false
diff: empty
```

With `--mutate`:

```
run 1: processed=3 clusters=1 changed=true
run 2: processed=1 skipped=2 changed=true
diff: NON-EMPTY
```

The script prints the verdict and exits 0 in both modes; the pass criterion is the `diff:` line.

### Markovian measured run

This is the engine's own demonstration with its mock generator, not a ClearShelf measurement. Every number is labelled by the script as estimated (chars/4).

| Step | Naive cumulative input tokens | Markovian cumulative input tokens | Ratio |
|---|---|---|---|
| 1 | 29 | 112 | 0.26x |
| 10 | 13,213 | 1,381 | 9.57x |
| 20 | 55,358 | 2,801 | 19.76x |

Input tokens saved at step 20: 52,557 (94.9%, estimated).

## Notes

- `npm install` rewrites the root `"license"` field in each vendored `package-lock.json` (upstream lock says `MIT`, `package.json` says `Apache-2.0`). The vendored lock files were restored to the upstream bytes before these runs; dependency resolution is the same either way.

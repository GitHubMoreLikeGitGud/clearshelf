# Nemotron bench: Day-0 gates G8 and G8b, the 25 Oct extraction re-run, and recall notices at scale and the planner switched off (26 Oct)

The main run was on Fri 23 Oct 2026, 07:50–08:09 SGT. The follow-up runs (Q8 A/B, host-RAM soak) were at 08:26–08:42 SGT. All runs used the development PC with the four Zetaris containers (`ui`, `api`, `driver`, `postgres`) up and healthy. Every number below is measured unless it is labelled `estimated`: Ollama's own token counts and durations, `nvidia-smi` at 1 s, OS CPU and available-RAM counters at 1 s, and, in the soak runs, the private memory of the Ollama processes at 1 s. The raw results are in `data/bench/` (local, gitignored): `g8-*.json`, `g8b-*.json` and `soak-*.json`. The follow-up files include every 1 s sample; the main-run files hold per-phase statistics only. (In the two Q8 A/B files the process-memory fields read 0, because the sampler did not yet find the runner process; it was fixed before the soak, and nothing below uses those fields.)

## What the model adds over rules alone

ClearShelf decides from deterministic readers (the GS1 scan for barcodes, the lexicon verifier for allergens), and Nemotron reads the same text as a second reader; a barcode or allergen that either reader finds holds the listing for the officer. Measured, from the committed summaries:

| Job | Deterministic reader alone | Nemotron alone | Both, holding on either | Cost of the model |
|---|---|---|---|---|
| Barcodes in 505 FDA recall notices (26 Oct, [`notices-2026-10-26.json`](eval/notices-2026-10-26.json)) | GS1 scan: 701 of 705 | 620 of 705 | **705 of 705**; 15 wrong codes (3 scan, 12 model), none a catalogue barcode | 0.78 s per notice, median; 2,881 MiB of VRAM |
| "Contains" allergen pairs on 27 product labels (25 Oct, [`extraction-q4-2026-10-25.json`](eval/extraction-q4-2026-10-25.json)) | lexicon: 78 of 80 | 62 of 80 | **79 of 80** | 2.09 s per label, median (the lexicon takes about 2 ms, no GPU) |
| Trap words read as an allergen, same labels | lexicon: 1 of 15; keyword rule: 5 of 15 | 0 of 15 | 1 of 15 | |
| Undeclared allergens in the 505 notices | lexicon: 499 exactly right | 412 | not combined: the lexicon's reading decides | |

- **Pooled gold.** On notices, a code counts as true when both readers return it or a hand check confirms it (every single-reader code is listed by notice id in [`notices-adjudication-2026-10-26.json`](eval/notices-adjudication-2026-10-26.json)), so a code both readers missed is not among the 705. In the 20 notices drawn at random and read in full, all 17 valid barcodes were found by at least one reader.
- **The labels favour the lexicon.** The reference labels' text rule R-NAME is the lexicon's own word list ([eval report, section 8](eval-report.md#8-reference-label-rules-from-datamanifestskusjson-version-2026-10231)), so the lexicon's 78 and the combined 79 are partly the lexicon graded against itself. The overlap (1 pair missed by both) is from the 25 Oct run, [eval report, section 3](eval-report.md#re-run-on-25-oct-2026-lexicon-alone-q8_0-and-recall-per-language).
- **Alone, the model is the weaker reader on both jobs** (sections below). Its measured contribution is the codes and words the deterministic reader missed, at the cost of more holds: at intake, 6 of the 7 listings held only on contradictions included a model/verifier disagreement ([eval report, section 7](eval-report.md#7-write-back-dq-at-runtime-recall-coverage-and-watch-timing)).

## Verdict

| Gate | Criterion | Result | Decision |
|---|---|---|---|
| **G8** | JSON valid on ≥95% of 20 extraction and 10 planner calls, think on and off, with Zetaris running; tok/s and VRAM recorded | **Pass, by one call.** With the adopted settings (think off for extraction, think on for the planner), 29/30 calls returned valid JSON (96.7%; n = 30) in the main run. The one failure was the multilingual Lidl label. After a schema fix, 20/20 extraction calls were valid in a re-run, but the Lidl reply is valid only in form (see "Fix applied after the run"). | Primary model `nemotron-3-nano:4b` (Q4_K_M). No fallback model needed. |
| G8, think on | `think` and `format` work together on this Ollama build | **Yes for planning and briefs**: 10/10 planner and 3/3 brief calls valid with think on. **No for ingredient extraction**: 2/10 valid, because the thinking reaches the 4,096-token cap before any answer, with or without `format`. | `think: true` for the planner and adjudication briefs; `think: false` for ingredient extraction, notice extraction, mining and classification. |
| **G8b** | 30B at ≥8 tok/s with Zetaris running and ≥3,072 MiB free host RAM | **Fail on RAM.** The 30B needs about 11.8 GB of its weights in host RAM (`estimated`), but only 7,971 MiB was available, which projects to −3,851 MiB free. The model was not loaded, so **30B tok/s was not measured**. | **30B tier cut.** It was optional and off unless this gate passed. |
| Host-RAM soak | Find out why available RAM fell to 617 MiB in the G8 think-on pass | **Reproduced and explained.** The model runner's private memory rose from 4,396 to 9,903 MiB (+5,507 MiB) over 30 calls. The cause is the runner's prompt cache in host RAM, which grows with each new prompt in both think modes. With the cache disabled, 10 of the same planner calls left the runner flat (+8 MiB). | **RAM guard on by default** in the Ollama client: below 2,048 MiB available, it unloads the model before the next call (fired once in the soak and recovered 6,542 MiB). Think on is kept for the planner and briefs. Capping the cache is an option for the PC owner. |
| Recall notices at scale (26 Oct) | Score the notice job on every cached openFDA notice that prints a barcode (505), against the repository's GS1 scan | **The deterministic readers win.** UPC precision / recall: GS1 scan 0.996 / 0.994, Nemotron 0.981 / 0.879 after the host check (raw 0.757 precision; 21 codes not in the text). Allergens exactly right: lexicon 499/505, Nemotron 412/505. Nemotron found 4 true codes the scan missed. | The scan and the lexicon stay the decision path (as built); the model stays a second reader. Two host fixes noted (11-digit truncations, UPC-E). |
| Planner switched off (26 Oct) | Does the decision depend on the model's plan? The 8 investigations with `fallbackStep()` only | **No.** Same decision, rules, contradiction kinds, claim verdicts and statement in 8 of 8, in two pairs of runs. The planner added 1 optional World Model lookup in 16 planned investigations and a note per step; the 8 took 569.9 and 530.6 s with it against 163.9 and 158.5 s without. | The planner stays on for its notes; `CLEARSHELF_PLANNER=off` is a measured mode. |
| Optional Q8 tier | Adopt only if JSON validity and span grounding are no worse, at ≥40 tok/s | **Meets the rule on 10 texts:** 10/10 valid, 0 spans dropped, 117.4 tok/s. (group, relation) precision / recall 1.000 / 0.867, against 0.958 / 0.767 for Q4 in the same session. | **Not adopted in this pass.** Q4 stays the default until the lead decides; the costs are listed in the Q8 section. |

## 25 Oct 2026: the 27-SKU extraction harness with the lexicon alone, Q8_0 and recall per language

The Day-0 bench above used 10 texts and expected values read by hand. The evaluation harness (`npm run eval:extraction`, [eval report, section 3](eval-report.md#3-extraction-spec-92)) scores 27 real labels against reference labels derived by documented rules. On 25 Oct it gained a lexicon-only system (L: the deterministic verifier alone, no model) and a split by label language, and it was run on Q4_K_M and on Q8_0 one after the other, with no other model loaded (commit `8182e9d`; summaries in [`docs/eval/extraction-q4-2026-10-25.json`](eval/extraction-q4-2026-10-25.json) and [`extraction-q8-2026-10-25.json`](eval/extraction-q8-2026-10-25.json)). All values measured.

| `contains` precision / recall | L lexicon alone | Nemotron Q4_K_M | Nemotron Q8_0 | Keyword baseline |
|---|---|---|---|---|
| All 27 SKUs (80 positives) | **0.97 / 0.97** | 1.00 / 0.78 | 1.00 / 0.84 | 0.71 / 0.99 |
| English, 21 SKUs (49) | 1.00 / 0.98 | 1.00 / 0.90 | 1.00 / 0.90 | 0.75 / 1.00 |
| German, 4 SKUs (20) | 0.90 / 0.95 | 1.00 / 0.50 | 1.00 / 0.70 | 0.58 / 0.95 |
| French, 1 SKU (5) | 1.00 / 1.00 | 1.00 / 0.60 | 1.00 / 0.80 | 1.00 / 1.00 |
| Italian, 1 SKU (6) | 1.00 / 1.00 | 1.00 / 0.83 | 1.00 / 0.83 | 0.75 / 1.00 |
| Trap false alarms | 1/15 | 0/15 | 0/15 | 5/15 |
| "May contain" read exactly | 26/27 | 18/27 | 16/27 | 0/27 |
| Generation speed, median | none (about 2 ms per label on the CPU) | 154.1 tok/s | 113.1 tok/s (27% slower) | none |
| Extraction call, median | | 2.09 s | 2.55 s (22% longer) | |
| Model resident in VRAM | 0 | 2,881 MiB | 4,066 MiB | 0 |

No Spanish label is among the 27 measured SKUs.

- **The lexicon alone beats the model on these labels**, and that result is published as measured. It is also biased in the lexicon's favour: the reference labels' text rule uses the same lexicon, so L is largely graded against its own rules. On labels it was not written for, the lexicon's advantage is not shown.
- **The two readers miss different things.** With Q4, the lexicon found 17 of the model's 18 missed `contains` pairs, and the model found 1 of the lexicon's 2. ClearShelf runs both and holds any disagreement for the officer (R4), so the model's measured role in extraction is a second, independent reader. Its other jobs (recall notices, the planner, memory mining) have no lexicon equivalent.
- **Q8_0 on 27 labels** confirms the Day-0 direction (better recall, slower): German recall 0.50 → 0.70, overall 0.78 → 0.84, English unchanged, 2 fewer exact "may contain" reads, 1,185 MiB more VRAM. **Q4 stays the default**, for the reasons in the Q8 section below; the planner, notice extraction and the soak were still measured on Q4 only.
- The Q4 re-run reproduced the 23 Oct K, N and N+V scores exactly; generation speed was 154.1 tok/s against 159.8 on 23 Oct.

## 26 Oct 2026: recall notices at scale, and the planner switched off

### Recall-notice extraction on every cached openFDA notice that prints a barcode

The Day-0 bench scored the notice job on 10 notices (UPC precision / recall 1.000 / 0.957, 0 invented). This run scores it on every notice that prints a barcode, against the repository's own deterministic GS1 scan. All values measured, on 26 Oct 2026, 01:12–01:23 SGT.

- **Input.** Zetaris caches the newest 1,000 openFDA food enforcement reports whose recall reason says "undeclared" (`clearshelf_fda.enforcement_undeclared`). Each was read through the gateway with the `fda_notice` template, as the agent reads it. The gateway returns at most 200 rows per template, so the 1,000 recall numbers came from the dev-time openFDA page that onboarding cached (the same 1,000 reports; all 1,000 were found in Zetaris). A notice "prints a barcode" when its text names one (UPC, EAN, GTIN or barcode) and holds a run of 8 or more digits: **505 of the 1,000**.
- **Readers.** Nemotron's notice job (`extractNotice`: the production prompt and schema, `nemotron-3-nano:4b` Q4_K_M, think off, temperature 0, one call per notice) and the GS1 scan (`extractUpcs`, no model). As in production, a model code is kept only when its digits appear in the notice and it passes the GS1 check digit.
- **Gold.** A GTIN both readers return is counted true. Every GTIN only one reader returned (104) was decided by hand from its place in the notice; a code the notice labels as a case or shipper code counts as false. 20 notices drawn at random (seeded) were read in full to look for barcodes both readers missed. Allergens are scored against the groups the reason text names as undeclared: where the model and the lexicon agree (407 notices) the agreement stands, and all 98 disagreements were read by hand (coconut is not a tree nut, as in FDA's Edition 5 guidance that ClearShelf follows). Every hand decision is listed by notice id in [`docs/eval/notices-adjudication-2026-10-26.json`](eval/notices-adjudication-2026-10-26.json); the scores are in [`docs/eval/notices-2026-10-26.json`](eval/notices-2026-10-26.json).
- **Command.** `npm run eval:notices -- run --ids <the openFDA page>` (commit `59d2b49`), then `npm run eval:notices -- score <run file> docs/eval/notices-adjudication-2026-10-26.json` (commit `9b0b514`).

| UPCs: 705 true GTINs in 505 notices | GS1 scan, no model | Nemotron, after the host check | Nemotron, raw output |
|---|---|---|---|
| Precision | **0.996** (701 of 704) | 0.981 (620 of 632) | 0.757 (637 of 841 codes returned) |
| Recall | **0.994** (701 of 705) | 0.879 (620 of 705) | |
| Wrong codes | 3: a distributor case code, a shipper-case GTIN, and a 10-digit code joined to the next pack size | 12 that pass the host check: 7 printed UPCs with the last digit dropped, whose 11 digits pass the padded check digit by chance, and 5 UPC-E codes padded as EAN-8 (a different GTIN) | 21 codes whose digits are not in the notice; 171 that fail the check digit (the host drops them) |
| True codes only this reader found | 85 | 4: a hyphenated code followed by "4 pack", and three 8-digit EAN-8 codes after "UPC", which the scan skips as UPC-E | |
| 20 notices read in full (17 valid barcodes) | 17 | 14 | 0 missed by both |

| Allergen groups against the reason text, 505 notices | Lexicon on the reason text | Nemotron |
|---|---|---|
| Notices with exactly the right groups | **499** (98.8%) | 412 (81.6%) |
| Of the 98 disagreements, read by hand: right | 92 | 5 |
| If coconut counted as a tree nut (FDA's list before Edition 5) | 485 | 425 |

- **JSON and speed.** 505/505 replies valid on the first try. Median 0.78 s per notice (p95 2.66 s, max 6.51 s), 139.8 tok/s median, 61,273 output tokens; the run took 684 s, 165 s of it reading the 1,000 notices through the gateway. Other programs kept the CPU at 21 to 76%, and a Cursor Agent task (C10) ran during the first 2.5 minutes.
- **This result goes against the model, and it is published as measured.** At scale the deterministic GS1 scan beats Nemotron on every UPC measure, and the lexicon reads the undeclared allergens better. The model's typical UPC error is a code printed in groups ("0 78000 03798 2"): it drops or merges a digit. The check digit catches most of these: 67 of the 171 model codes that fail it are one digit short of a valid code the notice prints (the other 104 are digits that do not form a valid code as printed), and 7 truncated codes passed it by chance. Its typical allergen error is reporting allergens the product lists rather than the ones the reason calls undeclared, or reading a non-allergen as one (sodium tripolyphosphate as crustacean, fish and soy; sildenafil as sulphite; a colour as gluten). The lexicon's 6 misses are a product or flavour name read as an allergen ("egg salad", "with Egg", a "Mustard" flavour, the milk that is the recalled product, the shrimp in two sulfite recalls); the model got 5 of those 6 right. The Day-0 smoke result did not hold on 505 notices.
- **What the model adds:** 4 true codes the scan missed (0.6% of the true codes), all from scan rules that can be fixed (8-digit codes after "UPC", a run followed by a pack count). What it would cost if trusted alone: 85 missed codes, and 12 wrong ones that pass the host's check.
- **What this means for ClearShelf, as built.** The recall watch holds a listing whose GTIN either reader finds (`recallWatch.ts`), and the policy takes undeclared allergens from the lexicon's reading of the reason (`undeclared_groups`), not from the model. So the model's misses are covered by the scan, its allergen errors do not reach a decision, and its wrong codes could only add a hold, never a clearance; none of the 15 wrong codes (12 model, 3 scan) is a catalogue GTIN. Measured, the notice job is a weak second reader, and the deterministic path is the one that carries the result. Two host fixes follow from it and are not made yet: refuse an 11-digit model code when the notice prints those digits followed by another digit, and expand UPC-E.
- One call is uncertain: F-0762-2025 prints `UPC 00773164`, judged an EAN-8. Counted the other way, the model's figures are 0.979 / 0.879.

### The planner switched off

`npm run eval:planner-ablation -- --planner model` and `-- --planner off` ran the 8 investigations behind the planner counts (E1, E3 to E7, and E2's SKU as of 10 Oct and as of 25 Oct) with the Nemotron planner and with `fallbackStep()` only, in two pairs of runs on 26 Oct 2026 (commit `0d75dd2`, then `9b0b514`). Method and the per-investigation table: [eval report, section 4](eval-report.md#planner-switched-off-26-oct-2026); summary: [`docs/eval/planner-ablation-2026-10-26.json`](eval/planner-ablation-2026-10-26.json). All values measured.

| 8 investigations, pair 1 / pair 2 | Planner on (Nemotron, think on) | Planner off (`fallbackStep()`) |
|---|---|---|
| Decision, rules, contradiction kinds, claim verdicts, statement | | identical to the planner-on runs in 8 of 8, both pairs |
| Tool calls | 66 / 65: 65 / 65 chosen by the model, 1 / 0 fallback steps | 65 / 65, all deterministic |
| Optional tools called | 1 / 0 (a World Model lookup, E2 as of 25 Oct) | 0 / 0 |
| Evidence records | 134 / 133 | 133 / 133 |
| Planner calls valid on the first try, after one repair | 59 and 65 of 66 / 57 and 65 of 65 | none |
| Planner tokens, prompt and output | 122,736 and 51,063 / 124,897 and 46,961 | 0 |
| Wall time for the 8 (median per investigation) | 569.9 s (68.3 s) / 530.6 s (61.4 s) | 163.9 s (20.5 s) / 158.5 s (19.8 s) |

**What it shows.** The decision does not depend on the model's plan: the deterministic policy decides from the evidence the host checklist requires, and the planner works through that checklist in order (the order differed once per pair: pair 1 added the World Model lookup in E2 as of 25 Oct, pair 2 ran the DQ gate early in E3). What the planner adds is a note per step on the card and an occasional optional lookup; what it costs is 3.3 to 3.5 times the wall time. Measured, the planner is a reviewability feature, and its reliability property is that a bad plan cannot change a decision. Where Nemotron adds measured value is the second, independent reading of labels (the 25 Oct section above); as a notice reader it measured weaker than the deterministic scan (the section above).

## Setup

| Item | Value |
|---|---|
| GPU | NVIDIA GeForce RTX 4070 Ti SUPER, 16,376 MiB, driver 616.64 |
| Host | 16 logical cores, 31,849 MiB RAM |
| Ollama | 0.40.7, `/api/chat`, `stream: false`, one request at a time from the bench. Each loaded model runs in a bundled `llama-server` process, a child of `ollama serve`. |
| Primary model | `nemotron-3-nano:4b`, digest `d94b6dfae26d…`, 2.84 GB on disk, Q4_K_M; loaded size 3.02 GB, 100% in VRAM |
| Q8 model | `nemotron-3-nano:4b-q8_0`, digest `c534497d032c…`, 4.23 GB on disk; loaded size 4.26 GB, 100% in VRAM |
| 30B model | `nemotron-3-nano:30b`, digest `7487f38ecf24…`, 24.27 GB on disk (23,148 MiB) |
| Options | `temperature 0`, `seed 7`, `num_ctx 8192`, `keep_alive 30m`; `num_predict` 1,536 (think off) or 4,096 (think on) in G8 |
| Structured output | Ollama `format` = the job's JSON schema (`agent/src/llm/schemas.ts`); each reply is also parsed and validated host-side, and an invalid reply is retried once |
| Prompts | `agent/src/llm/prompts/{extraction,notice,planner,brief}.md` |

### Concurrent load on the PC

- CPU across all 16 logical cores: 31% on average in the idle window before G8, 33% during the G8 run (100% at one moment).
- The top-CPU snapshots (3 s windows at idle, at the start of think-off extraction and at the start of think-on extraction) show the Ollama runner at about 6% of all cores and one unrelated Python service at about 6%. No other heavy CPU or GPU workload appeared in any snapshot.
- VRAM before the model loaded: 3,520 MiB (desktop and other apps).

## Inputs

| Job | Calls per think mode | Source (fetched at dev time; not committed) |
|---|---|---|
| Ingredient extraction | 10 | Open Food Facts product API, `ingredients_text` of 10 real products, `User-Agent: ClearShelf/0.1`: 4 English (UK dark chocolates, an Italian biscuit in English), 2 French (incl. the Lidl shortbread from H-1275-2026, with label text in five languages), 2 German, 2 Italian. `off.json` holds 13 products; the bench uses 10.¹ |
| Notice extraction | 10 | One openFDA call (`food/enforcement`, `reason_for_recall:undeclared`, 200 records): H-1328-2026, H-0011-2027, H-1275-2026, H-1335-2026, H-1198-2026, H-1325-2026, H-0016-2027, H-1172-2026, H-0941-2026, H-1383-2026 |
| Planner | 10 | **Constructed investigation states (synthetic bench input).** The product fields and the FDA and FSA rows quoted in them come from the fetched records. The tool results around them were written by hand to put the planner at each checklist step, because no pipeline existed yet: guard and verifier outcomes, DQ invalid records, "no officer rulings", FSA counts by brand and policy proposals. Only 3 FSA alerts were fetched, so "0 FSA alerts" for a brand is part of the constructed state, not a search result. 8 SKU-clearance steps (Frankie's puffs UK, Lidl shortbread US) and 2 recall-sweep steps (FDA H-0011-2027; FSA-AA-48-2026). |
| Brief (G8b baseline) | 3 | **Constructed adjudication inputs**, built the same way: real FDA rows and product fields, hand-written DQ, extraction and policy states. |

¹ The fetch requests for this run were not logged, so their spacing cannot be shown from saved data. `agent/src/llm/benchFetch.ts` now recreates the inputs. It writes to a new directory, spaces Open Food Facts calls 3 s apart, and logs every request's start time, HTTP status and duration to `fetch-log.jsonl`.

**Expected values** (`agent/src/llm/bench.cases.ts`) record what each text plainly says, read from the fetched text. They are not the evaluation's reference labels. With 10 texts per job these are smoke-level accuracy figures, not the evaluation.

**Scoring rules:**
- `wheat` and `gluten_cereal` count as one group.
- Two allergens are scored as neither right nor wrong: egg on the Lidl label, where it appears only as a scanning error, and coconut, which is the FDA/EU rule conflict.
- Ingredient scores cover **the model alone**, after the grounding rule but before the lexicon verifier.

**Disclosure.** The prompts were revised once after a 3-call smoke test on bench items, then frozen before the main run. The revision added the evidence-id enum, a rule to split listed allergens into one span each, and a rule to read the text in order. Changes after the main run:
- The span `maxItems` fix (below), with its own re-run.
- The `--think` and `--jobs` bench flags, added to run that re-run. They select which calls run and do not change any call (the main-run file has no `selection` field because of this).
- After review: process-memory sampling and raw samples in the result files, the `soak` gate, the RAM guard and refused-host counter in `ollama.ts`, `dedupeSpans` in `grounding.ts`, the per-job settings in `settings.ts`, and `benchFetch.ts`. None of these changes a prompt or a schema. The prompt token counts are identical between the main run and the re-run, and 19/20 outputs are byte-identical.

## G8 results: `nemotron-3-nano:4b`

### Validity, speed and latency

| Job | Think | JSON valid, 1st try | Valid after 1 retry | Wall time², median / p95 / max | tok/s, median | Output tokens², median | Prompt tokens², median |
|---|---|---|---|---|---|---|---|
| Ingredient | off | 9/10 | 9/10 | 1.22 / 19.38 / 19.38 s | 160.3 | 171 | 1,531 |
| Notice | off | 10/10 | 10/10 | 0.70 / 2.06 / 2.06 s | 161.8 | 93 | 717 |
| Planner | off | 10/10 | 10/10 | 2.25 / 2.89 / 2.89 s | 152.9 | 316 | 1,112 |
| **All, think off** | off | **29/30 (96.7%)** | 29/30 | 1.80 / 2.89 / 19.38 s | 159.2 | 255 | 1,112 |
| Ingredient | on | 2/10 | 2/10 | 51.59 / 52.85 / 52.85 s | 159.4 | 8,192 (cap hit on both tries) | 1,531 |
| Notice | on | 10/10 | 10/10 | 3.11 / 7.42 / 7.42 s | 159.8 | 477 | 717 |
| Planner | on | 10/10 | 10/10 | 3.50 / 4.67 / 4.67 s | 156.1 | 515 | 1,112 |
| **All, think on** | on | **22/30 (73.3%)** | 22/30 | 3.85 / 51.88 / 52.85 s | 158.4 | 573 | 1,112 |
| **Adopted** (extraction off + planner on) | mixed | **29/30 (96.7%)** | 29/30 | | | | |

² Wall time and output tokens are summed over both attempts when a call was retried. Prompt tokens are per attempt. The raw files sum prompt tokens over attempts too, so they show 3,062 for think-on ingredient extraction, which is 2 × 1,531.

- Throughput is flat across jobs and think modes: 151.5–165.2 tok/s per call, from `eval_count / eval_duration`.
- The model loaded fully in VRAM (`size_vram` = `size` = 3.02 GB).

### VRAM, CPU and RAM during the run

| Window | GPU memory used: median / peak | GPU utilisation, mean | CPU, mean / max | Available RAM, minimum |
|---|---|---|---|---|
| Idle, before load | 3,520 / 3,541 MiB | 6% | 31% / 47% | 7,864 MiB |
| Think-off pass | 6,674 / 6,695 MiB | 89% | 30% / 59% | 4,560 MiB |
| Think-on pass | 6,698 / **7,131 MiB** | 93% | 33% / 100% | **617 MiB** |

The drop to 617 MiB available RAM is explained in "Host RAM: the runner's prompt cache" below.

### Field accuracy against what the text says

**Ingredient extraction (model alone):**

| Think | Texts scored | (group, relation) precision / recall | Group precision / recall | Exact texts | Spans dropped as ungrounded | Trap false alarms³ |
|---|---|---|---|---|---|---|
| off | 9 (1 invalid) | 0.955 / 0.778 (21 TP, 1 FP, 6 FN) | 1.000 / 0.815 | 5/9 | 0 of 36 | 0 |
| on | 2 (8 invalid) | 1.000 / 1.000 | 1.000 / 1.000 | 2/2 | 0 of 2 | 0 |

³ The traps were cocoa butter (in four texts), sunflower lecithin, an emulsifier with no source named, and coconut. None was labelled as milk, soy or tree nut. Coconut appears only in the Lidl text, which was invalid in both modes of the main run, so the coconut trap was exercised only in the re-run and the follow-up runs.

**Misses with think off.** These are why the lexicon verifier stays in the loop, and why the absence of a model span never counts as "free from":
- German texts: the German words for butter, whey powder, whole-milk powder and whole-egg powder were not read as milk or egg, and a misspelt "nuts" in a may-contain line was labelled `none`.
- English chocolates: soya lecithin was missed once and labelled `may_contain` once.

**Notice extraction:**

| Think | UPCs precision / recall | UPCs invented | Allergens precision / recall | Lots precision / recall | reason_type correct |
|---|---|---|---|---|---|
| off | 1.000 / 0.957 (22 of 23) | 0 | 0.875 / 0.933 | 1.000 / 1.000 (7 of 7) | 9/10 |
| on | 1.000 / 0.826 (19 of 23) | 0 | 1.000 / 1.000 | 1.000 / 0.857 | 10/10 |

**UPC notes:**
- Three of the 23 UPCs printed in the notices fail the GTIN check digit: an 11-digit code on H-1335-2026, and a 13-digit and an 11-digit code on H-1172-2026. The model copied them as written; `verify/gtin.ts` must drop them.
- The UPCs missed were on H-1172-2026, the notice with 16 codes.

**Allergen errors with think off:**
- H-0941-2026: "undeclared allergen (shrimp)" became `soy` with `reason_type: other`.
- H-1172-2026: `peanut` was added to pecans and pistachios.
- Think on got both right.

**Planner** (10 constructed states each):

| Think | Valid | Tool advances an open checklist item | Tool completes the *first* open item | `done` correct | Input id correct | Evidence ids all real⁴ | Contradiction surfaced (when expected) | Checklist echoed unchanged | Thought ≤60 words |
|---|---|---|---|---|---|---|---|---|---|
| off | 10/10 | 9/10 | 8/10 | 10/10 | 9/9 | 10/10 | 3/4 | 8/10 | 10/10 |
| on | 10/10 | 10/10 | 10/10 | 10/10 | 9/9 | 10/10 | 2/4 | 5/10 | 10/10 |

⁴ Enforced by the schema: `evidence_ids` is an enum of the ids the host has recorded, so a valid reply cannot cite any other id. This column shows that the constraint works, not that the model chose the right evidence.

**What the planner results mean for the build:**
- **The host owns the checklist.** The model's echo of the checklist was changed in 2/10 (think off) and 5/10 (think on) calls, so `loop/checklist.ts` overwrites it and never reads it back.
- **Evidence ids are a dynamic enum, like the tool enum.** In the smoke test, before the enum, the model cited `ev-3-01` for `ev-p3-01`.

## Fix applied after the run, and its re-run

**What failed.** The single think-off extraction failure was the multilingual Lidl label (the H-1275-2026 product). The model kept repeating the same soy span until `num_predict` cut the reply, on both tries.

**The fix.** The span array's `maxItems` went from 40 to 32. Pretty-printed spans cost about 38 tokens each, so 32 spans fit inside 1,536 tokens and a repeating reply now closes as valid JSON. This makes the reply parse; it does not stop the repetition.

**Re-run** (20 think-off extraction calls, same inputs as the fix was made on, `--think off --jobs ingredient,notice`):

| Metric | Result |
|---|---|
| JSON valid | **20/20** |
| Wall time, median / max | 0.83 / 8.78 s |
| tok/s, median | 160.3 |
| GPU memory peak | 6,697 MiB |
| Ingredient (group, relation) precision / recall | 0.958 / 0.767 over all 10 texts |
| Group precision / recall | 1.000 / 0.800 |
| Lidl label | **Valid but degenerate.** 32 spans, 29 of them the same soy span; wheat and soy found, milk (`lait entier en poudre`) missed. 4 distinct spans after dedupe. |
| Notice scores | Identical to the main run (temperature 0, seed 7) |

**What the build does about it:**
- `dedupeSpans` (`agent/src/llm/grounding.ts`) removes repeated spans (same normalised text, group and relation) before verifying. Extraction must call it.
- The lexicon verifier is mandatory on every text, and a missing model span never means "free from". On the Lidl label it is the verifier, not the model, that has to catch milk.
- A repeat penalty and splitting long multilingual labels into chunks were not tried.

## Host RAM: the runner's prompt cache

**Why.** In the main run, available RAM fell to 617 MiB during the think-on pass. That run saved only per-phase statistics, so the bench now samples the private memory of `ollama serve` and its `llama-server` runner every second and saves every sample.

**Soak** (`bench.ts soak`, 4B Q4, client RAM guard on, watchdog at 1,536 MiB for 3 s). The growth rule was set before the run: growth counts as reproduced if the runner's private memory rises more than 2,048 MiB above its level after the first call, or the guard or watchdog fires.

| Run | Calls | Runner private memory | Available RAM, min | Notes |
|---|---|---|---|---|
| Think on, cache on (`soak-2026-10-23T00-39-25-107Z`) | 20 planner (the 10 states twice), then 10 ingredient at 4,096 tokens with one retry | 4,396 MiB after call 1 → 6,866 after the 10 distinct planner prompts → 7,310 after the repeat pass → **9,903 MiB peak** (+5,507) | 1,848 MiB | **Reproduced.** The RAM guard fired once, before the last call: 1,904 MiB available, then 8,446 MiB after the unload. The model reloaded at 4,801 MiB. |
| Think off, cache on (`soak-2026-10-23T00-40-35-782Z`) | 10 planner | 4,390 → 5,700 MiB (+1,310) | 5,836 MiB | Same pattern, about half the step per prompt. |
| Think on, cache off (`soak-2026-10-23T00-41-56-565Z`) | 10 planner | 4,395 → 4,403 MiB (peak 4,728) | 6,924 MiB | Temporary second Ollama server on 127.0.0.1:11435 with `LLAMA_ARG_CACHE_RAM=0`, stopped afterwards. Same output tokens on every call; median wall time 3.85 s, against 3.86 s with the cache on. |

**What the samples show:**
- On the first pass over the 10 planner prompts, the runner grew by 0–525 MiB per call (median 265 MiB). When the same 10 prompts were sent again, 9 of 10 calls changed it by 10 MiB or less, and one rose 435 MiB. In the long phase, the 8 calls that ran to the token cap on both attempts added 603 MiB (the first) and then about 331 MiB each; the 2 short valid calls added under 3 MiB.
- Unloading the model returned the memory within the guard's wait (1,904 → 8,446 MiB available).
- The bundled `llama-server` keeps a prompt cache in host RAM (`--cache-ram`, default cap 8,192 MiB, settable through the `LLAMA_ARG_CACHE_RAM` environment variable). It also saves idle slots to that cache on each new task. Ollama's runner command line does not set it. With the cache disabled, the growth disappeared.
- **Cause:** the runner's prompt cache. It is not think mode: think off grows too, at about half the step (its replies are shorter). In the agent every planner step is a new prompt, so with the cache on, the runner can grow to about 4.4 GB plus the 8 GB cap in either think mode (`estimated`). That is more than this PC has available (about 8.5 GB at idle in these runs).

**Decisions:**
- **RAM guard, on by default** (`OllamaClient`, `agent/src/llm/ollama.ts`). Before each call, if available host RAM is below `CLEARSHELF_MIN_AVAILABLE_RAM_MIB` (default 2,048) and the model is loaded, the guard unloads it and the call reloads it, about 2 s. At most one guard unload per 60 s, so RAM pressure from other programs does not reload the model on every call. Each unload is recorded in `ramGuardEvents`. It fired once in the soak, as designed.
- **Think on stays** for the planner and briefs. Turning think off everywhere would halve the growth rate without stopping it, and the planner is better with think on (10/10 against 8/10 on completing the first open checklist item). `CLEARSHELF_THINK=off` (`agent/src/llm/settings.ts`) switches every job to think off if the lead wants it.
- **Option for the PC owner:** set `LLAMA_ARG_CACHE_RAM` in Ollama's environment (0, or a small cap) and restart Ollama. With 0, the soak stayed flat at no measured speed cost. This changes every Ollama model on the PC, so it is the owner's setting, not something the repo changes.

## Optional Q8 A/B

Same session, same 10 ingredient texts, think off, `num_predict` 1,536, Q4 first (`g8-2026-10-23T00-27-21-006Z`), then Q8 (`g8-2026-10-23T00-28-24-686Z`). The prompts were tuned on Q4, on these same texts.

| Metric | Q4_K_M | Q8_0 |
|---|---|---|
| JSON valid | 10/10 | 10/10 |
| Spans dropped as ungrounded | 0 of 68 | 0 of 76 |
| (group, relation) precision / recall | 0.958 / 0.767 (23 TP, 1 FP, 7 FN) | 1.000 / 0.867 (26 TP, 0 FP, 4 FN) |
| Group precision / recall | 1.000 / 0.800 | 1.000 / 0.867 |
| Exact texts | 5/10 | 8/10 |
| Trap false alarms | 0 | 0 |
| Lidl label | valid but degenerate (29 repeated soy spans), milk missed | valid but degenerate (27 repeated soy spans), milk found |
| tok/s, median | 162.5 | 117.4 |
| Wall time, median / max | 1.20 / 8.65 s | 2.55 / 11.78 s |
| GPU memory peak | 6,885 MiB | 8,071 MiB |
| Available RAM, minimum (idle level before load) | 6,744 MiB (8,449) | 6,213 MiB (8,203) |

Q8 meets the adoption rule: validity and grounding are no worse, at 117 tok/s. Its gain is 3 more correct (group, relation) pairs out of 30, on the texts the prompts were tuned on. It costs about 1.2 GB more VRAM, a 531 MiB lower minimum of available host RAM in this run (the idle level was already 246 MiB lower), and about twice the median wall time. Notice extraction, the planner and the soak were measured on Q4 only. **Q4 stays the default.** Switching is the lead's decision, and it would need the notice, planner and soak runs repeated on Q8.

## G8b: `nemotron-3-nano:30b`

**4B baseline on the brief job** (same constructed inputs, think off then on):

| Think | Valid | Wall time, median / max | tok/s, median | Output tokens, median |
|---|---|---|---|---|
| off | 3/3 | 1.10 / 2.55 s (including 1.85 s load) | 154.1 | 101 |
| on | 3/3 | 4.17 / 4.30 s | 160.2 | 654 |

**Citation format in the brief text.**
- With think off, ids inside the prose came out malformed in all 3 briefs (`ev-2-02`, `ev-01`, `ev- b3-01`).
- With think on, 2 of 3 cited exact ids.
- The brief should gain a `cited_ids` array constrained to the evidence-id enum, as the planner's is.

**Escalations.** Three of the six briefs escalated a HOLD proposal to BLOCK (inputs 1 and 3). The policy allows escalation only in the stricter direction.

**30B pre-check** (measured inputs, `estimated` projection; RAM figure measured after the 4B was unloaded):

| Item | Value |
|---|---|
| Model size (Ollama tags) | 23,148 MiB |
| Free VRAM | 12,350 MiB |
| VRAM reserve for KV cache and compute | 1,024 MiB |
| Weights left in host RAM (`estimated`) | 11,822 MiB |
| Available host RAM before load | 7,971 MiB |
| Projected free host RAM with the 30B loaded (`estimated`) | **−3,851 MiB** (the gate needs ≥3,072) |

**Why the 30B was not loaded.** The gate cannot pass on this machine with Zetaris and the other host services running. Loading it would only have pushed the PC into paging. The bench therefore skips the load. `--force` loads it anyway, with a watchdog that stops the run and unloads the model if available RAM stays under 2 GB for 3 s. **No 30B throughput figure exists.**

## Adopted settings for the build

The per-job values are in `agent/src/llm/settings.ts` (`jobSettings`).

| Job | Model | think | num_predict | Notes |
|---|---|---|---|---|
| Ingredient extraction | 4B Q4_K_M | off | 1,536 | Span `maxItems` 32. `dedupeSpans`, then the grounding drop rule. Lexicon verifier always runs. |
| Notice extraction | 4B Q4_K_M | off | 1,536 | UPCs digits-only by schema. Check digit and literal-presence checks in `verify/gtin.ts`. |
| Planner (Markovian step) | 4B Q4_K_M | on | 2,048 (observed max 777) | Dynamic tool enum and evidence-id enum. The host owns the checklist. Two invalid replies lead to a fallback step. |
| Adjudication brief | 4B Q4_K_M | on | 2,048 (observed max 680) | Add a `cited_ids` enum. Escalation only. |
| H-MEM miner | 4B Q4_K_M | off | 1,536 | Bare JSON string array (`minerSchema`). Not benched. |
| All jobs | | | | RAM guard on (2,048 MiB). `CLEARSHELF_THINK=off` forces think off everywhere. Every non-loopback model host is refused and counted (`refusedModelHostAttempts()`), for the "0 cloud model calls" figure. |
| 30B tier | none | | | Cut (G8b). |
| Q8 tier | not adopted | | | Meets the rule; lead's decision (see the Q8 section). |

## Reproduce

```bash
cd agent
npx vitest run test/llm.test.ts                                        # offline unit tests (mocked Ollama)
npx tsx src/llm/bench.ts g8                                            # 60 calls: 20 extraction + 10 planner, think off then on
npx tsx src/llm/bench.ts g8 --think off --jobs ingredient,notice       # the re-run
npx tsx src/llm/bench.ts g8 --model nemotron-3-nano:4b-q8_0 --think off --jobs ingredient   # Q8 arm (run the Q4 arm the same way)
npx tsx src/llm/bench.ts g8b                                           # 4B brief baseline, then the 30B pre-check (add --force to load)
npx tsx src/llm/bench.ts soak                                          # host-RAM soak: 20 planner + 10 long think-on calls
npx tsx src/llm/bench.ts soak --think off --calls 10 --long 0          # think-off control
```

The bench reads `data/bench/off.json` and `data/bench/fda_200.json`. These are gitignored, because Open Food Facts ingredient text is never committed. `npx tsx src/llm/benchFetch.ts` fetches them again into a new `data/bench/fetch-<time>/` directory, with a request log. It makes one openFDA call, one FSA call and one Open Food Facts call per bench barcode, 3 s apart. Product data changes over time, so results on a fresh fetch can differ from the ones above.

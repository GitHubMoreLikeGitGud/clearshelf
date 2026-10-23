# C3: Multilingual lexicon, jurisdiction, GTIN normaliser and claim tester

## Goal

The deterministic verification layer exists in `agent/src/verify/` and is unit-tested: a multilingual allergen lexicon (EN, DE, FR, ES, IT) with traps, precautionary and free-from patterns; a lexicon verifier that checks model spans; the naive keyword baseline used in the evaluation; the UK/US jurisdiction module; the GTIN normaliser; and the claim tester. None of it calls a model or the network.

## Workspace

This repository. Other work may be in progress in the working tree while this task runs (for example in `gateway/` or `zetaris/`). Leave every file that is not under **Deliverables** alone.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/style.mdc`, `.cursor/rules/data-licences.mdc`.
- `data/reference/market_allergens.json`: the cited UK and US allergen lists (`data[]`: `market_code`, `market`, `allergen`, `display_name`, `statute`, `edition`, `citation_url`, `includes`, `excludes`, `notes`) and `rule_conflicts[]` (`coconut-tree-nut`, `pine-nut-scope`, `gluten-vs-wheat`). This file is the only source for which groups and species are major allergens in a market, for display names, and for rule-conflict wording. If it is missing, stop and report; never type the lists from memory.
- `agent/src/llm/schemas.ts`: `ALLERGEN_GROUPS`, `AllergenGroup`, `SPAN_RELATIONS`, `SpanRelation`, `LABEL_LANGUAGES`, `ExtractionSpan`. Import these types; do not redefine them.
- `agent/src/llm/grounding.ts`: `normaliseForGrounding`, `isGrounded`, `groundSpans`. Grounding uses these functions; do not write a second normaliser for grounding.
- `agent/tsconfig.json` and `agent/package.json` (ES modules, `.ts` import extensions, `@types/node` for `node:fs`).

**Do not open** `scripts/curate-manifest.ts`, `agent/test/curate-rules.test.ts`, or the `label_rules`, `reference_labels` and `scenario_notes` in `data/manifest/skus.json`. They produce the evaluation's reference labels; a lexicon copied from them would make the model-plus-verifier score circular. Write the word lists independently.

## Inputs

- Allergen groups: `milk, egg, fish, crustacean, mollusc, tree_nut, peanut, gluten_cereal, wheat, soy, sesame, celery, mustard, lupin, sulphite` (plus `none` in the model schema). `wheat` is the cereal species (any Triticum: wheat, spelt, khorasan, durum, semolina, einkorn, emmer, triticale); `gluten_cereal` is a cereal containing gluten that is not wheat (rye, barley, oats) or a bare "gluten".
- Model span shape: `ExtractionSpan` from `schemas.ts`: `{evidence_text, allergen_group, relation: contains|may_contain|free_from_claim|not_allergen, lang}`.
- Claim labels as they arrive from the USL `product.labels` column: Open Food Facts tags joined with commas. Tags seen in the intake manifest: `en:vegan`, `en:vegan-action`, `en:the-vegan-society`, `en:no-gluten`, `en:vegetarian`.
- Barcode formats as they appear in openFDA product descriptions (digits replaced by 9): `UPC 9 99999 99999 9`, `UPC: 9-99999-99999-9`, `UPC Code 9 9999999999 9`, `UPC 9 99 99999 99999 9` (14 digits), `UPC Codes: 999999999999`, `UPC code: 9999999999999`, `GTIN: 99999999999999`, `GTIN/UPC 99999999999999`, `UPC code: 99999999999` (11 digits, leading zero dropped), and several codes in one description separated by commas or "and".
- openFDA food recall numbers start with `H-` or `F-` (for example `H-1328-2026`, `F-0636-2025`; 7 of the 18 recall-matched manifest SKUs are `F-`). Every validator accepts both: `^[FH]-\d{4}-\d{4}$`.

Which group a word belongs to is a matter of language (what the word means). Whether a group or species is a major allergen in a market is law, and comes only from the reference file. Do not add legal rules that are not in the reference file: refined-oil and glucose-syrup exemptions, thresholds and similar rules are out of scope. The lexicon reports the hit and the term; later layers decide.

## Deliverables

| File | Contents |
|---|---|
| `agent/src/verify/lexicon.data.ts` | The word lists, as typed data: allergen terms per group and language (with a tree-nut `species` id where the word names one); traps; rule-conflict terms; precautionary patterns; free-from patterns. Every trap and rule term has a one-line `reason`. |
| `agent/src/verify/lexicon.ts` | `lexiconScan`, `verifySpans`, `keywordBaseline`; re-exports `isGrounded` from `../llm/grounding.ts`. |
| `agent/src/verify/jurisdiction.ts` | Reads the reference file; `marketCodes`, `marketCode`, `isMajorAllergen`, `displayName`, `ruleConflicts`. |
| `agent/src/verify/gtin.ts` | `checkDigitOk`, `normalise`, `extractUpcs`. |
| `agent/src/verify/claims.ts` | `claimsFromLabels`, `claimsFromText`, `testClaim`. |
| `agent/test/lexicon.test.ts`, `agent/test/jurisdiction.test.ts`, `agent/test/gtin.test.ts`, `agent/test/claims.test.ts` | vitest suites with at least the cases below. |
| `agent/test/fixtures/synthetic-ingredients.ts` | Ingredient strings written for these tests, in all five languages, each entry marked `synthetic: true`. |

### lexicon.data.ts

- **Allergen terms**, EN, DE, FR, ES and IT, for every group. Examples (not complete): milk: milk, whey, casein, butter, cream, buttermilk, lactose / Milch, Molke, Butter, Sahne, Vollmilchpulver / lait, lactosérum, beurre, crème / leche, suero de leche, mantequilla, nata / latte, siero di latte, burro, panna. Wheat: wheat, spelt, durum, semolina / Weizen, Dinkel / blé, froment, épeautre / trigo, espelta / frumento, grano tenero, farro. Gluten cereals other than wheat: rye, barley, oats, gluten / Roggen, Gerste, Hafer / seigle, orge, avoine / centeno, cebada, avena / segale, orzo, avena. Tree nuts with species: almond, hazelnut, walnut, cashew, pecan, Brazil nut, pistachio, macadamia, pine nut (and the other Table 1 names in the reference file), plus generic "nuts" with no species. Peanut: peanut, groundnut / Erdnuss / arachide, cacahuète / cacahuete, maní / arachidi. Egg, fish, crustacean, mollusc, soy (soya, soja, lecithin only as "soy(a) lecithin" and its translations), sesame, celery, mustard, lupin, sulphite (sulphite, sulfite, sulphur dioxide, E220 to E228 and translations).
- German compounds: German terms also match inside a word (`Vollmilchpulver`, `Weizenmehl`, `Haselnusskerne`, `Sojalecithin`). Short German words that occur inside unrelated words (for example `Ei` inside `Weizen`) match only as whole words or in listed compounds (`Vollei`, `Eigelb`, `Hühnerei`, `Eipulver`). Other languages match on word boundaries, with plurals.
- **Traps** (a trap match suppresses every allergen hit it overlaps, and is itself reported as `not_allergen` for the group it resembles): cocoa butter (Kakaobutter, beurre de cacao, manteca de cacao, burro di cacao); coconut milk and other plant drinks (Kokosmilch, lait de coco, leche de coco, latte di cocco; oat, soy, rice and almond drink or "milk", where the plant word is still reported as its own group); peanut butter and other nut butters, shea butter (not milk); buckwheat (Buchweizen, sarrasin, trigo sarraceno, grano saraceno; not wheat or gluten); nutmeg (Muskatnuss, noix de muscade, nuez moscada, noce moscata; not a tree nut); cream of tartar (Weinstein, crème de tartre, cremor tártaro, cremor tartaro; not milk); butternut squash; water chestnut and chestnut (the reference file excludes chestnut from the US list, and the UK list does not name it); eggplant and aubergine; lactic acid and lactates (Milchsäure, acide lactique, ácido láctico, acido lattico); milk or soy protein written as German `Milcheiweiß` / `Sojaeiweiß` (milk or soy, not egg); doughnut and donut; nut-free and peanut-free wording (a free-from claim, never a `contains` hit).
- **Rule-conflict terms**: coconut (Kokos, Kokosnuss, noix de coco, coco, cocco, noce di cocco). Reported as `not_allergen` for `tree_nut` with `ruleConflict: "coconut-tree-nut"`; never a tree-nut `contains` hit.
- **Precautionary patterns**, per language: "may contain", "may also contain", "may contain traces of", "made in a factory that also handles", "not suitable for ... allergy sufferers"; "kann Spuren von ... enthalten", "kann ... enthalten"; "peut contenir (des traces de)", "traces éventuelles de"; "puede contener (trazas de)"; "può contenere (tracce di)". The scope runs from the pattern to the end of the sentence (a full stop that is not between digits, a semicolon, a line break or the end of the text); for German it also ends after `enthalten`.
- **Free-from patterns**, per language, each with the claim it makes: free from X, X-free, dairy-free, gluten-free, nut-free, glutenfrei, milchfrei, sans gluten, sin gluten, senza glutine, vegan / végan / vegano. "Lactose-free" (laktosefrei, sans lactose, sin lactosa, senza lattosio) is recognised as a `lactose_free` claim, which is not a dairy-free claim; "lactose-free milk" still contains milk.

### lexicon.ts

- `lexiconScan(text: string, lang?: "en" | "de" | "fr" | "es" | "it"): LexiconHit[]`. Scans all five languages (labels are often multilingual); `lang` only breaks ties for words that mean different things in different languages. `LexiconHit = {group, relation, term, lang, start, end, species?, trap?: {term, reason}, ruleConflict?: string, claim?: string}`. `start`/`end` index into `text.normalize("NFC")`, and `text.normalize("NFC").slice(start, end)` is the matched text. Relations: `contains`, `may_contain` (inside a precautionary scope), `free_from_claim`, `not_allergen` (traps and rule terms). Hits are sorted by `start`.
- `verifySpans(text: string, spans: ExtractionSpan[])` returns `{rows: AgreementRow[], dropped: ExtractionSpan[], droppedCount: number}`.
  - A span whose `evidence_text` is not grounded in `text` (`isGrounded`) is dropped and counted, never matched.
  - A grounded span matches the lexicon hits that overlap its location in the text. `wheat` and `gluten_cereal` are compatible groups when the lexicon term is a wheat term (wheat is a cereal containing gluten); other groups must be equal.
  - `AgreementRow = {group, relation, model: boolean, lexicon: boolean, agree: boolean, evidence_text, grounded: true, lexicon_relation?, term?}`. A model span with a compatible lexicon hit of the same relation agrees. A model `contains` on text the lexicon reads as a trap or rule term disagrees. A lexicon `contains` or `may_contain` hit that no span covers is a row with `model: false, agree: false` (the model missed it). Lexicon-only `not_allergen` and `free_from_claim` hits produce no row.
- `keywordBaseline(text: string)`: system K in the evaluation. Plain case-insensitive keyword matches over the same allergen words, deliberately unaware of traps, rule terms and precautionary scope: every hit is `contains`. Returns `{group, term, start, end}[]`.

### jurisdiction.ts

- Reads `data/reference/market_allergens.json` with `node:fs`, resolved from the module's own location (`new URL(..., import.meta.url)`), once.
- `marketCodes(market: "UK" | "US"): string[]` — the `market_code` values for the market, from the file.
- `marketCode(market, group, species?): string | null` — UK `wheat` and `gluten_cereal` are `UK:gluten_cereal`; US `wheat` is `US:wheat`; US `gluten_cereal` (rye, barley, oats, bare gluten) is `null`; `null` for any group the market does not list (for example US `mollusc`, `celery`, `mustard`, `lupin`, `sulphite`).
- `isMajorAllergen(market, group, species?): boolean` — `marketCode` is not null and, for `tree_nut` with a species, the species is in that market's `includes` (so pine nut is a US tree nut and not a UK one; chestnut and coconut are neither). Map species ids to the reference names in one table and test that every mapped name occurs in the file.
- `displayName(market, group, species?): string | null` — the reference `display_name`, plus the cereal or nut in parentheses when known: UK `wheat` gives "Cereals containing gluten (wheat)", UK `tree_nut` + almond gives "Nuts (almond)", US `wheat` gives "Wheat", never "gluten".
- `ruleConflicts(market, text): RuleConflict[]` — `{id, market, evidence_text, summary, handling}`, with `id`, `summary` and `handling` copied from the reference `rule_conflicts[]` (never written in code) and `evidence_text` an exact substring of `text`. It reports `coconut-tree-nut`, in either market, when the text describes coconut as a tree nut (for example "tree nut (coconut)", "tree nuts: coconut", "coconut (tree nut)", and the DE/FR/ES/IT equivalents such as "Schalenfrüchte (Kokos)" or "fruits à coque (noix de coco)"); and `pine-nut-scope` for market UK when the text names pine nuts. A plain mention of coconut is not a conflict. Conflicts are returned, never resolved here.

### gtin.ts

- `checkDigitOk(digits: string): boolean` — GS1 mod-10 for 8, 12, 13 and 14 digits.
- `normalise(raw: string)` returns `{ok: true, gtin13, transform}` or `{ok: false, reason}`. Separators (single spaces or hyphens between digit groups) are removed first and add the suffix `_grouped` to the transform. Transforms, which are what `recall_product_link.transform` stores (at most 30 characters): `ean13_exact` (13 digits), `upc12_pad13` (12-digit UPC-A, one leading 0), `gtin14_strip0` (14 digits starting with 0), `ean8_pad13` (GTIN-8, five leading zeros), `upc11_pad13` (11 digits, a UPC-A whose leading zero was dropped, two leading zeros; accepted only if the padded code passes the check digit; a missing check digit is never computed). Reasons: `check_digit`, `gtin14_case_level` (14 digits with a non-zero indicator digit: a case code, not a consumer unit), `length`. UPC-E is not expanded.
- `extractUpcs(noticeText: string)` returns `{accepted: {raw_code, gtin13, transform, start, end, keyword}[], rejected: {raw_code, reason, start, end}[]}`. `raw_code` is the exact substring (at most 40 characters). Candidates are runs of digit groups. Runs of 12, 13 or 14 digits are candidates anywhere; runs of 8 or 11 digits only when `UPC`, `GTIN`, `EAN` or `barcode` appears within the 40 characters before them (so dates, phone numbers and recall numbers are not candidates). A run whose length fits no format is split at group boundaries into consecutive codes only if every piece passes its check digit; otherwise it is rejected with reason `length`. Candidates that fail the check digit are returned under `rejected`, never dropped. The same GTIN-13 is accepted once.

### claims.ts

- `claimsFromLabels(labels: string | null): Claim[]` — `en:vegan`, `en:vegan-action` and `en:the-vegan-society` give `vegan`; `en:no-gluten` gives `gluten_free`; every other tag is ignored (`en:vegetarian` is not tested). `claimsFromText(text)` gives the claims from free-from hits (`vegan`, `dairy_free`, `gluten_free`, `nut_free`; `lactose_free` is not returned as a testable claim).
- `testClaim(claim, evidence)` with `evidence = {ingredientText: "none" | "partial" | "full", spans: {evidenceId, group, relation, verified}[], recalls: {evidenceId, recallNumber, undeclared: AllergenGroup[]}[]}` returns `{claim, verdict, contradicting: AllergenGroup[], evidenceIds: string[], reason}`.
  - Contradicting groups: `vegan` — milk, egg, fish, crustacean, mollusc; `dairy_free` — milk; `gluten_free` — gluten_cereal, wheat; `nut_free` — tree_nut, peanut. Coconut never contradicts `nut_free`.
  - Order: `NOT_SUPPORTED` if a verified `contains` span or a recall's `undeclared` list has a contradicting group (this holds even with no ingredient text); otherwise `UNTESTED` if `ingredientText` is `none` or `partial`; otherwise `PARTLY_SUPPORTED` if a verified `may_contain` span has a contradicting group; otherwise `SUPPORTED`.
  - Unverified spans never decide a verdict. `evidenceIds` lists exactly the spans and recalls the verdict rests on. A `recallNumber` that does not match `^[FH]-\d{4}-\d{4}$` throws.

## Test cases that must exist

- **Traps:** "cocoa butter" is not milk; "coconut milk" is not milk; "Kakaobutter" and "Kokosmilch" likewise; "buckwheat" and "Buchweizen" are neither wheat nor gluten_cereal; "grano saraceno" is not wheat; "nutmeg", "Muskatnuss", "noix de muscade", "nuez moscada" and "butternut squash" are not tree nuts; "cream of tartar" is not milk; "lactic acid" and "Milchsäure" are not milk; "Erdnuss" is peanut, not tree_nut; "Milcheiweiß" is milk, not egg; "Weizen" gives no egg hit; "eggplant" gives no egg hit; "peanut butter" gives peanut and no milk; "nut-free" gives a free-from claim and no tree_nut `contains`; "lactose-free milk" gives milk `contains`. The keyword baseline does flag the cocoa butter and coconut milk cases as milk, and "may contain milk" as `contains` (that is its job as the comparison system).
- **Coconut:** "noix de coco", "Kokosnuss" and "noce di cocco" give a coconut rule term and no tree_nut `contains`.
- **Precautionary:** "may contain milk" gives `may_contain` milk; "May contain milk, peanuts and nuts." gives three `may_contain` hits and nothing after the full stop is in scope; "Kann Spuren von Milch und Haselnüssen enthalten", "Peut contenir des traces de lait", "Traces éventuelles de lait", "Puede contener trazas de leche" and "Può contenere tracce di latte" give `may_contain` milk; an ingredient before the precautionary sentence stays `contains`.
- **Multilingual:** "Weizenmehl", "farine de blé", "harina de trigo" and "farina di grano tenero" give `wheat`; "Haselnüsse", "noisettes", "avellanas" and "nocciole" give `tree_nut` with species hazelnut; "Sojalecithin" and "lécithine de soja" give soy.
- **Grounding and agreement:** a span whose evidence is not in the source is dropped and counted; case and whitespace differences still ground; a model `gluten_cereal` span on "wheat flour" agrees with the lexicon `wheat` hit; a model milk `contains` span on "cocoa butter" disagrees; a lexicon milk hit with no model span is a `model: false` row.
- **Jurisdiction:** UK has 14 market codes and US 9, read from the reference file; UK wheat is `UK:gluten_cereal` and US wheat is `US:wheat`; US `gluten_cereal` and US `mollusc` are not major; pine nut is a major tree nut in the US and not in the UK; chestnut is major in neither; US display names say "Wheat", never "gluten"; "tree nut (coconut)" gives one `coconut-tree-nut` conflict for US and one for UK, with `summary` equal to the reference text; "coconut" alone gives none; "pine nuts" gives `pine-nut-scope` for UK only.
- **GTIN:** `816929000119` normalises to `0816929000119` (`upc12_pad13`, check digit valid); "UPC 8 16929 00011 9" gives the same GTIN with `upc12_pad13_grouped`; "UPC: 8-16929-00011-9" likewise; `4056489125846` is `ean13_exact`; a GTIN-14 with a leading 0 strips to its GTIN-13 (`gtin14_strip0`); a GTIN-14 with indicator digit 1 is rejected as `gtin14_case_level`; a valid GTIN-8 after "EAN" pads to 13 digits (`ean8_pad13`), and the same 8 digits with no keyword are not extracted; an 11-digit code after "UPC code:" pads with `upc11_pad13`; a 13-digit number with a wrong check digit is rejected and reported; "LOT 240915", a date such as "2026-09-15" and the recall number "F-0636-2025" are not extracted; two codes in one description separated by ", " or " and " are both extracted. Every check digit used in a test is computed by hand in a comment next to it.
- **Claims:** a vegan claim with a verified milk `contains` span is NOT_SUPPORTED; with only verified `may_contain` milk it is PARTLY_SUPPORTED; with no ingredient text and no recall it is UNTESTED; with no ingredient text and recall `H-1328-2026` reporting undeclared milk it is NOT_SUPPORTED; a recall `F-0636-2025` works the same way; a gluten-free claim with verified `may_contain` wheat is PARTLY_SUPPORTED; a nut-free claim on a fully parsed text whose only nut-like word is coconut is SUPPORTED; an unverified milk `contains` span alone does not make a vegan claim NOT_SUPPORTED; `claimsFromLabels("en:vegetarian,en:vegan,en:vegan-action")` is `["vegan"]` once; "lactose-free" gives no `dairy_free` claim; a malformed recall number throws.

## Constraints

- No model calls, no network, no runtime dependencies. Pure functions apart from reading the reference file. ES modules, TypeScript run by tsx; `node:` builtins only.
- No Open Food Facts ingredient text in committed fixtures: every test string is written for the test and marked synthetic. Public barcodes from the build plan (`816929000119`, `4056489125846`, `0850041392103`) may be used.
- Market lists, display names and rule-conflict text come only from `data/reference/market_allergens.json`.
- Do not edit `engines/`, `agent/src/llm/`, the existing tests, `agent/package.json`, `agent/tsconfig.json`, or anything outside **Deliverables**.

## Checks

- `cd agent && npm test` is green, including the four new suites and the existing ones.
- `cd agent && npx tsc --noEmit` reports no errors.

## Out of scope

Model extraction (`agent/src/extract/`), the decision policy and the statement builder (they consume this layer), legal exemptions and thresholds, and the reference data file itself.

## Commit

`C3: lexicon, jurisdiction, GTIN normaliser and claim tester (Cursor Agent)`

## Run record (2026-10-23)

Cursor Agent CLI 2026.10.22, model `Auto`, headless, workspace = this repository. The run wrote all ten deliverables (2,339 lines: the four test suites and the fixture file first, then `gtin.ts`, `jurisdiction.ts`, `claims.ts`, `lexicon.data.ts` and `lexicon.ts`), ran `npm test` once (99 of 100 passing) and then stopped: the CLI reported that the account had reached the Cursor Free plan's usage limit. Wall time 545.7 s, exit code 1. It did not commit.

Commit `C3: lexicon, jurisdiction, GTIN normaliser and claim tester (Cursor Agent)` holds Cursor Agent's files exactly as the run left them, including the one failing test. `npx tsc --noEmit` was clean on them.

Reviewer changes, in a separate commit, each with a test:

- The failing test counted the `eggplant` trap hit (`not_allergen`, group egg) as an egg hit; it now checks allergen relations only.
- `extractUpcs`: a code followed by a pack size (`UPC 816929000119 12 oz`) was lost, because the size joined the run and the 14 digits failed as a case code; two grouped codes written back to back were rejected; eight digits after "UPC" (a zero-suppressed UPC-E, 9 such codes on the saved openFDA page) were padded as if they were EAN-8, which gives a wrong GTIN, and are now rejected as `upc_e_not_expanded`; a run directly after a letter and hyphen (recall numbers such as `F-0636-2025`) is no longer a candidate.
- Lexicon: the allergen word inside a free-from claim (`gluten` in "gluten-free", `Milch` in "milchfrei", `lactose` in "lactose-free") produced a `contains` hit; German `Eiweiß` (also "protein") made `Weizeneiweiß` an egg hit; `Tintenfisch` (squid) was read as fish; nut butters in DE/FR/ES/IT were read as milk; `nuez de coco` was read as walnut; German `Nüsse` and `Grieß` were missing or too broad; a German precautionary clause could run past the end of its sentence; US shared-equipment wording ("produced on equipment also handling") was not precautionary.
- `verifySpans`: a hit under a model span was reported again as missed when the span covered more than one hit, or when the relations disagreed.
- `jurisdiction`: `displayName` gave a statutory name to a species the market does not list (UK pine nut); coconut inside a tree-nut list ("TREE NUTS (ALMOND, COCONUT)", as openFDA writes it) was not flagged; the Spanish Annex II term `frutos de cáscara` was missing.
- A test now uses the synthetic fixture file, which no test imported.

Checks after the review: `npm test` 122 passed (7 files); `npx tsc --noEmit` clean. On the saved openFDA page, `extractUpcs` finds every GTIN the curation script found plus 26 more, and the coconut rule conflict fires on 7 reports (5 before the review).

# C3: Multilingual lexicon, jurisdiction, GTIN normaliser and claim tester

## Goal

The deterministic verification layer exists and is unit-tested: a multilingual allergen lexicon with a trap list and precautionary patterns, a lexicon verifier that checks model spans, the naive keyword baseline used in the evaluation, the UK/US jurisdiction module, the GTIN normaliser, and the claim tester. None of it calls a model or the network.

## Workspace

This repository.

## Read first

- `AGENTS.md`, `.cursor/rules/safety.mdc`, `.cursor/rules/style.mdc`, `.cursor/rules/data-licences.mdc`.
- `data/reference/market_allergens.json`: the cited UK and US allergen lists (statute, edition, citation URL, display names). This file is the only source for market lists and display names. If it is missing, stop and report; never type the lists from memory.

## Inputs

- Allergen groups (fixed): `milk, egg, fish, crustacean, mollusc, tree_nut, peanut, gluten_cereal, wheat, soy, sesame, celery, mustard, lupin, sulphite, none`.
- Model span shape (from the extraction schema): `{allergen_group, relation: contains|may_contain|free_from_claim|not_allergen, evidence_text, lang}`.
- Recall notice UPCs appear in free text, for example "UPC 8 16929 00011 9" or "UPC: 816929000119".

## Deliverables

| File | Contents |
|---|---|
| `agent/src/verify/lexicon.data.ts` | Per allergen group, ingredient terms in EN, DE, FR, ES and IT (e.g. milk: milk, whey, casein, butter, cream, lactose / Milch, Molke, Butter, Sahne / lait, lactosérum, beurre, crème / leche, suero / latte, siero, burro, panna). A **trap list** of terms that look like an allergen but are not, each with the reason: cocoa butter, coconut milk, buckwheat, nutmeg, cream of tartar, butternut squash, water chestnut, eggplant/aubergine, lactic acid and lactates, peanut-free/nut-free wording. Coconut is listed separately as a **rule conflict** term (see jurisdiction). **Precautionary patterns** per language: "may contain", "made in a factory that also handles", "kann Spuren von ... enthalten", "peut contenir (des traces de)", "puede contener (trazas de)", "può contenere (tracce di)". **Free-from patterns**: "free from", "dairy-free", "gluten-free", "glutenfrei", "sans gluten", "sin gluten", "senza glutine", "vegan". |
| `agent/src/verify/lexicon.ts` | `normaliseText(s)` (Unicode NFKC, case-fold, whitespace collapse). `isGrounded(evidence, source)`: true only if `evidence` is an exact substring of `source` after `normaliseText`. `lexiconScan(text, lang?)` returns hits `{group, relation, term, start, end}`, honouring traps (a trap match suppresses the overlapping allergen hit) and precautionary scope (terms inside a precautionary clause are `may_contain`). `verifySpans(text, spans)` returns the agreement table `{group, relation, model, lexicon, agree, evidence_text, grounded}` plus a count of dropped ungrounded spans. `keywordBaseline(text)`: the naive regex baseline (system K in the evaluation): plain keyword matches, deliberately unaware of traps and precautionary wording. |
| `agent/src/verify/jurisdiction.ts` | Loads `data/reference/market_allergens.json`. `marketCodes(market)`, `isMajorAllergen(market, group)`, `displayName(market, group, species?)`. Maps groups to market codes: UK `gluten_cereal` is one Annex II entry (statement names the cereal, e.g. "Cereals containing gluten (wheat)"); US uses `wheat`, never `gluten_cereal`. `ruleConflicts(market, text)`: flags coconut described as a tree nut (US FDA guidance Edition 5 excludes it; UK Annex II does not list it), returned as a rule-against-rule conflict, never resolved here. |
| `agent/src/verify/gtin.ts` | `checkDigitOk(digits)` (GS1 mod-10). `normalise(raw)` returns `{gtin13, transform}` or null: 12-digit UPC-A padded with a leading 0 (`upc12_pad`), 13-digit EAN as is (`ean13`), 14-digit GTIN with a leading 0 trimmed (`gtin14_trim`), 8-digit EAN-8 left-padded (`ean8_pad`); digit groups separated by spaces or dashes are joined first and the transform gets a `_grouped` suffix. `extractUpcs(noticeText)` returns `{raw_code, gtin13, transform}` for every candidate that is literally present and passes the check digit; candidates failing it are returned separately as rejected, never silently dropped. Transform names are what `recall_product_link.transform` stores. |
| `agent/src/verify/claims.ts` | `testClaim(claim, evidence)` for vegan, dairy-free, gluten-free and nut-free claims: NOT_SUPPORTED if a contradicting allergen is verified as `contains` or a recall reports it undeclared; PARTLY_SUPPORTED if only `may_contain` evidence exists; SUPPORTED if the ingredients were fully parsed with no contradiction; UNTESTED if there is no ingredient text. Returns the verdict and the evidence ids it rests on. Vegan is contradicted by milk, egg, fish, crustacean and mollusc. |
| `agent/test/lexicon.test.ts`, `jurisdiction.test.ts`, `gtin.test.ts`, `claims.test.ts` | vitest suites, cases below. |
| `agent/test/fixtures/synthetic-ingredients.ts` | Ingredient strings written for the tests, in all five languages, each marked `synthetic: true`. |

## Test cases that must exist

- Traps: "cocoa butter" is not milk; "coconut milk" is not milk; "buckwheat" is neither wheat nor gluten; "nutmeg" and "butternut squash" are not tree nuts; "cream of tartar" is not milk. The keyword baseline flags at least the cocoa butter and coconut milk cases (that is its job as the comparison system).
- Precautionary: "may contain milk" gives `may_contain` milk; the German, French, Spanish and Italian equivalents do too.
- Multilingual: "Weizenmehl", "farine de blé", "harina de trigo" and "farina di grano" give `gluten_cereal` (UK) and `wheat` (US); "Haselnüsse", "noisettes", "avellanas", "nocciole" give `tree_nut`.
- Grounding: a span whose evidence is not in the source is dropped and counted; case and whitespace differences still ground.
- Jurisdiction: UK has 14 market codes and US 9, read from the reference file; US statements say "wheat", never "gluten"; a coconut tree-nut mention yields one rule conflict for US.
- GTIN: `816929000119` normalises to `0816929000119` with a valid check digit; `8 16929 00011 9` gives the same GTIN with a `_grouped` transform; a 13-digit number with a wrong check digit is rejected and reported; a lot code such as `LOT 240915` is not extracted.
- Claims: a vegan claim with a verified milk `contains` span is NOT_SUPPORTED; with only `may_contain` milk it is PARTLY_SUPPORTED; with no ingredient text it is UNTESTED.

## Constraints

- No model calls, no network, no runtime dependencies. Pure functions, ES modules, TypeScript run by tsx.
- No Open Food Facts ingredient text in committed fixtures: every test string is written for the test and marked synthetic.
- Market lists and display names come only from `data/reference/market_allergens.json`.
- Do not edit `engines/`.

## Checks

- `cd agent && npm test` is green, including the four new suites.
- If `agent/tsconfig.json` exists: `cd agent && npx tsc --noEmit` reports no errors in `src/verify/`.

## Out of scope

Model extraction (`agent/src/extract/`), the decision policy and the statement builder (they consume this layer), and the reference data file itself.

## Commit

`C3: lexicon, jurisdiction, GTIN normaliser and claim tester (Cursor Agent)`

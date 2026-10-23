// Pure scoring for the G8 bench. Every score compares model output with what the
// source text plainly says (bench.cases.ts); nothing here calls a model.

import { groundSpans } from "./grounding.ts";
import type { IngredientCase, NoticeCase, PlannerCase } from "./bench.cases.ts";
import type { IngredientExtraction, NoticeExtraction, PlannerOutput, ToolName } from "./schemas.ts";
import { wordCount, THOUGHT_MAX_WORDS } from "./schemas.ts";
import { checklistItems, completedBy, TOOL_CATALOG } from "./toolCatalog.ts";

export interface SetScore {
  tp: number;
  fp: number;
  fn: number;
  exact: boolean;
}

export function scoreSets(predicted: Iterable<string>, expected: Iterable<string>, ignore: Iterable<string> = []): SetScore {
  const ign = new Set(ignore);
  const p = new Set([...predicted].filter((x) => !ign.has(x)));
  const e = new Set([...expected].filter((x) => !ign.has(x)));
  let tp = 0;
  for (const x of p) if (e.has(x)) tp++;
  const fp = p.size - tp;
  const fn = e.size - tp;
  return { tp, fp, fn, exact: fp === 0 && fn === 0 };
}

export const normGroup = (g: string): string => (g === "wheat" ? "gluten_cereal" : g);

export interface IngredientScore {
  pairs: SetScore;
  groups: SetScore;
  spans: number;
  grounded: number;
  dropped: number;
  trapFalseAlarms: number;
  droppedTexts: string[];
}

/** Scores grounded spans only: ungrounded spans are dropped before scoring, as in production. */
export function scoreIngredient(out: IngredientExtraction, c: IngredientCase, source: string): IngredientScore {
  const { kept, dropped } = groundSpans(out.spans, source);
  const pairs: string[] = [];
  const groups: string[] = [];
  let trapFalseAlarms = 0;
  for (const s of kept) {
    if (s.relation !== "contains" && s.relation !== "may_contain") continue;
    if (s.allergen_group === "none") continue;
    const g = normGroup(s.allergen_group);
    pairs.push(`${g}:${s.relation}`);
    groups.push(g);
    const ev = s.evidence_text.toLocaleLowerCase("und");
    if (c.traps.some((t) => ev.includes(t.toLocaleLowerCase("und")))) trapFalseAlarms++;
  }
  const expPairs = [
    ...c.contains.map((g) => `${normGroup(g)}:contains`),
    ...c.may_contain.map((g) => `${normGroup(g)}:may_contain`),
  ];
  const ignorePairs = c.optional.flatMap((g) => [`${normGroup(g)}:contains`, `${normGroup(g)}:may_contain`]);
  const expGroups = [...c.contains, ...c.may_contain].map(normGroup);
  return {
    pairs: scoreSets(pairs, expPairs, ignorePairs),
    groups: scoreSets(groups, expGroups, c.optional.map(normGroup)),
    spans: out.spans.length,
    grounded: kept.length,
    dropped: dropped.length,
    trapFalseAlarms,
    droppedTexts: dropped.map((d) => d.evidence_text),
  };
}

export function gtinCheckDigitOk(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/u.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

const normLot = (l: string): string =>
  l
    .toUpperCase()
    .replace(/^(LOT|BATCH)\b\s*(NO\.?|NUMBER)?\s*[#:]?\s*/u, "")
    .replace(/\s+/gu, "");

export interface NoticeScore {
  upcs: SetScore;
  allergens: SetScore;
  lots: SetScore;
  reasonOk: boolean;
  upcsLiteral: number;
  upcsCheckDigitOk: number;
  upcsInvented: string[];
}

export function scoreNotice(out: NoticeExtraction, c: NoticeCase, sourceText: string): NoticeScore {
  const digitsSource = sourceText.replace(/[\s-]/gu, "");
  const upcs = out.upcs.map((u) => u.replace(/\D/gu, ""));
  const literal = upcs.filter((u) => u.length > 0 && digitsSource.includes(u));
  return {
    upcs: scoreSets(upcs, c.upcs),
    allergens: scoreSets(out.allergens.map(normGroup), c.allergens.map(normGroup)),
    lots: scoreSets(out.lots.map(normLot), c.lots.map(normLot)),
    reasonOk: out.reason_type === c.reason_type,
    upcsLiteral: literal.length,
    upcsCheckDigitOk: upcs.filter(gtinCheckDigitOk).length,
    upcsInvented: upcs.filter((u) => !digitsSource.includes(u)),
  };
}

export interface PlannerScore {
  /** The chosen tool completes an open checklist item (or null+done when nothing is open). */
  progress: boolean;
  /** The chosen tool completes the first open checklist item in order. */
  firstOpen: boolean;
  doneOk: boolean;
  inputOk: boolean | null;
  checklistEchoOk: boolean;
  evidenceIdsOk: boolean;
  inventedEvidenceIds: string[];
  contradictionSurfaced: boolean | null;
  thoughtWords: number;
  thoughtOk: boolean;
  tool: string | null;
}

export function scorePlanner(out: PlannerOutput, c: PlannerCase): PlannerScore {
  const items = checklistItems(c.chain);
  const open = items.filter((i) => !c.checklist[i]);
  const allDone = open.length === 0;
  const tool = (out.action?.tool ?? null) as ToolName | null;
  const completes = tool ? completedBy(c.chain, tool) : [];
  const progress = allDone ? tool === null && out.done : tool !== null && completes.some((i) => open.includes(i));
  const firstOpenItem = open[0];
  const firstOpen = allDone ? tool === null : tool !== null && completes.includes(firstOpenItem);

  let inputOk: boolean | null = null;
  if (tool) {
    const key = TOOL_CATALOG[tool]?.inputKey ?? null;
    const input = out.action?.input ?? {};
    if (tool === "policy.propose") {
      inputOk = c.chain === "sku" ? input.gtin === c.subject : (input.notice_id ?? "").includes(c.subject);
    } else if (key === "gtin") inputOk = input.gtin === (c.expectInput.gtin ?? c.subject);
    else if (key === "notice_id") inputOk = (input.notice_id ?? "").includes(c.expectInput.notice_id ?? c.subject);
    else if (key === "brand" || key === "name") {
      const v = (key === "brand" ? input.brand : input.name) ?? "";
      inputOk = c.expectInput.nameToken ? v.toLowerCase().includes(c.expectInput.nameToken) : v.trim().length > 0;
    } else if (key === "query") inputOk = (input.query ?? "").trim().length > 0;
    else inputOk = true;
  }

  const given = new Set(c.evidence.map((e) => e.id));
  const invented = out.state.evidence_ids.filter((id) => !given.has(id));
  const echo = items.every((i) => out.state.checklist[i] === c.checklist[i]);
  const words = wordCount(out.thought);
  return {
    progress,
    firstOpen,
    doneOk: out.done === allDone,
    inputOk,
    checklistEchoOk: echo,
    evidenceIdsOk: invented.length === 0,
    inventedEvidenceIds: invented,
    contradictionSurfaced: c.expectContradiction ? out.state.open_contradictions.length > 0 : null,
    thoughtWords: words,
    thoughtOk: words <= THOUGHT_MAX_WORDS,
    tool,
  };
}

export function prf(s: { tp: number; fp: number; fn: number }): { precision: number | null; recall: number | null } {
  return {
    precision: s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : null,
    recall: s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : null,
  };
}

export function sumSets(scores: SetScore[]): { tp: number; fp: number; fn: number; exact: number; n: number } {
  return scores.reduce(
    (a, s) => ({ tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn, exact: a.exact + (s.exact ? 1 : 0), n: a.n + 1 }),
    { tp: 0, fp: 0, fn: 0, exact: 0, n: 0 },
  );
}

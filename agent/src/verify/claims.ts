/** Claim extraction from OFF labels / free-from text, and claim testing against evidence. */

import type { AllergenGroup } from "../llm/schemas.ts";
import { lexiconScan } from "./lexicon.ts";

export type Claim = "vegan" | "dairy_free" | "gluten_free" | "nut_free";
export type ClaimVerdict = "SUPPORTED" | "PARTLY_SUPPORTED" | "NOT_SUPPORTED" | "UNTESTED";

const RECALL_NUMBER = /^[FH]-\d{4}-\d{4}$/u;

const LABEL_TO_CLAIM: Record<string, Claim> = {
  "en:vegan": "vegan",
  "en:vegan-action": "vegan",
  "en:the-vegan-society": "vegan",
  "en:no-gluten": "gluten_free",
};

const CONTRADICTING: Record<Claim, AllergenGroup[]> = {
  vegan: ["milk", "egg", "fish", "crustacean", "mollusc"],
  dairy_free: ["milk"],
  gluten_free: ["gluten_cereal", "wheat"],
  nut_free: ["tree_nut", "peanut"],
};

export function claimsFromLabels(labels: string | null): Claim[] {
  if (!labels) return [];
  const seen = new Set<Claim>();
  for (const tag of labels.split(",")) {
    const claim = LABEL_TO_CLAIM[tag.trim()];
    if (claim) seen.add(claim);
  }
  return [...seen];
}

export function claimsFromText(text: string): Claim[] {
  const seen = new Set<Claim>();
  for (const hit of lexiconScan(text)) {
    if (hit.relation !== "free_from_claim" || !hit.claim) continue;
    if (hit.claim === "lactose_free") continue;
    if (
      hit.claim === "vegan" ||
      hit.claim === "dairy_free" ||
      hit.claim === "gluten_free" ||
      hit.claim === "nut_free"
    ) {
      seen.add(hit.claim);
    }
  }
  return [...seen];
}

export interface ClaimSpanEvidence {
  evidenceId: string;
  group: AllergenGroup;
  relation: "contains" | "may_contain" | "free_from_claim" | "not_allergen";
  verified: boolean;
}

export interface ClaimRecallEvidence {
  evidenceId: string;
  recallNumber: string;
  undeclared: AllergenGroup[];
}

export interface ClaimEvidence {
  ingredientText: "none" | "partial" | "full";
  spans: ClaimSpanEvidence[];
  recalls: ClaimRecallEvidence[];
}

export interface ClaimTestResult {
  claim: Claim;
  verdict: ClaimVerdict;
  contradicting: AllergenGroup[];
  evidenceIds: string[];
  reason: string;
}

export function testClaim(claim: Claim, evidence: ClaimEvidence): ClaimTestResult {
  for (const r of evidence.recalls) {
    if (!RECALL_NUMBER.test(r.recallNumber)) {
      throw new Error(`malformed recall number: ${r.recallNumber}`);
    }
  }

  const contradictingGroups = CONTRADICTING[claim];
  const evidenceIds: string[] = [];
  const contradicting = new Set<AllergenGroup>();

  // Verified contains spans or recall undeclared → NOT_SUPPORTED
  for (const span of evidence.spans) {
    if (!span.verified || span.relation !== "contains") continue;
    if (contradictingGroups.includes(span.group)) {
      contradicting.add(span.group);
      evidenceIds.push(span.evidenceId);
    }
  }
  for (const recall of evidence.recalls) {
    for (const g of recall.undeclared) {
      if (contradictingGroups.includes(g)) {
        contradicting.add(g);
        if (!evidenceIds.includes(recall.evidenceId)) evidenceIds.push(recall.evidenceId);
      }
    }
  }
  if (contradicting.size > 0) {
    return {
      claim,
      verdict: "NOT_SUPPORTED",
      contradicting: [...contradicting],
      evidenceIds,
      reason: "verified contains or recall undeclared allergen contradicts claim",
    };
  }

  if (evidence.ingredientText === "none" || evidence.ingredientText === "partial") {
    return {
      claim,
      verdict: "UNTESTED",
      contradicting: [],
      evidenceIds: [],
      reason: "ingredient text is missing or only partial",
    };
  }

  // An unverified contains span that would contradict the claim leaves a contradiction unresolved:
  // the claim cannot be supported, and the span alone cannot refute it.
  const unverified = evidence.spans.filter(
    (s) => !s.verified && s.relation === "contains" && contradictingGroups.includes(s.group),
  );
  if (unverified.length > 0) {
    return {
      claim,
      verdict: "UNTESTED",
      contradicting: [...new Set(unverified.map((s) => s.group))],
      evidenceIds: unverified.map((s) => s.evidenceId),
      reason: "unverified contradiction",
    };
  }

  // Full text: may_contain → PARTLY_SUPPORTED. An unverified may_contain (a precautionary find
  // the model and the verifier do not agree on) qualifies the claim too: it cannot be SUPPORTED.
  let unverifiedOnly = true;
  for (const span of evidence.spans) {
    if (span.relation !== "may_contain") continue;
    if (contradictingGroups.includes(span.group)) {
      contradicting.add(span.group);
      if (!evidenceIds.includes(span.evidenceId)) evidenceIds.push(span.evidenceId);
      if (span.verified) unverifiedOnly = false;
    }
  }
  if (contradicting.size > 0) {
    return {
      claim,
      verdict: "PARTLY_SUPPORTED",
      contradicting: [...contradicting],
      evidenceIds,
      reason: unverifiedOnly ? "unverified may_contain allergen qualifies the claim" : "verified may_contain allergen qualifies the claim",
    };
  }

  return {
    claim,
    verdict: "SUPPORTED",
    contradicting: [],
    evidenceIds: [],
    reason: "no contradicting verified evidence",
  };
}

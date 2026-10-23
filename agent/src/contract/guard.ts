// Scout Intent, partial reimplementation (labelled as such): the injection guard. Every
// untrusted text (Open Food Facts names and ingredients; openFDA product descriptions,
// reasons and code info; FSA titles) is scanned before any model sees it. A hit wraps the
// text as <untrusted> and raises the flag `untrusted_text`, which forces a HOLD (policy
// R4). Text is never dropped. Patterns follow Scout's injection check (instruction
// override, role confusion, role drift, out-of-band tool references) plus markup and
// script injection, control characters and long base64, and one food-domain family:
// text that tells the agent to change a decision ("mark this product allergen-free").

import { createHash } from "node:crypto";

export type GuardKind =
  | "instruction_override"
  | "role_confusion"
  | "role_drift"
  | "tool_or_markup"
  | "credential_or_privilege"
  | "decision_tampering"
  | "control_chars"
  | "script_url"
  | "long_base64";

interface Rule {
  kind: GuardKind;
  id: string;
  re: RegExp;
}

const RULES: Rule[] = [
  // "Ignore all previous instructions", "disregard the rules above", "forget your instructions".
  { kind: "instruction_override", id: "override-previous", re: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|your\s+|these\s+|those\s+|my\s+)?(previous|prior|above|earlier|preceding|foregoing|existing|original|system)\b/iu },
  { kind: "instruction_override", id: "override-rules", re: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|your\s+|these\s+|those\s+|my\s+)?(instructions?|rules?|prompts?|guidelines?|directions?|polic(y|ies)|constraints?|user|system\s+prompt)\b/iu },
  { kind: "instruction_override", id: "new-instructions", re: /\bnew\s+(instructions?|rules?|task)\s*:/iu },
  // Role confusion markers.
  { kind: "role_confusion", id: "role-tag", re: /<\s*\/?\s*(system|user|assistant|developer|tool|instructions?)\s*>/iu },
  { kind: "role_confusion", id: "inst-tag", re: /\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>/iu },
  { kind: "role_confusion", id: "chat-token", re: /<\|\s*(im_start|im_end|system|user|assistant|endoftext)\s*\|>/iu },
  { kind: "role_confusion", id: "system-heading", re: /^\s*#{1,6}\s*(system|instructions?)\s*:?\s*$/imu },
  { kind: "role_confusion", id: "system-colon", re: /(^|[.!?]\s+)(SYSTEM|ASSISTANT)\s*:/u },
  // Role drift.
  { kind: "role_drift", id: "you-are-now", re: /\byou\s+are\s+(now|no\s+longer)\b/iu },
  { kind: "role_drift", id: "pretend", re: /\b(pretend|act|behave|roleplay)\s+(to\s+be|as|like)\s+(an?\s+|the\s+)?(system|admin(istrator)?|developer|root|assistant|operator|officer|compliance\s+officer|database\s+admin(istrator)?)\b/iu },
  { kind: "role_drift", id: "mode-switch", re: /\b(unrestricted|developer|god|jailbreak|dan)\s+mode\b/iu },
  { kind: "role_drift", id: "from-now-on", re: /\bfrom\s+now\s+on\b[^.\n]{0,40}\b(you|ignore|respond|answer|output)\b/iu },
  // Tool or markup injection, including the Markovian loop's own markers.
  { kind: "tool_or_markup", id: "loop-marker", re: /<\s*NEEDS_TOOL\b|\[\s*(STATE_CHECKPOINT|TASK_COMPLETE)\s*\]/iu },
  { kind: "tool_or_markup", id: "tool-call", re: /\b(tool_calls?|function_call)\b/iu },
  { kind: "tool_or_markup", id: "html-active", re: /<\s*(script|iframe|object|embed|svg|img|link|meta)\b/iu },
  { kind: "tool_or_markup", id: "event-handler", re: /\bon(error|load|click|mouseover)\s*=/iu },
  { kind: "tool_or_markup", id: "tool-ref", re: /\b(use|call|invoke|run|open)\s+(the\s+)?[a-z][a-z0-9]*(_[a-z0-9]+)+\b/iu },
  // Credentials and privilege.
  { kind: "credential_or_privilege", id: "grant", re: /\b(grant|give)\s+(me|us|yourself)\s+(admin|root|access|privileges?|permissions?)\b/iu },
  { kind: "credential_or_privilege", id: "reveal", re: /\b(reveal|show|print|dump|leak|expose|output)\s+(all\s+|the\s+|any\s+|your\s+)?(stored\s+)?(credentials?|api\s*keys?|secrets?|passwords?|tokens?|system\s+prompt|contract\s+secret)\b/iu },
  // Food domain: text that tries to set a decision or a free-from status.
  { kind: "decision_tampering", id: "mark-free", re: /\b(mark|classify|treat|flag|record|declare|list)\s+(this|the|it|that)?\s*(product|item|sku|listing|label)?\s*(as\s+)(allergen|nut|peanut|gluten|dairy|milk|egg|soy|sesame)[-\s]?free\b/iu },
  { kind: "decision_tampering", id: "mark-free-bare", re: /\b(mark|classify|flag)\s+(this|the|it)\s+(product\s+)?(allergen|nut|gluten|dairy|milk)[-\s]?free\b/iu },
  { kind: "decision_tampering", id: "set-status", re: /\b(set|change|update|force)\s+(the\s+)?(status|decision|clearance|verdict)\s+(to|=)\s*(clear|cleared|release|released|approved?|safe)\b/iu },
  { kind: "decision_tampering", id: "approve-this", re: /\b(approve|release|clear|whitelist)\s+(this|the)\s+(product|listing|sku|item|gtin)\b/iu },
  // Control characters: bidi overrides, zero-width, and their escaped forms.
  { kind: "control_chars", id: "bidi-zero-width", re: /[‪-‮⁦-⁩​-‏⁠﻿]/u },
  { kind: "control_chars", id: "escaped-control", re: /\\u(202[a-e]|206[6-9]|200[b-f]|2060|feff)\b/iu },
  // Script URLs.
  { kind: "script_url", id: "script-url", re: /\b(javascript|vbscript)\s*:|\bdata\s*:\s*text\/html/iu },
  // Long base64 runs (100+ characters without spaces).
  { kind: "long_base64", id: "base64", re: /(?:[A-Za-z0-9+/]{4}){25,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/u },
];

export interface GuardFinding {
  kind: GuardKind;
  rule: string;
  /** Character offset of the match. */
  index: number;
  /** At most 48 characters of the match, control characters shown as \uXXXX. */
  excerpt: string;
}

export interface GuardResult {
  source: string;
  hit: boolean;
  findings: GuardFinding[];
  kinds: GuardKind[];
  /** The text the model may see: unchanged when clean, wrapped as <untrusted> on a hit. Never dropped. */
  text: string;
  sha256: string;
  flags: "untrusted_text"[];
}

function visible(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠⁦-⁩﻿]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Wraps untrusted text so a model reads it as data; a closing tag inside the text is defused. */
export function wrapUntrusted(text: string, source: string): string {
  const safeSource = source.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return `<untrusted source="${safeSource}">\n${text.replace(/<\s*\/\s*untrusted/giu, "<\\/untrusted")}\n</untrusted>`;
}

export function scanText(text: string | null | undefined, source = "text"): GuardResult {
  const t = text ?? "";
  const findings: GuardFinding[] = [];
  for (const r of RULES) {
    const m = r.re.exec(t);
    if (m) findings.push({ kind: r.kind, rule: r.id, index: m.index, excerpt: visible(m[0].slice(0, 48)) });
  }
  const hit = findings.length > 0;
  return {
    source,
    hit,
    findings,
    kinds: [...new Set(findings.map((f) => f.kind))],
    text: hit ? wrapUntrusted(t, source) : t,
    sha256: createHash("sha256").update(t, "utf8").digest("hex"),
    flags: hit ? ["untrusted_text"] : [],
  };
}

export interface GuardReport {
  hit: boolean;
  flags: "untrusted_text"[];
  results: GuardResult[];
  /** Field name → text the model may see. */
  texts: Record<string, string>;
  summary: string;
}

/** Scans several fields of one record (e.g. an FDA notice) and reports per field. */
export function scanFields(fields: Record<string, string | null | undefined>, sourcePrefix: string): GuardReport {
  const results: GuardResult[] = [];
  const texts: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") {
      texts[name] = value ?? "";
      continue;
    }
    const r = scanText(value, `${sourcePrefix}:${name}`);
    results.push(r);
    texts[name] = r.text;
  }
  const hits = results.filter((r) => r.hit);
  return {
    hit: hits.length > 0,
    flags: hits.length ? ["untrusted_text"] : [],
    results,
    texts,
    summary: hits.length
      ? `untrusted text in ${hits.map((r) => `${r.source} (${r.kinds.join(", ")})`).join("; ")}`
      : `no injection pattern in ${results.length} field(s)`,
  };
}

export const GUARD_RULE_IDS = RULES.map((r) => r.id);

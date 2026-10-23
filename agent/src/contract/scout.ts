// Scout Intent, partial reimplementation (labelled as such): risk classes and the
// HMAC-signed execution contract. This is a subset of Scout's ExecutionContract:
// contractId, traceId, intent{primary, parameters}, risk{level, flags, approvals[]},
// toolPlan, scope{user, surface, capabilities[]}, issuedAt, expiresAt (+15 min at most),
// policyPackVersion, signature, signedBy "scout". The signature is HMAC-SHA256 over the
// canonical JSON of the contract without its signature, keyed by
// CLEARSHELF_CONTRACT_SECRET. As in Scout's own docs, this is an integrity check (it
// catches mutated, hand-crafted, expired or replayed contracts), not cryptographic-grade
// security. The Python registrar verifies the same contracts (gateway/contracts.py);
// both sides share the canonical encoding below and a test vector.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";

export const POLICY_PACK_VERSION = "clearshelf-scout-subset@1";
export const CONTRACT_TTL_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;

export type RiskLevel = "low" | "medium" | "high";

/** Every action an execution contract can authorise, with its risk class (SPEC 4, Scout subset). */
export const RISK_CLASSES = {
  read: "low",
  HOLD: "low",
  BLOCK: "low",
  supplier_draft: "low",
  register_off: "medium",
  refresh_feeds: "medium",
  reactivate: "medium",
  CLEAR: "high",
  CLEAR_WITH_STATEMENT: "high",
  RELEASE: "high",
  free_from_statement: "high",
} as const satisfies Record<string, RiskLevel>;
export type ContractAction = keyof typeof RISK_CLASSES;

export const SURFACES = ["clearshelf-ui", "clearshelf-agent"] as const;
export type Surface = (typeof SURFACES)[number];

export const OFFICER = "officer";

export interface Approval {
  kind: "officer-approval";
  by: string;
  at: string;
  decision: "approve";
  reason: string;
}

export interface ToolStep {
  tool: string;
  input: Record<string, string>;
}

export interface ExecutionContract {
  contractId: string;
  traceId: string;
  intent: { primary: ContractAction; parameters: Record<string, string> };
  risk: { level: RiskLevel; flags: string[]; approvals: Approval[] };
  toolPlan: ToolStep[];
  scope: { user: string; surface: Surface; capabilities: string[] };
  issuedAt: string;
  expiresAt: string;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}

export type UnsignedContract = Omit<ExecutionContract, "signature">;

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function riskOf(action: string): RiskLevel | null {
  return (RISK_CLASSES as Record<string, RiskLevel>)[action] ?? null;
}

// ---------- canonical JSON (shared with gateway/contracts.py) ----------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const KEY = /^[\x20-\x7e]+$/u;

/**
 * Sorted keys at every level, no whitespace, strings escaped as JSON.stringify does
 * (which Python's json.dumps(ensure_ascii=False) matches), integers only, keys printable
 * ASCII. Object members whose value is undefined are left out, as JSON.stringify does.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      if (LONE_SURROGATE.test(v)) throw new ContractError("canonical JSON: lone surrogate in a string");
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) throw new ContractError(`canonical JSON allows safe integers only, got ${v}`);
      return String(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      for (const k of keys) if (!KEY.test(k)) throw new ContractError(`canonical JSON: key must be printable ASCII: ${JSON.stringify(k)}`);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default:
      throw new ContractError(`canonical JSON: unsupported ${typeof v}`);
  }
}

export function signatureFor(contract: UnsignedContract | ExecutionContract, secret: string): string {
  const { signature: _drop, ...rest } = contract as ExecutionContract;
  return createHmac("sha256", secret).update(canonicalJson(rest), "utf8").digest("hex");
}

export function signContract(unsigned: UnsignedContract, secret: string): ExecutionContract {
  assertSecret(secret);
  return { ...unsigned, signature: signatureFor(unsigned, secret) };
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) throw new ContractError("contract secret missing or shorter than 32 characters");
}

/** CLEARSHELF_CONTRACT_SECRET from the environment, else that one key from the repo-root .env.local. Never logged. */
export function loadContractSecret(): string {
  let s = process.env.CLEARSHELF_CONTRACT_SECRET;
  if (!s) {
    const envPath = fileURLToPath(new URL(".env.local", REPO_ROOT_URL));
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
        const m = /^\s*CLEARSHELF_CONTRACT_SECRET\s*=\s*(.*?)\s*$/u.exec(line);
        if (m) s = m[1]!.replace(/^(["'])(.*)\1$/u, "$2");
      }
    }
  }
  if (!s) throw new ContractError("CLEARSHELF_CONTRACT_SECRET is not set (.env.local)");
  assertSecret(s);
  return s;
}

/** Time-sortable id: c-<base36 ms>-<8 hex>. */
export function newContractId(now = Date.now()): string {
  return `c-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface IssueInput {
  action: ContractAction;
  parameters: Record<string, string>;
  user: string;
  surface: Surface;
  approvals?: Approval[];
  flags?: string[];
  toolPlan?: ToolStep[];
  traceId?: string;
  /** Extra capabilities beyond the action itself. */
  capabilities?: string[];
  now?: Date;
  ttlMs?: number;
}

/**
 * Issues and signs a contract. The risk level always comes from the action's risk class,
 * so a caller can never issue a high-risk action as low. A high-risk contract is issued
 * only with an officer approval that carries a reason, and only for the UI surface.
 */
export function issueContract(input: IssueInput, secret: string): ExecutionContract {
  const level = riskOf(input.action);
  if (!level) throw new ContractError(`unknown action: ${input.action}`);
  const now = input.now ?? new Date();
  const ttl = Math.min(input.ttlMs ?? CONTRACT_TTL_MS, CONTRACT_TTL_MS);
  const approvals = input.approvals ?? [];
  if (level === "high") {
    const ok = approvals.some(isOfficerApproval);
    if (!ok) throw new ContractError(`a ${input.action} contract needs an officer approval with a reason`);
    if (input.surface !== "clearshelf-ui") throw new ContractError("high-risk contracts are issued for the officer UI only");
  }
  for (const [k, v] of Object.entries(input.parameters)) {
    if (typeof v !== "string") throw new ContractError(`parameter ${k} must be a string`);
  }
  const unsigned: UnsignedContract = {
    contractId: newContractId(now.getTime()),
    traceId: input.traceId ?? `t-${randomBytes(6).toString("hex")}`,
    intent: { primary: input.action, parameters: { ...input.parameters } },
    risk: { level, flags: [...(input.flags ?? [])], approvals },
    toolPlan: input.toolPlan ?? [{ tool: `ops.${input.action}`, input: { ...input.parameters } }],
    scope: { user: input.user, surface: input.surface, capabilities: [...new Set([input.action, ...(input.capabilities ?? [])])] },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    policyPackVersion: POLICY_PACK_VERSION,
    signedBy: "scout",
  };
  return signContract(unsigned, secret);
}

export function officerApproval(reason: string, at = new Date(), by = OFFICER): Approval {
  return { kind: "officer-approval", by, at: at.toISOString(), decision: "approve", reason };
}

function isOfficerApproval(a: Approval | undefined): boolean {
  return !!a && a.kind === "officer-approval" && a.by === OFFICER && a.decision === "approve" && typeof a.reason === "string" && a.reason.trim().length > 0;
}

// ---------- verification ----------

export type RefusalCode =
  | "missing"
  | "malformed"
  | "bad_signature"
  | "wrong_signer"
  | "wrong_policy_pack"
  | "not_yet_valid"
  | "expired"
  | "ttl_too_long"
  | "wrong_action"
  | "risk_mismatch"
  | "out_of_scope"
  | "parameter_mismatch"
  | "approval_missing"
  | "replayed";

export type Verdict = { ok: true; contract: ExecutionContract } | { ok: false; code: RefusalCode; reason: string };

export interface Expectation {
  action: ContractAction;
  /** Every key here must equal the contract's intent.parameters value. */
  params: Record<string, string>;
}

function refuse(code: RefusalCode, reason: string): Verdict {
  return { ok: false, code, reason };
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function shapeError(c: Record<string, unknown>): string | null {
  const need = ["contractId", "traceId", "intent", "risk", "toolPlan", "scope", "issuedAt", "expiresAt", "policyPackVersion", "signature", "signedBy"];
  for (const k of need) if (!(k in c)) return `missing ${k}`;
  for (const k of ["contractId", "traceId", "issuedAt", "expiresAt", "policyPackVersion", "signature", "signedBy"]) if (!isStr(c[k])) return `${k} must be a string`;
  const intent = c.intent as Record<string, unknown> | null;
  if (!intent || typeof intent !== "object" || !isStr(intent.primary) || !intent.parameters || typeof intent.parameters !== "object") return "bad intent";
  for (const v of Object.values(intent.parameters as Record<string, unknown>)) if (!isStr(v)) return "intent parameters must be strings";
  const risk = c.risk as Record<string, unknown> | null;
  if (!risk || typeof risk !== "object" || !isStr(risk.level) || !Array.isArray(risk.flags) || !Array.isArray(risk.approvals)) return "bad risk";
  const scope = c.scope as Record<string, unknown> | null;
  if (!scope || typeof scope !== "object" || !isStr(scope.user) || !isStr(scope.surface) || !Array.isArray(scope.capabilities)) return "bad scope";
  if (!Array.isArray(c.toolPlan)) return "bad toolPlan";
  if (!/^[0-9a-f]{64}$/u.test(c.signature as string)) return "signature must be 64 hex characters";
  return null;
}

/**
 * Verifies a contract for one action and its parameters. Checks, in order: shape, signer,
 * policy pack, signature, validity window (issuedAt ≤ now + 60 s skew, now < expiresAt,
 * TTL ≤ 15 min), action, risk level equal to the action's class, capability, parameters,
 * and for high risk an officer approval with a reason on the UI surface. One-shot use is
 * checked by ContractVerifier (it needs the ledger).
 */
export function verifyContract(raw: unknown, expect: Expectation, secret: string, now = new Date()): Verdict {
  if (raw === null || raw === undefined) return refuse("missing", "no execution contract");
  if (typeof raw !== "object" || Array.isArray(raw)) return refuse("malformed", "contract is not an object");
  const c = raw as Record<string, unknown>;
  const shape = shapeError(c);
  if (shape) return refuse("malformed", shape);
  const k = c as unknown as ExecutionContract;
  if (k.signedBy !== "scout") return refuse("wrong_signer", `signedBy ${k.signedBy}`);
  if (k.policyPackVersion !== POLICY_PACK_VERSION) return refuse("wrong_policy_pack", `policy pack ${k.policyPackVersion}`);
  let expected: string;
  try {
    expected = signatureFor(k, secret);
  } catch (e) {
    return refuse("malformed", (e as Error).message);
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(k.signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse("bad_signature", "HMAC does not match the canonical contract");
  const issued = Date.parse(k.issuedAt);
  const expires = Date.parse(k.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return refuse("malformed", "issuedAt/expiresAt are not ISO times");
  if (expires - issued > CONTRACT_TTL_MS) return refuse("ttl_too_long", `TTL ${Math.round((expires - issued) / 1000)} s exceeds 900 s`);
  if (issued > now.getTime() + CLOCK_SKEW_MS) return refuse("not_yet_valid", `issued at ${k.issuedAt}`);
  if (now.getTime() >= expires) return refuse("expired", `expired at ${k.expiresAt}`);
  if (k.intent.primary !== expect.action) return refuse("wrong_action", `contract is for ${k.intent.primary}, request is ${expect.action}`);
  const level = riskOf(expect.action);
  if (!level) return refuse("wrong_action", `unknown action ${expect.action}`);
  if (k.risk.level !== level) return refuse("risk_mismatch", `${expect.action} is ${level} risk, contract says ${k.risk.level}`);
  if (!(SURFACES as readonly string[]).includes(k.scope.surface)) return refuse("out_of_scope", `surface ${k.scope.surface}`);
  if (!k.scope.capabilities.includes(expect.action)) return refuse("out_of_scope", `capability ${expect.action} not in the contract scope`);
  for (const [key, value] of Object.entries(expect.params)) {
    if (k.intent.parameters[key] !== value) return refuse("parameter_mismatch", `${key}: contract ${JSON.stringify(k.intent.parameters[key] ?? null)}, request ${JSON.stringify(value)}`);
  }
  if (level === "high") {
    if (k.scope.surface !== "clearshelf-ui") return refuse("approval_missing", "high-risk actions come from the officer UI only");
    const ok = k.risk.approvals.some((ap) => isOfficerApproval(ap) && Date.parse(ap.at) >= issued - CLOCK_SKEW_MS && Date.parse(ap.at) <= expires);
    if (!ok) return refuse("approval_missing", `${expect.action} needs an officer approval with a reason`);
  }
  return { ok: true, contract: k };
}

// ---------- verifier with ledger and log ----------

export interface VerifierLogEntry {
  at: string;
  verifier: string;
  contract_id: string | null;
  action: string;
  params: Record<string, string>;
  ok: boolean;
  code: RefusalCode | null;
  reason: string | null;
}

/**
 * verifyContract plus one-shot use and a log. Every verification, accepted or refused, is
 * appended to data/contracts/verifier-<name>.jsonl (contract id, action, parameters,
 * verdict; never the secret). Contracts consumed by `consume()` are recorded in
 * data/contracts/used-<name>.jsonl and refused if presented again.
 */
export class ContractVerifier {
  readonly logPath: string | null;
  readonly ledgerPath: string | null;
  private readonly used = new Set<string>();

  constructor(
    private readonly secret: string,
    readonly name = "agent-ops",
    dir: string | null = fileURLToPath(new URL("data/contracts/", REPO_ROOT_URL)),
    private readonly clock: () => Date = () => new Date(),
  ) {
    assertSecret(secret);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const base = dir.replace(/[\\/]$/u, "");
      this.logPath = `${base}/verifier-${name}.jsonl`;
      this.ledgerPath = `${base}/used-${name}.jsonl`;
      if (existsSync(this.ledgerPath)) {
        for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            this.used.add(String((JSON.parse(line) as { contract_id: string }).contract_id));
          } catch {
            // a torn last line never re-enables a contract: ids are only ever added
          }
        }
      }
    } else {
      this.logPath = null;
      this.ledgerPath = null;
    }
  }

  readonly entries: VerifierLogEntry[] = [];

  private log(e: VerifierLogEntry): void {
    this.entries.push(e);
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify(e)}\n`, "utf8");
  }

  verify(raw: unknown, expect: Expectation): Verdict {
    const now = this.clock();
    let v = verifyContract(raw, expect, this.secret, now);
    if (v.ok && this.used.has(v.contract.contractId)) v = refuse("replayed", `contract ${v.contract.contractId} was already used`);
    const id = raw && typeof raw === "object" && typeof (raw as { contractId?: unknown }).contractId === "string" ? (raw as { contractId: string }).contractId : null;
    this.log({
      at: now.toISOString(),
      verifier: this.name,
      contract_id: id,
      action: expect.action,
      params: expect.params,
      ok: v.ok,
      code: v.ok ? null : v.code,
      reason: v.ok ? null : v.reason,
    });
    return v;
  }

  /** Marks a verified contract as used; call once its action has been carried out. */
  consume(contract: ExecutionContract): void {
    this.used.add(contract.contractId);
    if (this.ledgerPath) {
      appendFileSync(
        this.ledgerPath,
        `${JSON.stringify({ contract_id: contract.contractId, action: contract.intent.primary, at: this.clock().toISOString(), verifier: this.name })}\n`,
        "utf8",
      );
    }
  }

  isUsed(contractId: string): boolean {
    return this.used.has(contractId);
  }

  /** Issues with this verifier's secret (the agent signs as Scout; same process, integrity check only). */
  issue(input: IssueInput): ExecutionContract {
    return issueContract({ ...input, now: input.now ?? this.clock() }, this.secret);
  }
}

// Carrying out decisions: the only paths that write a decision row. HOLD and BLOCK are
// applied automatically under a low-risk contract the agent issues. CLEAR,
// CLEAR_WITH_STATEMENT and RELEASE run only from an officer-signed contract, and only when
// no exact-GTIN recall of the SKU is still open (the safety invariant "no CLEAR on a SKU
// with an exact-GTIN Ongoing recall" is checked again in Zetaris at execution time).
// Every write is followed by the closed-loop query that proves the row is visible in Zetaris.
//
// An officer approval never relaxes a decision it did not see: a HOLD or BLOCK written
// after a proposal supersedes it in the queue, and a signed contract names the decision
// row that was current when it was signed (toolPlan input `over_decision`), so a clearance
// signed before a later HOLD or BLOCK is refused at execution (409 stale_proposal).

import { officerApproval, OFFICER, type ExecutionContract } from "../contract/scout.ts";
import { rowsAsObjects, type GatewayClient, type TemplateResult } from "../zetaris/client.ts";
import type { Decision, Market } from "../policy/decide.ts";
import { TO_CONFIRM } from "../policy/statement.ts";
import { confirmDecisionVisible, ContractRefused, decisionContractParams, OpsError, OpsStore, type DecisionRow, type Visibility } from "./store.ts";
import type { ApprovalQueue, QueueItem } from "./queue.ts";

export const AGENT_ACTOR = "clearshelf-agent";

export interface Applied {
  row: DecisionRow;
  contract: ExecutionContract;
  visibility: Visibility;
  /** Pending proposals this HOLD or BLOCK superseded (queue ids). */
  superseded: string[];
}

const HOLDING = new Set(["HOLD", "BLOCK"]);

/** The SKU's current decision row, if it holds or blocks the listing. */
function currentHold(ops: OpsStore, gtin: string, market: Market): DecisionRow | null {
  const cur = ops.current().get(`${gtin}|${market}`);
  return cur && HOLDING.has(cur.status) ? cur : null;
}

const toSecond = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * Whether a HOLD or BLOCK was written after a proposal was made. With `over_decision`
 * recorded on the proposal, any other current HOLD/BLOCK row is newer; without it (older
 * queue items), a HOLD/BLOCK decided in the same second or later counts as newer.
 */
export function staleProposal(ops: OpsStore, item: Pick<QueueItem, "gtin" | "market" | "created_at" | "over_decision">): DecisionRow | null {
  const hold = currentHold(ops, item.gtin, item.market);
  if (!hold) return null;
  if (item.over_decision !== undefined) return hold.decision_id !== item.over_decision ? hold : null;
  return toSecond(hold.decided_at) >= toSecond(item.created_at) ? hold : null;
}

/** Supersedes the pending proposals a HOLD or BLOCK row outranks. */
export function supersedeBy(queue: ApprovalQueue | null | undefined, row: DecisionRow): string[] {
  if (!queue || !HOLDING.has(row.status)) return [];
  return queue.supersedeProposals(row.gtin, row.market as Market, { decision_id: row.decision_id, status: row.status, reason: row.reason }).map((i) => i.id);
}

/** Applies a HOLD or BLOCK the policy produced: low-risk contract, write, closed-loop check; supersedes pending proposals. */
export async function applyAutomatic(
  ops: OpsStore,
  gateway: GatewayClient,
  a: { gtin: string; market: Market; status: "HOLD" | "BLOCK"; reason: string; runId: string; flags?: string[]; replay?: { asOf: string; banner: string } | null },
  queue?: ApprovalQueue | null,
): Promise<Applied> {
  const w = { gtin: a.gtin, market: a.market, status: a.status } as const;
  const { action, params } = decisionContractParams(w);
  const contract = ops.verifier.issue({
    action,
    parameters: params,
    user: AGENT_ACTOR,
    surface: "clearshelf-agent",
    flags: ["auto", ...(a.replay ? ["replay"] : []), ...(a.flags ?? [])],
    traceId: a.runId,
    toolPlan: [{ tool: "ops.write_decision", input: params }],
  });
  const res = await ops.writeDecision({ ...w, reason: a.reason, actor: a.replay ? `${AGENT_ACTOR} (replay)` : AGENT_ACTOR, contract, replay: a.replay ?? null });
  const superseded = supersedeBy(queue, res.row);
  const visibility = await confirmDecisionVisible(gateway, res.row);
  return { row: res.row, contract, visibility, superseded };
}

export interface SignRequest {
  gtin: string;
  market: Market;
  action: "CLEAR" | "CLEAR_WITH_STATEMENT" | "RELEASE";
  /** For RELEASE: the status released to (CLEAR or CLEAR_WITH_STATEMENT). Otherwise equal to action. */
  status: "CLEAR" | "CLEAR_WITH_STATEMENT";
  statement: string | null;
  reason: string;
  officer: string;
  /** The queue item being approved (a CLEAR proposal). */
  queueId?: string;
}

/**
 * The officer's signature step: checks the request against the queue and the ops store,
 * then issues a high-risk contract carrying the officer approval and reason. It does not
 * execute anything; POST /api/execute does, after verifying the contract.
 */
export function signApproval(ops: OpsStore, queue: ApprovalQueue, r: SignRequest): { contract: ExecutionContract; item: QueueItem | null } {
  if (r.officer !== OFFICER) throw new OpsError(`unknown approver ${r.officer}; the local demo identity is "${OFFICER}"`, 403, "not_officer");
  if (!r.reason || !r.reason.trim()) throw new OpsError("an approval needs the officer's reason", 400, "reason_missing");
  if (r.status === "CLEAR_WITH_STATEMENT" && !(r.statement ?? "").trim()) throw new OpsError("CLEAR_WITH_STATEMENT needs the statement", 400, "bad_statement");
  if ((r.statement ?? "").includes(TO_CONFIRM)) {
    throw new OpsError(`the statement still has entries marked "${TO_CONFIRM}" (verifier finds no verified span states); confirm or remove them first`, 400, "unconfirmed_statement");
  }
  let item: QueueItem | null = null;
  if (r.action === "RELEASE") {
    const cur = ops.current().get(`${r.gtin}|${r.market}`);
    if (!cur || cur.status !== "HOLD") throw new OpsError(`RELEASE applies to a held listing; current status is ${cur?.status ?? "none"}`, 409, "not_held");
  } else {
    if (r.action !== r.status) throw new OpsError("an approval signs the proposed status itself", 400, "bad_status");
    item = (r.queueId ? queue.get(r.queueId) : queue.proposalFor(r.gtin, r.market)) ?? null;
    if (!item || item.kind !== "proposal" || item.state !== "pending" || item.gtin !== r.gtin || item.market !== r.market) {
      throw new OpsError(`no pending ${r.action} proposal for ${r.gtin} ${r.market}`, 409, "no_proposal");
    }
    if (item.status !== r.status) throw new OpsError(`the policy proposed ${item.status}, not ${r.status}; an officer approval never relaxes a decision`, 409, "status_mismatch");
    const newer = staleProposal(ops, item);
    if (newer) {
      throw new OpsError(
        `refused: ${newer.status} ${newer.decision_id} (decided ${newer.decided_at}) is newer than proposal ${item.id} (${item.created_at}); an officer approval never relaxes a decision it did not see`,
        409,
        "stale_proposal",
      );
    }
  }
  const { action, params } = decisionContractParams({ gtin: r.gtin, market: r.market, status: r.status, statement: r.statement, action: r.action === "RELEASE" ? "RELEASE" : undefined });
  const edited = item && r.status === "CLEAR_WITH_STATEMENT" && (item.statement ?? "") !== (r.statement ?? "");
  // The signed plan names the decision row it was signed over (and the proposal), so execution can refuse a stale signature.
  const over = ops.current().get(`${r.gtin}|${r.market}`)?.decision_id ?? "";
  const contract = ops.verifier.issue({
    action,
    parameters: params,
    user: r.officer,
    surface: "clearshelf-ui",
    approvals: [officerApproval(r.reason)],
    flags: edited ? ["statement_edited"] : [],
    toolPlan: [{ tool: "ops.write_decision", input: { ...params, over_decision: over, ...(item ? { queue_id: item.id } : {}) } }],
    traceId: item?.run_id,
  });
  return { contract, item };
}

export interface ExecuteRequest {
  gtin: string;
  market: Market;
  status: Decision;
  statement: string | null;
  action?: "RELEASE";
  reason: string;
  contract: unknown;
  /** Who decided a low-risk write (default the agent); a high-risk write's actor is its approver. */
  actor?: string;
}

export interface Executed extends Applied {
  safety: TemplateResult | null;
}

/** Fills `over_decision` on a proposal: the row current for the SKU when it is queued. */
export function overDecision(ops: OpsStore, gtin: string, market: Market): string {
  return ops.current().get(`${gtin}|${market}`)?.decision_id ?? "";
}

const CLOSED = new Set(["terminated", "completed"]);

/**
 * Executes a decision from a contract. For a high-risk write the contract is verified
 * first (403 and no write on refusal), then Zetaris is asked for exact-GTIN recalls: any
 * linked recall not Terminated or Completed refuses the clearance (409, no write).
 */
export async function executeDecision(ops: OpsStore, gateway: GatewayClient, queue: ApprovalQueue | null, r: ExecuteRequest): Promise<Executed> {
  const high = r.status === "CLEAR" || r.status === "CLEAR_WITH_STATEMENT" || r.action === "RELEASE";
  let safety: TemplateResult | null = null;
  if (high) {
    // Verify before the Zetaris read, so an unsigned request costs nothing and is logged as refused.
    const { action, params } = decisionContractParams(r);
    const pre = ops.verifier.verify(r.contract, { action, params });
    if (!pre.ok) throw new ContractRefused(pre.code, pre.reason);
    assertNotStale(ops, queue, r, pre.contract);
    safety = await gateway.template("recalls_by_gtin", { gtin: r.gtin });
    const open = rowsAsObjects(safety).filter((x) => !CLOSED.has(String(x.status ?? "").toLowerCase()));
    if (open.length) {
      throw new OpsError(
        `refused: exact-GTIN recall still open (${open.map((x) => `${x.recall_number} ${x.status}`).join(", ")}); a clearance cannot be executed`,
        409,
        "open_recall",
      );
    }
  }
  const contract = r.contract as ExecutionContract;
  const actor = high ? (contract.risk?.approvals?.[0]?.by ?? OFFICER) : (r.actor ?? AGENT_ACTOR);
  const res = await ops.writeDecision({ gtin: r.gtin, market: r.market, status: r.status, statement: r.statement, reason: r.reason, actor, contract: r.contract, action: r.action });
  const superseded = high ? [] : supersedeBy(queue, res.row);
  const visibility = await confirmDecisionVisible(gateway, res.row);
  if (queue && high && r.action !== "RELEASE") {
    const planned = planOf(contract).queue_id;
    const item = planned ? queue.get(planned) : queue.proposalFor(r.gtin, r.market);
    if (item && item.state === "pending") queue.resolve(item.id, "executed", { by: actor, reason: r.reason, contract_id: res.contract_id, decision_id: res.row.decision_id });
  }
  return { row: res.row, contract, visibility, safety, superseded };
}

function planOf(c: ExecutionContract): Record<string, string | undefined> {
  return (Array.isArray(c.toolPlan) && c.toolPlan[0]?.input ? c.toolPlan[0].input : {}) as Record<string, string | undefined>;
}

/**
 * A signed clearance or release is refused (409, nothing written) when the decision it was
 * signed over is no longer current: a later HOLD or BLOCK, or a superseded proposal.
 */
function assertNotStale(ops: OpsStore, queue: ApprovalQueue | null, r: ExecuteRequest, contract: ExecutionContract): void {
  const plan = planOf(contract);
  const cur = ops.current().get(`${r.gtin}|${r.market}`) ?? null;
  const signedOver = (row: DecisionRow) => (plan.over_decision !== undefined ? row.decision_id === plan.over_decision : toSecond(row.decided_at) <= toSecond(contract.issuedAt));
  if (r.action === "RELEASE") {
    if (!cur || cur.status !== "HOLD") throw new OpsError(`RELEASE applies to a held listing; current status is ${cur?.status ?? "none"}`, 409, "not_held");
    if (!signedOver(cur)) throw new OpsError(`refused: ${cur.status} ${cur.decision_id} (decided ${cur.decided_at}) is newer than the signed RELEASE; sign again over the current hold`, 409, "stale_release");
    return;
  }
  if (cur && HOLDING.has(cur.status) && !signedOver(cur)) {
    throw new OpsError(`refused: ${cur.status} ${cur.decision_id} (decided ${cur.decided_at}) is newer than the signed ${r.status}; an officer approval never relaxes a decision it did not see`, 409, "stale_proposal");
  }
  if (queue && plan.queue_id) {
    const item = queue.get(plan.queue_id);
    if (!item || item.state !== "pending") {
      throw new OpsError(
        `refused: proposal ${plan.queue_id} is ${item?.state ?? "unknown"}${item?.resolution ? ` (${item.resolution.reason})` : ""}; a clearance runs only for a pending proposal`,
        409,
        item?.state === "superseded" ? "stale_proposal" : "no_proposal",
      );
    }
  }
}

// Shared with gateway/tests/test_contracts.py: the same contract and test secret must give
// the same HMAC in TypeScript and Python. Synthetic values; the secret is a test secret only.
import { POLICY_PACK_VERSION, type UnsignedContract } from "../../src/contract/scout.ts";

export const VECTOR_SECRET = "test".repeat(10);

export const VECTOR: UnsignedContract = {
  contractId: "c-vector-0001",
  traceId: "t-vector",
  intent: { primary: "register_off", parameters: { gtin: "0816929000119", market: "UK", note: "Café \"quoted\" \\ tab\t line\n é ü \u{1F36B}" } },
  risk: { level: "medium", flags: ["vector"], approvals: [] },
  toolPlan: [{ tool: "registrar.register_off", input: { gtin: "0816929000119" } }],
  scope: { user: "clearshelf-agent", surface: "clearshelf-agent", capabilities: ["register_off"] },
  issuedAt: "2026-10-25T10:00:00.000Z",
  expiresAt: "2026-10-25T10:15:00.000Z",
  policyPackVersion: POLICY_PACK_VERSION,
  signedBy: "scout",
};

export const VECTOR_SIGNATURE = "40f4378db94975f9d918ee7e4be2edff6a3ee17a078b392fbc03a26af0ff98b2";

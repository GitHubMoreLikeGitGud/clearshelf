import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  ContractVerifier,
  issueContract,
  officerApproval,
  signatureFor,
  signContract,
  verifyContract,
  type ExecutionContract,
  type UnsignedContract,
} from "../src/contract/scout.ts";
import { VECTOR, VECTOR_SECRET, VECTOR_SIGNATURE } from "./fixtures/contract-vector.ts";

// Test secret only; the real one lives in .env.local.
const SECRET = VECTOR_SECRET;
const T0 = new Date("2026-10-25T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
  it("escapes like JSON.stringify and keeps non-ASCII as is", () => {
    expect(canonicalJson({ s: 'é"\\\n\u0001' })).toBe('{"s":"é\\"\\\\\\n\\u0001"}');
  });
  it("refuses floats, lone surrogates and non-ASCII keys", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/integers/);
    expect(() => canonicalJson({ x: "\uD800" })).toThrow(/surrogate/);
    expect(() => canonicalJson({ "é": 1 })).toThrow(/ASCII/);
  });
  it("matches the shared test vector", () => {
    expect(signatureFor(VECTOR, SECRET)).toBe(VECTOR_SIGNATURE);
  });
});

function clear(now = T0, reason = "Label inspected; statement matches the verified spans."): ExecutionContract {
  return issueContract(
    {
      action: "CLEAR_WITH_STATEMENT",
      parameters: { gtin: "5000169566558", market: "UK", status: "CLEAR_WITH_STATEMENT" },
      user: "officer",
      surface: "clearshelf-ui",
      approvals: [officerApproval(reason, now)],
      now,
    },
    SECRET,
  );
}

const expectClear = { action: "CLEAR_WITH_STATEMENT" as const, params: { gtin: "5000169566558", market: "UK", status: "CLEAR_WITH_STATEMENT" } };

describe("issue and verify", () => {
  it("accepts an officer-approved high-risk contract", () => {
    const v = verifyContract(clear(), expectClear, SECRET, at(60_000));
    expect(v.ok).toBe(true);
  });

  it("never issues a high-risk contract without an officer approval with a reason", () => {
    expect(() => issueContract({ action: "RELEASE", parameters: {}, user: "x", surface: "clearshelf-ui", now: T0 }, SECRET)).toThrow(/officer approval/);
    expect(() => clear(T0, "  ")).toThrow(/officer approval/);
    expect(() =>
      issueContract({ action: "CLEAR", parameters: {}, user: "agent", surface: "clearshelf-agent", approvals: [officerApproval("ok", T0)], now: T0 }, SECRET),
    ).toThrow(/officer UI/);
  });

  it("takes the risk level from the action, never from the caller", () => {
    const c = issueContract({ action: "HOLD", parameters: { gtin: "0850041392103" }, user: "agent", surface: "clearshelf-agent", now: T0 }, SECRET);
    expect(c.risk.level).toBe("low");
    const forged = signContract({ ...c, intent: { ...c.intent, primary: "RELEASE" } } as UnsignedContract, SECRET);
    const v = verifyContract(forged, { action: "RELEASE", params: {} }, SECRET, at(1000));
    expect(v).toMatchObject({ ok: false, code: "risk_mismatch" });
  });

  it("refuses a mutated contract, a wrong secret, an expired or early one, and a long TTL", () => {
    const c = clear();
    const mutated = { ...c, intent: { ...c.intent, parameters: { ...c.intent.parameters, gtin: "0850041392103" } } };
    expect(verifyContract(mutated, { ...expectClear, params: { ...expectClear.params, gtin: "0850041392103" } }, SECRET, at(1000))).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyContract(c, expectClear, `${SECRET}x`, at(1000))).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyContract(c, expectClear, SECRET, at(15 * 60_000))).toMatchObject({ ok: false, code: "expired" });
    expect(verifyContract(c, expectClear, SECRET, at(-5 * 60_000))).toMatchObject({ ok: false, code: "not_yet_valid" });
    const long = signContract({ ...c, expiresAt: at(16 * 60_000).toISOString() } as UnsignedContract, SECRET);
    expect(verifyContract(long, expectClear, SECRET, at(1000))).toMatchObject({ ok: false, code: "ttl_too_long" });
  });

  it("refuses a contract for another action, GTIN or status", () => {
    const c = clear();
    expect(verifyContract(c, { action: "RELEASE", params: {} }, SECRET, at(1000))).toMatchObject({ ok: false, code: "wrong_action" });
    expect(verifyContract(c, { ...expectClear, params: { ...expectClear.params, gtin: "0850041392103" } }, SECRET, at(1000))).toMatchObject({
      ok: false,
      code: "parameter_mismatch",
    });
  });

  it("refuses a high-risk contract whose approval was stripped and re-signed without one", () => {
    const c = clear();
    const stripped = signContract({ ...c, risk: { ...c.risk, approvals: [] } } as UnsignedContract, SECRET);
    expect(verifyContract(stripped, expectClear, SECRET, at(1000))).toMatchObject({ ok: false, code: "approval_missing" });
  });

  it("refuses missing and malformed contracts", () => {
    expect(verifyContract(undefined, expectClear, SECRET, T0)).toMatchObject({ ok: false, code: "missing" });
    expect(verifyContract({ contractId: "x" }, expectClear, SECRET, T0)).toMatchObject({ ok: false, code: "malformed" });
    expect(verifyContract("RELEASE", expectClear, SECRET, T0)).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("ContractVerifier", () => {
  it("logs every verdict, consumes contracts once and refuses a replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-contract-"));
    const v = new ContractVerifier(SECRET, "test", dir, () => at(1000));
    const c = clear();
    expect(v.verify(c, expectClear).ok).toBe(true);
    v.consume(c);
    expect(v.verify(c, expectClear)).toMatchObject({ ok: false, code: "replayed" });
    expect(v.verify(null, { action: "RELEASE", params: { gtin: "0850041392103" } })).toMatchObject({ ok: false, code: "missing" });
    const log = readFileSync(join(dir, "verifier-test.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e) => [e.ok, e.code])).toEqual([
      [true, null],
      [false, "replayed"],
      [false, "missing"],
    ]);
    expect(readFileSync(join(dir, "verifier-test.jsonl"), "utf8")).not.toContain(SECRET);
    // A new verifier on the same directory still refuses the consumed contract.
    const v2 = new ContractVerifier(SECRET, "test", dir, () => at(2000));
    expect(v2.verify(c, expectClear)).toMatchObject({ ok: false, code: "replayed" });
  });
});

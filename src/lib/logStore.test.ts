import { describe, expect, test } from "bun:test";

import { endedReasonLevel } from "../vapi/endedReason.ts";
import { admit, maskPhonesInText, toStoredLog } from "./logStore.ts";

const at = "2026-10-02T17:16:28.000Z";
const CALL_ROW = "3ef6f968-0000-4000-8000-000000000001";
const VAPI_CALL = "01a0fd9e-0000-4000-8000-000000000002";
const LEAD = "9eb2d125-0000-4000-8000-000000000003";

describe("toStoredLog", () => {
  test("masks phone numbers in the message and nested context", () => {
    const row = toStoredLog({
      at,
      level: "error",
      source: "dialer",
      msg: "Dial to +14155557000 failed",
      meta: { err: "number 4155557000 rejected", nested: { to: ["+442071234567"] }, attempts: 2 },
    });
    expect(row.message).toBe("Dial to ***7000 failed");
    expect(row.context).toEqual({ err: "number ***7000 rejected", nested: { to: ["***4567"] }, attempts: 2 });
  });

  test("leaves ids, timestamps and short numbers alone", () => {
    expect(maskPhonesInText(`call ${CALL_ROW} at ${at} took 412ms, cost 0.0935`)).toBe(
      `call ${CALL_ROW} at ${at} took 412ms, cost 0.0935`,
    );
  });

  test("redacts secret-ish fields", () => {
    const row = toStoredLog({ at, level: "warn", source: "api", msg: "x", meta: { apiKey: "sk-123", token: "abc", ok: true } });
    expect(row.context).toEqual({ apiKey: "***redacted***", token: "***redacted***", ok: true });
  });

  test("pulls out the ids the System logs search uses (callId = Vapi's, callRowId = ours)", () => {
    const row = toStoredLog({
      at,
      level: "info",
      source: "outbound-call",
      msg: "Outbound call ended: assistant-ended-call",
      meta: { callId: VAPI_CALL, callRowId: CALL_ROW, leadId: LEAD, campaignId: "not-a-uuid" },
    });
    expect(row.call_id).toBe(CALL_ROW);
    expect(row.vapi_call_id).toBe(VAPI_CALL);
    expect(row.lead_id).toBe(LEAD);
    expect(row.campaign_id).toBeNull();
    expect(row.id).toBeNull();
  });

  test("notes suppressed repeats and caps oversized context", () => {
    expect(toStoredLog({ at, level: "warn", source: "dialer", msg: "Skipped lead" }, 7).context).toEqual({
      suppressedRepeats: 7,
    });
    const big = toStoredLog({ at, level: "info", source: "api", msg: "big", meta: { blob: Array(40).fill("y".repeat(1_500)) } });
    expect(Object.keys(big.context ?? {})).toEqual(["truncated"]);
    expect(String(big.context?.truncated).length).toBe(8_000);
  });
});

describe("admit (repeat throttle)", () => {
  const line = (meta?: Record<string, unknown>) => ({ at, level: "warn" as const, source: "t", msg: `repeat-${meta ? "call" : "plain"}`, meta });

  test("keeps 10 per window, then counts the dropped ones onto the next kept line", () => {
    const t0 = 1_000_000;
    const kept = Array.from({ length: 15 }, (_, i) => admit(line(), t0 + i));
    expect(kept.filter((k) => k !== null)).toHaveLength(10);
    expect(admit(line(), t0 + 10 * 60_000)).toBe(5);
  });

  test("throttles per call, so concurrent calls don't share a budget", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) expect(admit(line({ callRowId: CALL_ROW }), t0)).toBe(0);
    expect(admit(line({ callRowId: CALL_ROW }), t0)).toBeNull();
    expect(admit(line({ callRowId: LEAD }), t0)).toBe(0);
  });
});

describe("endedReasonLevel", () => {
  test("failures are errors, limits warn, ordinary endings info", () => {
    expect(endedReasonLevel("twilio-failed-to-connect-call")).toBe("error");
    expect(endedReasonLevel("pipeline-error-openai-llm-failed")).toBe("error");
    expect(endedReasonLevel("call.start.error-vapi-number-outbound-daily-limit")).toBe("error");
    expect(endedReasonLevel("exceeded-max-duration")).toBe("warn");
    expect(endedReasonLevel("assistant-ended-call")).toBe("info");
    expect(endedReasonLevel("customer-did-not-answer")).toBe("info");
    expect(endedReasonLevel("silence-timed-out")).toBe("info");
    expect(endedReasonLevel(undefined)).toBe("info");
  });
});

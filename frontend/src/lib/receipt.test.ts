import { describe, expect, it } from "vitest";
import { EXECUTION_NAMES, RESOLUTION_NAMES, ReceiptError, STATUS_NAMES, assertFinalReceipt, receiptProblem, type ReceiptLike } from "./receipt";

const good: ReceiptLike = {
  hash: "0xabc",
  statusName: "ACCEPTED",
  txExecutionResultName: "FINISHED_WITH_RETURN",
  resultName: "MAJORITY_AGREE",
};

describe("strict receipt finality", () => {
  it.each(["ACCEPTED", "FINALIZED"])("accepts status %s", (statusName) => {
    expect(receiptProblem({ ...good, statusName })).toBeNull();
  });

  it.each([
    "PENDING",
    "PROPOSING",
    "COMMITTING",
    "REVEALING",
    "UNDETERMINED",
    "CANCELED",
    "APPEAL_REVEALING",
    "APPEAL_COMMITTING",
    "VALIDATORS_TIMEOUT",
    "LEADER_TIMEOUT",
    "LEADER_REVEALING",
    "UNINITIALIZED",
  ])("rejects status %s", (statusName) => {
    expect(receiptProblem({ ...good, statusName })).toMatch(/consensus status/);
  });

  it.each(["FINISHED_WITH_ERROR", "NOT_VOTED", "ERROR", "TIMEOUT"])("rejects execution %s", (txExecutionResultName) => {
    expect(receiptProblem({ ...good, txExecutionResultName })).toMatch(/execution ended/);
  });

  it.each(["DISAGREE", "TIMEOUT", "UNDETERMINED", "MAJORITY_DISAGREE", "NO_MAJORITY"])("rejects resolution %s", (resultName) => {
    expect(receiptProblem({ ...good, resultName })).toMatch(/validators resolved/);
  });

  it("requires every field to be present", () => {
    expect(receiptProblem({ ...good, statusName: undefined })).toMatch(/no consensus status/);
    expect(receiptProblem({ ...good, txExecutionResultName: undefined })).toMatch(/no execution result/);
    expect(receiptProblem({ ...good, resultName: undefined })).toMatch(/no validator resolution/);
  });

  it.each([null, undefined])("rejects %s", (r) => {
    expect(receiptProblem(r)).toBe("no receipt returned");
  });

  it("returns the receipt when it passes", () => {
    expect(assertFinalReceipt(good)).toBe(good);
  });

  it("throws a ReceiptError carrying the receipt", () => {
    const bad = { ...good, resultName: "DISAGREE" };
    try {
      assertFinalReceipt(bad);
      throw new Error("should not pass");
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptError);
      expect((e as ReceiptError).receipt).toBe(bad);
      expect((e as ReceiptError).message).toMatch(/MAJORITY_AGREE/);
    }
  });

  it("does not accept a status-only receipt", () => {
    expect(() => assertFinalReceipt({ statusName: "FINALIZED" })).toThrow(ReceiptError);
  });

  it("ACCEPTED + error execution is still a failure", () => {
    expect(() => assertFinalReceipt({ ...good, txExecutionResultName: "FINISHED_WITH_ERROR" })).toThrow(/FINISHED_WITH_RETURN/);
  });
});

describe("numeric receipts (what Studio Next actually returns)", () => {
  const real: ReceiptLike = { status: 5, statusName: "ACCEPTED", txExecutionResult: 1, txExecutionResultName: "FINISHED_WITH_RETURN", result: 1 };

  it("accepts a real stored receipt: names for status/execution, numeric result", () => {
    expect(receiptProblem(real)).toBeNull();
  });

  it("accepts a receipt that carries numbers only", () => {
    expect(receiptProblem({ status: 7, txExecutionResult: 1, result: 1 })).toBeNull();
  });

  it("accepts string and bigint numerics", () => {
    expect(receiptProblem({ status: "5", txExecutionResult: "1", result: "1" })).toBeNull();
    expect(receiptProblem({ status: 5n, txExecutionResult: 1n, result: 1n })).toBeNull();
  });

  it("reads the snake_case result_name on raw transactions", () => {
    expect(receiptProblem({ ...real, result: undefined, result_name: "MAJORITY_AGREE" })).toBeNull();
  });

  it.each([
    [1, "PENDING"],
    [6, "UNDETERMINED"],
    [8, "CANCELED"],
    [11, "VALIDATORS_TIMEOUT"],
    [12, "LEADER_TIMEOUT"],
  ])("numeric status %i is rejected as %s", (status, name) => {
    expect(receiptProblem({ ...real, status, statusName: undefined })).toContain(name);
  });

  it.each([
    [2, "MAJORITY_DISAGREE"],
    [3, "MAJORITY_TIMEOUT"],
    [4, "DETERMINISTIC_VIOLATION"],
    [5, "NO_MAJORITY"],
    [0, "IDLE"],
  ])("numeric resolution %i is rejected as %s", (result, name) => {
    expect(receiptProblem({ ...real, result })).toContain(name);
  });

  it.each([
    [0, "NOT_VOTED"],
    [2, "FINISHED_WITH_ERROR"],
    [3, "TIMEOUT"],
    [4, "NONDET_DISAGREE"],
  ])("numeric execution %i is rejected as %s", (txExecutionResult, name) => {
    expect(receiptProblem({ ...real, txExecutionResult, txExecutionResultName: undefined })).toContain(name);
  });

  it("an out-of-table number is treated as missing, never as success", () => {
    expect(receiptProblem({ status: 99, txExecutionResult: 1, result: 1 })).toMatch(/no consensus status/);
    expect(receiptProblem({ status: 5, txExecutionResult: 1, result: 42 })).toMatch(/no validator resolution/);
    expect(receiptProblem({ status: 5, txExecutionResult: -1, result: 1 })).toMatch(/no execution result/);
  });

  it("tables match the SDK's numbering at the codes we rely on", () => {
    expect(STATUS_NAMES[5]).toBe("ACCEPTED");
    expect(STATUS_NAMES[7]).toBe("FINALIZED");
    expect(EXECUTION_NAMES[1]).toBe("FINISHED_WITH_RETURN");
    expect(RESOLUTION_NAMES[1]).toBe("MAJORITY_AGREE");
  });
});

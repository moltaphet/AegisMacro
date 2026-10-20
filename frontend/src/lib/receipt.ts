// Strict receipt finality. A transaction only counts as done when ALL of:
//   * consensus status is ACCEPTED or FINALIZED
//   * the VM execution result is FINISHED_WITH_RETURN
//   * the validators' resolution is MAJORITY_AGREE
// Anything else (UNDETERMINED, timeouts, FINISHED_WITH_ERROR, DISAGREE, a
// missing field) is rejected with a reason a person can act on.

export interface ReceiptLike {
  hash?: string;
  status?: string | number | bigint;
  statusName?: string;
  txExecutionResult?: string | number | bigint;
  txExecutionResultName?: string;
  result?: string | number | bigint;
  resultName?: string;
  /** snake_case alias present on raw stored transactions */
  result_name?: string;
}

// Studio Next returns numeric codes and only sometimes the names. These tables
// are genlayer-js's own (transactionsStatusNumberToName, executionResultNumberToName,
// transactionResultNumberToName); a missing name is derived, never assumed OK.
export const STATUS_NAMES = [
  "UNINITIALIZED", "PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACCEPTED", "UNDETERMINED",
  "FINALIZED", "CANCELED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "VALIDATORS_TIMEOUT",
  "LEADER_TIMEOUT", "LEADER_REVEALING",
] as const;
export const EXECUTION_NAMES = [
  "NOT_VOTED", "FINISHED_WITH_RETURN", "FINISHED_WITH_ERROR", "TIMEOUT", "NONDET_DISAGREE", "DETERMINISTIC_VIOLATION",
] as const;
export const RESOLUTION_NAMES = [
  "IDLE", "MAJORITY_AGREE", "MAJORITY_DISAGREE", "MAJORITY_TIMEOUT", "DETERMINISTIC_VIOLATION", "NO_MAJORITY",
] as const;

function nameOf(name: string | undefined, num: unknown, table: readonly string[]): string | undefined {
  if (name) return name;
  let n: unknown = num;
  if (typeof n === "bigint") n = Number(n);
  else if (typeof n === "string" && /^\d+$/.test(n)) n = Number(n);
  return typeof n === "number" && Number.isInteger(n) ? table[n] : undefined;
}

export function receiptStatus(r: ReceiptLike): string | undefined {
  return nameOf(r.statusName, r.status, STATUS_NAMES);
}
export function receiptExecution(r: ReceiptLike): string | undefined {
  return nameOf(r.txExecutionResultName, r.txExecutionResult, EXECUTION_NAMES);
}
export function receiptResolution(r: ReceiptLike): string | undefined {
  return nameOf(r.resultName ?? r.result_name, r.result, RESOLUTION_NAMES);
}

export const OK_STATUS = ["ACCEPTED", "FINALIZED"] as const;
export const OK_EXECUTION = "FINISHED_WITH_RETURN";
export const OK_RESULT = "MAJORITY_AGREE";

export class ReceiptError extends Error {
  constructor(
    message: string,
    readonly receipt: ReceiptLike | null,
  ) {
    super(message);
    this.name = "ReceiptError";
  }
}

export function receiptProblem(r: ReceiptLike | null | undefined): string | null {
  if (!r || typeof r !== "object") return "no receipt returned";
  const status = receiptStatus(r);
  if (!status) return "receipt has no consensus status";
  if (!(OK_STATUS as readonly string[]).includes(status)) {
    return `consensus status is ${status}, expected ACCEPTED or FINALIZED`;
  }
  const execution = receiptExecution(r);
  if (!execution) return "receipt has no execution result";
  if (execution !== OK_EXECUTION) {
    return `execution ended ${execution}, expected ${OK_EXECUTION}`;
  }
  const resolution = receiptResolution(r);
  if (!resolution) return "receipt has no validator resolution";
  if (resolution !== OK_RESULT) {
    return `validators resolved ${resolution}, expected ${OK_RESULT}`;
  }
  return null;
}

export function assertFinalReceipt<T extends ReceiptLike>(r: T | null | undefined): T {
  const problem = receiptProblem(r);
  if (problem !== null || !r) throw new ReceiptError(problem ?? "no receipt returned", r ?? null);
  return r;
}

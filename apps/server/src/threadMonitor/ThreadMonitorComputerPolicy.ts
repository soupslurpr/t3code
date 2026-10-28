/** Determines when sampled screen changes require model evaluation. */

const MIN_RETRY_INTERVAL_MS = 1_000;
const MAX_RETRY_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_RETRY_EXPONENT = 8;

export interface ModelEvaluationPolicyInput {
  readonly changed: boolean;
  readonly evaluationPending: boolean;
  readonly evaluateOnlyAfterChange: boolean;
  readonly minEvaluationIntervalMs: number | null;
  readonly lastEvaluatedAtMs: number | null;
  readonly checkedAtMs: number;
}

export interface ModelEvaluationPolicyDecision {
  readonly evaluate: boolean;
  readonly evaluationPending: boolean;
}

export interface ComputerMonitorRetryPolicyInput {
  readonly sampleIntervalMs: number;
  readonly minEvaluationIntervalMs: number | null;
  readonly consecutiveFailures: number;
}

export interface ControllerReviewPolicyInput {
  readonly policy: {
    readonly afterEvaluations: number | null;
    readonly consecutiveUncertain: number | null;
    readonly consecutiveFailures: number | null;
    readonly at: string | null;
  } | null;
  readonly state: "idle" | "pending" | "delivered";
  readonly evaluationCount: number;
  readonly consecutiveUncertain: number;
  readonly consecutiveFailures: number;
  readonly nowMs: number;
}

/** Coalesces requested evaluations until the configured rate limit permits one. */
export function resolveModelEvaluation(
  input: ModelEvaluationPolicyInput,
): ModelEvaluationPolicyDecision {
  const requested = !input.evaluateOnlyAfterChange || input.changed || input.evaluationPending;
  if (!requested) return { evaluate: false, evaluationPending: false };

  const eligible =
    input.minEvaluationIntervalMs === null ||
    input.lastEvaluatedAtMs === null ||
    input.checkedAtMs - input.lastEvaluatedAtMs >= input.minEvaluationIntervalMs;
  return eligible
    ? { evaluate: true, evaluationPending: false }
    : { evaluate: false, evaluationPending: true };
}

/** Computes capture backoff without violating the model evaluation rate limit. */
export function resolveComputerMonitorRetryDelay(input: ComputerMonitorRetryPolicyInput): number {
  const exponentialDelay = Math.min(
    MAX_RETRY_INTERVAL_MS,
    Math.max(input.sampleIntervalMs, MIN_RETRY_INTERVAL_MS) *
      2 ** Math.min(MAX_RETRY_EXPONENT, input.consecutiveFailures),
  );
  return Math.max(input.minEvaluationIntervalMs ?? 0, exponentialDelay);
}

/** Returns the deterministic reason for requesting controller review once per revision. */
export function resolveControllerReview(input: ControllerReviewPolicyInput): string | null {
  if (input.policy === null || input.state !== "idle") return null;
  if (input.policy.at !== null && Date.parse(input.policy.at) <= input.nowMs) {
    return `The scheduled controller review time ${input.policy.at} was reached.`;
  }
  if (
    input.policy.consecutiveFailures !== null &&
    input.consecutiveFailures >= input.policy.consecutiveFailures
  ) {
    return `The watch reached ${input.consecutiveFailures} consecutive failures.`;
  }
  if (
    input.policy.consecutiveUncertain !== null &&
    input.consecutiveUncertain >= input.policy.consecutiveUncertain
  ) {
    return `The evaluator returned ${input.consecutiveUncertain} consecutive uncertain verdicts.`;
  }
  if (
    input.policy.afterEvaluations !== null &&
    input.evaluationCount >= input.policy.afterEvaluations
  ) {
    return `The watch completed ${input.evaluationCount} evaluations in this revision.`;
  }
  return null;
}

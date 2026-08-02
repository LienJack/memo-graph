export type RecoveryKind =
  | "initial-loading"
  | "refreshing"
  | "ready"
  | "ready-empty"
  | "filtered-empty"
  | "governance-excluded"
  | "truncated"
  | "degraded"
  | "blocked"
  | "unauthorized"
  | "expired"
  | "disconnected"
  | "stale-instance"
  | "failed";

type WithMessage = {
  message: string;
};

export type RecoveryState<T> =
  | ({ kind: "initial-loading" } & WithMessage)
  | ({ kind: "refreshing"; retained: T } & WithMessage)
  | ({ kind: "ready"; content: T } & WithMessage)
  | ({ kind: "ready-empty" } & WithMessage)
  | ({ kind: "filtered-empty"; filtersApplied: number } & WithMessage)
  | ({ kind: "governance-excluded"; excludedCount: number } & WithMessage)
  | ({ kind: "truncated"; retained: T; omittedCount: number } & WithMessage)
  | ({ kind: "degraded"; retained: T; reasonCode: string } & WithMessage)
  | ({ kind: "blocked"; reasonCode: string } & WithMessage)
  | ({ kind: "unauthorized" } & WithMessage)
  | ({ kind: "expired" } & WithMessage)
  | ({ kind: "disconnected"; stale: T | null } & WithMessage)
  | ({ kind: "stale-instance"; stale: T | null } & WithMessage)
  | ({ kind: "failed"; stale: T | null; retryable: boolean } & WithMessage);

export type RecoveryPolicy = {
  contentTreatment:
    | "none"
    | "authoritative"
    | "retained-refreshing"
    | "retained-bounded"
    | "retained-degraded"
    | "stale-context";
  mutations: "enabled" | "disabled" | "target-governed";
  primaryAction:
    | "none"
    | "clear-filters"
    | "open-health"
    | "retry"
    | "reopen"
    | "continue";
  secondaryAction: "none" | "open-health" | "change-scope";
  focusTarget: "heading" | "results" | "clear-filters" | "state" | "recovery";
  polling: "off" | "bounded" | "stop";
};

export function recoveryPolicy<T>(state: RecoveryState<T>): RecoveryPolicy {
  switch (state.kind) {
    case "initial-loading":
      return policy("none", "disabled", "none", "none", "heading", "off");
    case "refreshing":
      return policy(
        "retained-refreshing",
        "disabled",
        "none",
        "none",
        "results",
        "bounded",
      );
    case "ready":
      return policy(
        "authoritative",
        "target-governed",
        "none",
        "none",
        "results",
        "bounded",
      );
    case "ready-empty":
      return policy(
        "authoritative",
        "disabled",
        "none",
        "change-scope",
        "state",
        "off",
      );
    case "filtered-empty":
      return policy(
        "authoritative",
        "disabled",
        "clear-filters",
        "none",
        "clear-filters",
        "off",
      );
    case "governance-excluded":
      return policy(
        "none",
        "disabled",
        "open-health",
        "change-scope",
        "state",
        "off",
      );
    case "truncated":
      return policy(
        "retained-bounded",
        "target-governed",
        "continue",
        "none",
        "results",
        "off",
      );
    case "degraded":
      return policy(
        "retained-degraded",
        "target-governed",
        "open-health",
        "none",
        "results",
        "bounded",
      );
    case "blocked":
      return policy(
        "none",
        "disabled",
        "open-health",
        "none",
        "recovery",
        "off",
      );
    case "unauthorized":
    case "expired":
      return policy(
        "none",
        "disabled",
        "reopen",
        "none",
        "recovery",
        "stop",
      );
    case "disconnected":
    case "stale-instance":
      return policy(
        "stale-context",
        "disabled",
        "reopen",
        "none",
        "recovery",
        "stop",
      );
    case "failed":
      return policy(
        state.stale === null ? "none" : "stale-context",
        "disabled",
        state.retryable ? "retry" : "open-health",
        "none",
        "recovery",
        "stop",
      );
  }
}

function policy(
  contentTreatment: RecoveryPolicy["contentTreatment"],
  mutations: RecoveryPolicy["mutations"],
  primaryAction: RecoveryPolicy["primaryAction"],
  secondaryAction: RecoveryPolicy["secondaryAction"],
  focusTarget: RecoveryPolicy["focusTarget"],
  polling: RecoveryPolicy["polling"],
): RecoveryPolicy {
  return {
    contentTreatment,
    mutations,
    primaryAction,
    secondaryAction,
    focusTarget,
    polling,
  };
}

export function canMutate<T>(state: RecoveryState<T>): boolean {
  return recoveryPolicy(state).mutations !== "disabled";
}

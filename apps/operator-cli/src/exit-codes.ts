import type { OperationalExitClass } from "@memo-graph/contracts";

export const OPERATOR_EXIT_CODES = {
  success: 0,
  inspectable_degraded: 2,
  operator_action_required: 3,
  invalid_input: 64,
  invalid_confirmation: 65,
  internal_failure: 70,
} as const satisfies Record<OperationalExitClass, number>;

export function operatorExitCode(exitClass: OperationalExitClass): number {
  return OPERATOR_EXIT_CODES[exitClass];
}

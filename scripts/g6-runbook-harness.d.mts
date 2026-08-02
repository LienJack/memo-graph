export type G6RunbookStepState = "pass" | "fail" | "blocked";

export interface G6RunbookInvocationResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: { code?: string };
}

export function classifyG6RunbookInvocation(
  result: G6RunbookInvocationResult,
  schema: { parse(value: unknown): unknown },
  expectedExitCodes: readonly number[],
): { state: G6RunbookStepState };

export function runDirectG6RunbookHarness(): Promise<
  Record<string, G6RunbookStepState>
>;

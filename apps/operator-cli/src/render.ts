import {
  OperationalStatusSchema,
  WorkbenchLaunchResultSchema,
  canonicalJson,
  type OperationalStatus,
  type WorkbenchLaunchResult,
} from "@memo-graph/contracts";

export type OperatorOutputFormat = "human" | "json";

export function renderOperationalStatus(
  statusInput: OperationalStatus,
  format: OperatorOutputFormat,
): string {
  const status = OperationalStatusSchema.parse(statusInput);
  if (format === "json") {
    return `${canonicalJson(status)}\n`;
  }
  const lines = [
    `readiness: ${status.readiness}`,
    `qualification: ${status.qualification.status}`,
    `exit: ${status.exit_class}`,
    `next action: ${status.next_action}`,
  ];
  for (const reason of status.reasons) {
    lines.push(
      `reason: ${reason.reason_code} (${reason.component}/${reason.state})`,
    );
  }
  for (const component of status.components) {
    lines.push(`component: ${component.component}=${component.state}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderWorkbenchLaunch(
  resultInput: WorkbenchLaunchResult,
  format: OperatorOutputFormat,
  pairingCode: string | null,
  revealPairingCode: boolean,
): string {
  const result = WorkbenchLaunchResultSchema.parse(resultInput);
  if (format === "json") {
    return `${canonicalJson(result)}\n`;
  }
  const lines = [
    `workbench: ${result.status}`,
    `runtime: ${result.runtime_state}`,
    `url: ${result.origin}`,
    `browser: ${result.browser}`,
    `recovery: ${result.recovery}`,
  ];
  if (
    result.recovery === "pair_on_tty" &&
    pairingCode !== null &&
    revealPairingCode
  ) {
    lines.push(`pairing code: ${pairingCode}`);
  }
  return `${lines.join("\n")}\n`;
}

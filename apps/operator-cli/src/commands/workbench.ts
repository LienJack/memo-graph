import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  launchOrReuseWorkbench,
  type WorkbenchLaunchOutcome,
} from "@memo-graph/memory-workbench-host";
import {
  MemoryServerConfigSchema,
  type MemoryServerConfig,
} from "@memo-graph/runtime-host";

import type { OperatorConfig } from "../config.js";

export type WorkbenchLauncher = typeof launchOrReuseWorkbench;

export function workbenchRuntimeConfig(
  config: OperatorConfig,
): MemoryServerConfig {
  const authority = config.recovery.authority;
  const workbench = MemoryServerConfigSchema.omit({
    data_root: true,
    principal_id: true,
    recovery_head: true,
  }).parse(config.workbench ?? {
    allowed_scopes: [
      { kind: "workspace", id: "workspace_local" },
    ],
    allowed_authorities: [
      "user_stated",
      "observed",
      "tool_result",
      "inferred",
      "derived",
      "imported",
    ],
  });
  return MemoryServerConfigSchema.parse({
    data_root: config.data_root,
    principal_id: config.principal_id,
    ...workbench,
    recovery_head:
      authority === null
        ? { enabled: false }
        : {
            enabled: true,
            directory: authority.directory,
            authority_key_id: authority.authority_key_id,
            trust_root_version: authority.trust_root_version,
            private_key_path: authority.private_key_path,
            public_key_path: authority.public_key_path,
          },
  });
}

export function defaultWorkbenchRuntimeDirectory(): string {
  return join(
    realpathSync(tmpdir()),
    `memo-graph-workbench-${process.getuid?.() ?? "local"}`,
  );
}

export async function runWorkbench(input: {
  config: OperatorConfig;
  noOpen: boolean;
  headless: boolean;
  runtimeDirectory?: string;
  browserOpener?: (url: string) => Promise<void>;
  launcher?: WorkbenchLauncher;
}): Promise<WorkbenchLaunchOutcome> {
  return (input.launcher ?? launchOrReuseWorkbench)({
    config: workbenchRuntimeConfig(input.config),
    runtimeDirectory:
      input.runtimeDirectory ?? defaultWorkbenchRuntimeDirectory(),
    noOpen: input.noOpen,
    headless: input.headless,
    ...(input.browserOpener === undefined
      ? {}
      : { browserOpener: input.browserOpener }),
  });
}

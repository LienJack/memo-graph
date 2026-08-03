import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const MANAGED_HOOK_MARKER = "MEMO_GRAPH_AUTOMATIC_MEMORY";

type HookHandler = {
  type: "command";
  command: string;
  timeout: number;
  additionalContextLimit?: number;
};

type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

export type HooksJsonDocument = Record<string, unknown> & {
  hooks: Partial<Record<string, HookGroup[]>>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildManagedHookCommand(input: {
  nodeExecutable: string;
  hookEntryPath: string;
  descriptorPath: string;
  spoolDirectory: string;
}): string {
  for (const value of Object.values(input)) {
    if (!isAbsolute(value)) {
      throw new Error("CODEX_HOOK_PATH_NOT_ABSOLUTE");
    }
  }
  return [
    shellQuote(input.nodeExecutable),
    shellQuote(input.hookEntryPath),
    "--descriptor",
    shellQuote(input.descriptorPath),
    "--spool",
    shellQuote(input.spoolDirectory),
    "--managed-by",
    shellQuote("memo-graph"),
  ].join(" ");
}

const MANAGED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

function managedGroup(
  eventName: (typeof MANAGED_EVENTS)[number],
  command: string,
): HookGroup {
  const handler: HookHandler = {
    type: "command",
    command,
    timeout: 3,
    ...(eventName === "UserPromptSubmit"
      ? { additionalContextLimit: 4_000 }
      : {}),
  };
  return {
    ...(eventName === "SessionStart"
      ? { matcher: "startup|resume|clear|compact" }
      : {}),
    hooks: [handler],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedCommand(value: unknown): boolean {
  return typeof value === "string" &&
    value.includes(" --managed-by 'memo-graph'");
}

export function mergeHooksJsonDocument(
  input: unknown,
  command: string,
): HooksJsonDocument {
  if (!isRecord(input)) {
    throw new Error("CODEX_HOOKS_JSON_INVALID");
  }
  const rawHooks = input.hooks ?? {};
  if (!isRecord(rawHooks)) {
    throw new Error("CODEX_HOOKS_JSON_INVALID");
  }
  const hooks: Partial<Record<string, HookGroup[]>> = { ...rawHooks } as Partial<
    Record<string, HookGroup[]>
  >;
  for (const eventName of MANAGED_EVENTS) {
    const existing = hooks[eventName] ?? [];
    if (!Array.isArray(existing)) {
      throw new Error("CODEX_HOOKS_JSON_INVALID");
    }
    const withoutManaged = existing.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        throw new Error("CODEX_HOOKS_JSON_INVALID");
      }
      const handlers = group.hooks.filter(
        (handler) => !isRecord(handler) || !isManagedCommand(handler.command),
      );
      return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
    }) as HookGroup[];
    hooks[eventName] = [...withoutManaged, managedGroup(eventName, command)];
  }
  return { ...input, hooks };
}

export function removeManagedHooksJsonDocument(
  input: unknown,
): HooksJsonDocument {
  if (!isRecord(input) || !isRecord(input.hooks)) {
    throw new Error("CODEX_HOOKS_JSON_INVALID");
  }
  const hooks: Partial<Record<string, HookGroup[]>> = { ...input.hooks } as Partial<
    Record<string, HookGroup[]>
  >;
  for (const [eventName, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) {
      throw new Error("CODEX_HOOKS_JSON_INVALID");
    }
    const groups = rawGroups.flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        throw new Error("CODEX_HOOKS_JSON_INVALID");
      }
      const handlers = group.hooks.filter(
        (handler) => !isRecord(handler) || !isManagedCommand(handler.command),
      );
      return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
    }) as HookGroup[];
    if (groups.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = groups;
    }
  }
  return { ...input, hooks };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function enableCodexHooksFeature(document: string): string {
  const lines = document.split("\n");
  const featureIndex = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/u.test(line));
  if (featureIndex === -1) {
    const prefix = document.length === 0 || document.endsWith("\n") ? document : `${document}\n`;
    return `${prefix}\n[features]\nhooks = true\n`;
  }
  let end = lines.length;
  for (let index = featureIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/u.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const hookIndex = lines
    .slice(featureIndex + 1, end)
    .findIndex((line) => /^\s*(?:hooks|codex_hooks)\s*=/u.test(line));
  if (hookIndex >= 0) {
    lines[featureIndex + 1 + hookIndex] = "hooks = true";
  } else {
    lines.splice(end, 0, "hooks = true");
  }
  return lines.join("\n");
}

function managedToml(command: string): string {
  const blocks: string[] = [`# BEGIN ${MANAGED_HOOK_MARKER}`];
  for (const eventName of MANAGED_EVENTS) {
    blocks.push(`[[hooks.${eventName}]]`);
    if (eventName === "SessionStart") {
      blocks.push('matcher = "startup|resume|clear|compact"');
    }
    blocks.push(
      `[[hooks.${eventName}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(command)}`,
      "timeout = 3",
    );
    if (eventName === "UserPromptSubmit") {
      blocks.push("additionalContextLimit = 4000");
    }
    blocks.push("");
  }
  blocks.push(`# END ${MANAGED_HOOK_MARKER}`);
  return blocks.join("\n");
}

export function mergeHooksTomlDocument(
  input: string,
  command: string,
): string {
  const markerPattern = new RegExp(
    `(?:^|\\n)# BEGIN ${MANAGED_HOOK_MARKER}\\n[\\s\\S]*?\\n# END ${MANAGED_HOOK_MARKER}(?=\\n|$)`,
    "gu",
  );
  const withoutManaged = input.replace(markerPattern, "").replace(/\n{3,}/gu, "\n\n");
  const enabled = enableCodexHooksFeature(withoutManaged).trimEnd();
  return `${enabled}\n\n${managedToml(command)}\n`;
}

export function removeManagedHooksTomlDocument(input: string): string {
  const markerPattern = new RegExp(
    `(?:^|\\n)# BEGIN ${MANAGED_HOOK_MARKER}\\n[\\s\\S]*?\\n# END ${MANAGED_HOOK_MARKER}(?=\\n|$)`,
    "gu",
  );
  const next = input.replace(markerPattern, "").replace(/\n{3,}/gu, "\n\n");
  return next.length === 0 || next.endsWith("\n") ? next : `${next}\n`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.memo-graph-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export type InstalledCodexHookConfiguration = {
  backupDirectory: string;
  representation: "json" | "toml";
  concurrentSourcesDetected: boolean;
  trustReviewRequired: true;
};

export function installCodexHookConfiguration(input: {
  hooksJsonPath: string;
  codexConfigPath: string;
  backupRoot: string;
  command: string;
}): InstalledCodexHookConfiguration {
  for (const path of [
    input.hooksJsonPath,
    input.codexConfigPath,
    input.backupRoot,
  ]) {
    if (!isAbsolute(path)) {
      throw new Error("CODEX_HOOK_CONFIGURATION_PATH_NOT_ABSOLUTE");
    }
  }
  const hooksExisted = existsSync(input.hooksJsonPath);
  const configExisted = existsSync(input.codexConfigPath);
  const hooksOriginal = hooksExisted
    ? readFileSync(input.hooksJsonPath, "utf8")
    : null;
  const configOriginal = configExisted
    ? readFileSync(input.codexConfigPath, "utf8")
    : "";
  const tomlHooksExist = /^\s*\[\[hooks\./mu.test(configOriginal);
  const representation: "json" | "toml" = hooksExisted || !tomlHooksExist
    ? "json"
    : "toml";
  let hooksNext: string | null = null;
  let configNext: string;
  if (representation === "json") {
    const parsed = hooksOriginal === null
      ? {}
      : JSON.parse(hooksOriginal) as unknown;
    hooksNext = `${JSON.stringify(
      mergeHooksJsonDocument(parsed, input.command),
      null,
      2,
    )}\n`;
    configNext = enableCodexHooksFeature(configOriginal);
  } else {
    configNext = mergeHooksTomlDocument(configOriginal, input.command);
  }
  const backupDirectory = join(
    input.backupRoot,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  writeFileSync(
    join(backupDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: "1.0.0",
        hooks_json_path: input.hooksJsonPath,
        hooks_json_existed: hooksExisted,
        codex_config_path: input.codexConfigPath,
        codex_config_existed: configExisted,
        representation,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  if (hooksOriginal !== null) {
    writeFileSync(join(backupDirectory, "hooks.json"), hooksOriginal, {
      mode: 0o600,
    });
  }
  if (configExisted) {
    writeFileSync(join(backupDirectory, "config.toml"), configOriginal, {
      mode: 0o600,
    });
  }
  try {
    if (hooksNext !== null) {
      atomicWrite(input.hooksJsonPath, hooksNext);
    }
    atomicWrite(input.codexConfigPath, configNext);
  } catch (error) {
    if (hooksExisted && hooksOriginal !== null) {
      atomicWrite(input.hooksJsonPath, hooksOriginal);
    } else {
      rmSync(input.hooksJsonPath, { force: true });
    }
    if (configExisted) {
      atomicWrite(input.codexConfigPath, configOriginal);
    } else {
      rmSync(input.codexConfigPath, { force: true });
    }
    throw error;
  }
  return {
    backupDirectory,
    representation,
    concurrentSourcesDetected: hooksExisted && tomlHooksExist,
    trustReviewRequired: true,
  };
}

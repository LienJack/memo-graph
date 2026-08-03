#!/usr/bin/env node

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AutomaticMemoryHookCaptureResponseSchema,
  canonicalJson,
  type AutomaticMemoryHookCaptureRequest,
  type AutomaticMemoryHookCaptureResponse,
} from "@memo-graph/contracts";
import {
  readAutomaticMemoryHookDescriptor,
} from "@memo-graph/memory-workbench-host";
import { readPrivateOperatorFile } from "@memo-graph/runtime-host";

import {
  automaticMemoryHookEventHasSecretSignal,
  codexHookEventName,
  codexHookSuccessOutput,
  normalizeCodexHookEvent,
  type SupportedCodexHookEventName,
} from "./hook-contract.js";
import { AutomaticMemoryHookSpool } from "./hook-spool.js";

const MAX_STDIN_BYTES = 80 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024;

type HookArguments = {
  descriptorPath: string;
  spoolDirectory: string;
};

function parseArguments(argv: string[]): HookArguments {
  const values: Partial<HookArguments> = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      seen.has(flag)
    ) {
      throw new Error("HOOK_ARGUMENTS_INVALID");
    }
    seen.add(flag);
    if (flag === "--descriptor") {
      values.descriptorPath = value;
    } else if (flag === "--spool") {
      values.spoolDirectory = value;
    } else if (flag !== "--managed-by" || value !== "memo-graph") {
      throw new Error("HOOK_ARGUMENTS_INVALID");
    }
  }
  if (
    values.descriptorPath === undefined ||
    values.spoolDirectory === undefined ||
    !isAbsolute(values.descriptorPath) ||
    !isAbsolute(values.spoolDirectory)
  ) {
    throw new Error("HOOK_ARGUMENTS_INVALID");
  }
  return values as HookArguments;
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_STDIN_BYTES) {
      throw new Error("HOOK_STDIN_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
}

async function sendToHost(
  descriptorPath: string,
  request: AutomaticMemoryHookCaptureRequest,
): Promise<AutomaticMemoryHookCaptureResponse> {
  const descriptor = readAutomaticMemoryHookDescriptor(descriptorPath);
  if (
    resolve(dirname(descriptor.credential_path)) !==
    resolve(dirname(descriptorPath))
  ) {
    throw new Error("HOOK_DESCRIPTOR_AUTHORITY_INVALID");
  }
  const credentialBytes = readPrivateOperatorFile(descriptor.credential_path);
  try {
    const credential = credentialBytes.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential)) {
      throw new Error("HOOK_CREDENTIAL_INVALID");
    }
    const response = await fetch(`${descriptor.origin}${descriptor.capture_path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: canonicalJson(request),
      signal: AbortSignal.timeout(650),
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("HOOK_CAPTURE_UNAVAILABLE");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("HOOK_CAPTURE_RESPONSE_TOO_LARGE");
    }
    return AutomaticMemoryHookCaptureResponseSchema.parse(
      JSON.parse(text) as unknown,
    );
  } finally {
    credentialBytes.fill(0);
  }
}

function writeSuccess(
  eventName: SupportedCodexHookEventName | null,
  additionalContext: string | null,
): void {
  if (eventName === null) {
    return;
  }
  process.stdout.write(
    `${canonicalJson(codexHookSuccessOutput(eventName, additionalContext))}\n`,
  );
}

export async function runCodexHookCommand(
  argv = process.argv.slice(2),
): Promise<void> {
  let eventName: SupportedCodexHookEventName | null = null;
  try {
    const arguments_ = parseArguments(argv);
    const raw = await readStdin();
    eventName = codexHookEventName(raw);
    const event = normalizeCodexHookEvent(raw);
    if (
      automaticMemoryHookEventHasSecretSignal(event) ||
      (event.event_kind === "assistant_stop" &&
        event.last_assistant_message === null)
    ) {
      writeSuccess(eventName, null);
      return;
    }
    const request: AutomaticMemoryHookCaptureRequest = {
      schema_version: "1.0.0",
      idempotency_key: `codex-hook:${event.event_id}`,
      source: "direct",
      event,
    };
    const spool = new AutomaticMemoryHookSpool({
      directory: arguments_.spoolDirectory,
    });
    const send = (pending: AutomaticMemoryHookCaptureRequest) =>
      sendToHost(arguments_.descriptorPath, pending);
    try {
      await spool.flush(send, 8);
    } catch {
      // A prior unavailable event remains durable; the current event still gets one attempt.
    }
    let response: AutomaticMemoryHookCaptureResponse | null = null;
    try {
      response = await send(request);
    } catch {
      try {
        spool.enqueue(request);
      } catch {
        // Hook failures remain silent and never block Codex.
      }
    }
    writeSuccess(eventName, response?.additional_context ?? null);
  } catch {
    writeSuccess(eventName, null);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCodexHookCommand();
}

import {
  AutomaticMemoryEventSchema,
  canonicalSha256,
  type AutomaticMemoryEvent,
} from "@memo-graph/contracts";
import { z } from "zod";

const CommonHookInputSchema = z
  .object({
    session_id: z.string().min(1).max(160),
    transcript_path: z.string().max(4_096).nullable().optional(),
    cwd: z.string().min(1).max(4_096),
    hook_event_name: z.string().min(1).max(80),
    model: z.string().trim().min(1).max(240).nullable().optional(),
  })
  .loose();

const SessionStartHookInputSchema = CommonHookInputSchema.extend({
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear", "compact"]),
});

const UserPromptSubmitHookInputSchema = CommonHookInputSchema.extend({
  hook_event_name: z.literal("UserPromptSubmit"),
  turn_id: z.string().min(1).max(160),
  prompt: z.string().min(1).max(64_000),
});

const StopHookInputSchema = CommonHookInputSchema.extend({
  hook_event_name: z.literal("Stop"),
  turn_id: z.string().min(1).max(160),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().min(1).max(64_000).nullable(),
});

const SessionEndHookInputSchema = CommonHookInputSchema.extend({
  hook_event_name: z.literal("SessionEnd"),
  reason: z.enum(["clear", "logout", "prompt_input_exit", "other"]),
});

export type SupportedCodexHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionEnd";

function eventIdentifier(value: unknown): string {
  return `hook:${canonicalSha256({
    domain: "memo-graph/codex-hook-event/v1",
    value,
  }).slice("sha256:".length)}`;
}

export function normalizeCodexHookEvent(
  input: unknown,
  options: { now?: () => string } = {},
): AutomaticMemoryEvent {
  const common = CommonHookInputSchema.safeParse(input);
  if (!common.success) {
    throw new Error("CODEX_HOOK_EVENT_INVALID");
  }
  const occurredAt = (options.now ?? (() => new Date().toISOString()))();
  const base = {
    schema_version: "1.0.0" as const,
    session_id: common.data.session_id,
    cwd: common.data.cwd,
    occurred_at: occurredAt,
    model: common.data.model ?? null,
  };
  let event: Record<string, unknown>;
  switch (common.data.hook_event_name) {
    case "SessionStart": {
      const parsed = SessionStartHookInputSchema.parse(input);
      const identity = {
        event_kind: "session_start",
        session_id: parsed.session_id,
        cwd: parsed.cwd,
        source: parsed.source,
        model: parsed.model ?? null,
      };
      event = {
        ...base,
        ...identity,
        event_id: eventIdentifier(identity),
      };
      break;
    }
    case "UserPromptSubmit": {
      const parsed = UserPromptSubmitHookInputSchema.parse(input);
      const identity = {
        event_kind: "user_prompt_submit",
        session_id: parsed.session_id,
        turn_id: parsed.turn_id,
        cwd: parsed.cwd,
        generation: 1,
        prompt: parsed.prompt,
        model: parsed.model ?? null,
      };
      event = {
        ...base,
        ...identity,
        event_id: eventIdentifier(identity),
      };
      break;
    }
    case "Stop": {
      const parsed = StopHookInputSchema.parse(input);
      const identity = {
        event_kind: "assistant_stop",
        session_id: parsed.session_id,
        turn_id: parsed.turn_id,
        cwd: parsed.cwd,
        generation: parsed.stop_hook_active ? 2 : 1,
        stop_hook_active: parsed.stop_hook_active,
        last_assistant_message: parsed.last_assistant_message,
        model: parsed.model ?? null,
      };
      event = {
        ...base,
        ...identity,
        event_id: eventIdentifier(identity),
      };
      break;
    }
    case "SessionEnd": {
      const parsed = SessionEndHookInputSchema.parse(input);
      const identity = {
        event_kind: "session_end",
        session_id: parsed.session_id,
        cwd: parsed.cwd,
        reason: parsed.reason,
        model: parsed.model ?? null,
      };
      event = {
        ...base,
        ...identity,
        event_id: eventIdentifier(identity),
      };
      break;
    }
    default:
      throw new Error("CODEX_HOOK_EVENT_UNSUPPORTED");
  }
  return AutomaticMemoryEventSchema.parse(event);
}

export function codexHookSuccessOutput(
  eventName: SupportedCodexHookEventName,
  additionalContext: string | null,
): Record<string, unknown> {
  if (
    eventName === "UserPromptSubmit" &&
    additionalContext !== null &&
    additionalContext.trim().length > 0
  ) {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  }
  return {};
}

export function codexHookEventName(input: unknown): SupportedCodexHookEventName | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as { hook_event_name?: unknown }).hook_event_name;
  return value === "SessionStart" ||
    value === "UserPromptSubmit" ||
    value === "Stop" ||
    value === "SessionEnd"
    ? value
    : null;
}

const SECRET_SIGNAL =
  /(?:\b(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,})\b|\bBearer\s+[A-Za-z0-9._~-]{16,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

export function automaticMemoryHookEventHasSecretSignal(
  event: AutomaticMemoryEvent,
): boolean {
  const text = event.event_kind === "user_prompt_submit"
    ? event.prompt
    : event.event_kind === "assistant_stop"
      ? event.last_assistant_message
      : null;
  return text !== null && SECRET_SIGNAL.test(text);
}

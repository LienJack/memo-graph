import { describe, expect, it } from "vitest";

import {
  codexHookSuccessOutput,
  normalizeCodexHookEvent,
} from "../../apps/codex-bootstrap/src/hook-contract.js";

const NOW = "2026-08-03T08:00:00.000Z";

describe("Codex automatic-memory hook contract", () => {
  it("normalizes only the four allowlisted Codex lifecycle events", () => {
    expect(
      normalizeCodexHookEvent(
        {
          session_id: "thr_123",
          transcript_path: "/private/transcript.jsonl",
          cwd: "/workspace",
          hook_event_name: "UserPromptSubmit",
          turn_id: "turn_123",
          prompt: "Use pnpm for this repository.",
          model: "gpt-5.6",
        },
        { now: () => NOW },
      ),
    ).toMatchObject({
      schema_version: "1.0.0",
      event_kind: "user_prompt_submit",
      session_id: "thr_123",
      turn_id: "turn_123",
      generation: 1,
      prompt: "Use pnpm for this repository.",
      occurred_at: NOW,
    });

    expect(
      normalizeCodexHookEvent(
        {
          session_id: "thr_123",
          transcript_path: null,
          cwd: "/workspace",
          hook_event_name: "Stop",
          turn_id: "turn_123",
          stop_hook_active: false,
          last_assistant_message: "Implemented and verified.",
        },
        { now: () => NOW },
      ),
    ).toMatchObject({
      event_kind: "assistant_stop",
      generation: 1,
      stop_hook_active: false,
      last_assistant_message: "Implemented and verified.",
    });

    expect(() =>
      normalizeCodexHookEvent({
        session_id: "thr_123",
        cwd: "/workspace",
        hook_event_name: "PreToolUse",
      }),
    ).toThrow("CODEX_HOOK_EVENT_UNSUPPORTED");
  });

  it("derives stable content-addressed event ids without transcript paths", () => {
    const common = {
      session_id: "thr_123",
      cwd: "/workspace",
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn_123",
      prompt: "Remember the repository convention.",
    };
    const left = normalizeCodexHookEvent(
      { ...common, transcript_path: "/first/private/path" },
      { now: () => NOW },
    );
    const right = normalizeCodexHookEvent(
      { ...common, transcript_path: "/second/private/path" },
      { now: () => "2026-08-03T08:00:01.000Z" },
    );

    expect(left.event_id).toBe(right.event_id);
  });

  it("never emits a blocking or continuation decision", () => {
    expect(codexHookSuccessOutput("Stop", null)).toEqual({});
    expect(
      codexHookSuccessOutput(
        "UserPromptSubmit",
        "Relevant governed memory context",
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Relevant governed memory context",
      },
    });
    expect(
      JSON.stringify(codexHookSuccessOutput("Stop", null)),
    ).not.toMatch(/decision|continue|reason/iu);
  });
});

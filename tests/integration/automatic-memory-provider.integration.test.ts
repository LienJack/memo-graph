import { describe, expect, it } from "vitest";

import {
  ProviderFormationRequestSchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  OpenAIResponsesFormationProvider,
  redactProviderFormationTurns,
} from "../../packages/memory-formation/src/index.js";

const NOW = "2026-08-03T08:00:00.000Z";

describe("automatic-memory structured provider", () => {
  it("redacts secrets, configured identifiers, and local paths before egress", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz";
    const redacted = redactProviderFormationTurns({
      sensitiveIdentifiers: ["customer-8472"],
      turns: [
        {
          evidence_id: "evidence:user-1",
          role: "user",
          text: `customer-8472 uses ${secret} in /Users/alice/private/repo`,
          content_hash: canonicalSha256("original"),
        },
      ],
    });

    expect(redacted.report).toMatchObject({
      action: "redacted",
      egress_safe: true,
      finding_categories: expect.arrayContaining([
        "access_token",
        "configured_identifier",
        "local_path",
      ]),
    });
    expect(redacted.turns[0]?.text).not.toContain(secret);
    expect(redacted.turns[0]?.text).not.toContain("customer-8472");
    expect(redacted.turns[0]?.text).not.toContain("/Users/alice");
  });

  it("uses Responses structured output without tools or persisted requests", async () => {
    let capturedBody = "";
    const provider = new OpenAIResponsesFormationProvider({
      apiKey: "test-api-key-not-for-body",
      model: "gpt-5.6-luna",
      clock: () => NOW,
      fetch: async (_url, init) => {
        capturedBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({ proposals: [] }),
            usage: { input_tokens: 123, output_tokens: 7 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const redacted = redactProviderFormationTurns({
      turns: [
        {
          evidence_id: "evidence:user-1",
          role: "user",
          text: "I consistently prefer concise Chinese explanations.",
          content_hash: canonicalSha256({
            storage: "inline",
            text: "I consistently prefer concise Chinese explanations.",
            media_type: "text/plain",
          }),
        },
      ],
    });
    const request = ProviderFormationRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: "formation:request-1",
      provider_id: "openai_responses",
      model: "gpt-5.6-luna",
      prompt_version: "1.0.0",
      policy_version: "1.0.0",
      schema_revision: "1.0.0",
      requested_at: NOW,
      project_identity_hash: `sha256:${"a".repeat(64)}`,
      redaction: redacted.report,
      turns: redacted.turns,
    });

    await expect(provider.extract(request)).resolves.toMatchObject({
      provider_id: "openai_responses",
      model: "gpt-5.6-luna",
      proposals: [],
      usage: { input_tokens: 123, output_tokens: 7 },
    });
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body).toMatchObject({ store: false, tools: [] });
    expect(capturedBody).not.toContain("test-api-key-not-for-body");
    expect(capturedBody).toContain("json_schema");
  });

  it("rejects malformed model output without heuristic fallback", async () => {
    const provider = new OpenAIResponsesFormationProvider({
      apiKey: "test-api-key",
      model: "gpt-5.6-luna",
      fetch: async () => new Response(
        JSON.stringify({ output_text: '{"proposals":[{"category":"unsupported"}]}' }),
        { status: 200 },
      ),
    });
    const redacted = redactProviderFormationTurns({
      turns: [{
        evidence_id: "evidence:user-1",
        role: "user",
        text: "Temporary request only.",
        content_hash: canonicalSha256({
          storage: "inline",
          text: "Temporary request only.",
          media_type: "text/plain",
        }),
      }],
    });
    const request = ProviderFormationRequestSchema.parse({
      schema_version: "1.0.0",
      request_id: "formation:malformed",
      provider_id: "openai_responses",
      model: "gpt-5.6-luna",
      prompt_version: "1.0.0",
      policy_version: "1.0.0",
      schema_revision: "1.0.0",
      requested_at: NOW,
      project_identity_hash: `sha256:${"b".repeat(64)}`,
      redaction: redacted.report,
      turns: redacted.turns,
    });
    await expect(provider.extract(request)).rejects.toThrow();
  });
});

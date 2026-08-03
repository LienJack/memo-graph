import {
  ProviderFormationTurnSchema,
  RedactionReportSchema,
  canonicalSha256,
  type ProviderFormationTurn,
  type RedactionFindingCategory,
  type RedactionReport,
} from "@memo-graph/contracts";
import type { z } from "zod";

type RedactionResult = {
  turns: ProviderFormationTurn[];
  report: RedactionReport;
};

type Rule = {
  category: RedactionFindingCategory;
  pattern: RegExp;
  replacement: string;
};

const RULES: Rule[] = [
  {
    category: "private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    category: "access_token",
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,})\b/gu,
    replacement: "[REDACTED_ACCESS_TOKEN]",
  },
  {
    category: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gu,
    replacement: "Bearer [REDACTED_CREDENTIAL]",
  },
  {
    category: "connection_string",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]{8,}/giu,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  {
    category: "local_path",
    pattern:
      /(?:\/(?:Users|home|private|var\/folders)\/[^\s"'<>]+|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'<>]+)/gu,
    replacement: "[REDACTED_LOCAL_PATH]",
  },
  {
    category: "high_entropy_value",
    pattern:
      /\b(?=[A-Za-z0-9_./+=-]{28,}\b)(?=[A-Za-z0-9_./+=-]*[A-Z])(?=[A-Za-z0-9_./+=-]*[a-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b/gu,
    replacement: "[REDACTED_HIGH_ENTROPY]",
  },
];

function replaceLiteral(text: string, value: string): string {
  return text.split(value).join("[REDACTED_CONFIGURED_IDENTIFIER]");
}

export function redactProviderFormationTurns(input: {
  turns: readonly z.input<typeof ProviderFormationTurnSchema>[];
  sensitiveIdentifiers?: readonly string[];
  policyVersion?: "1.0.0";
}): RedactionResult {
  const original = input.turns.map((turn) =>
    ProviderFormationTurnSchema.parse(turn)
  );
  const findings = new Set<RedactionFindingCategory>();
  const turns = original.map((turn) => {
    let text = turn.text;
    for (const identifier of input.sensitiveIdentifiers ?? []) {
      if (identifier.length >= 3 && text.includes(identifier)) {
        findings.add("configured_identifier");
        text = replaceLiteral(text, identifier);
      }
    }
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) {
        findings.add(rule.category);
        rule.pattern.lastIndex = 0;
        text = text.replace(rule.pattern, rule.replacement);
      }
    }
    return ProviderFormationTurnSchema.parse({
      ...turn,
      text,
      content_hash: canonicalSha256({ storage: "inline", text, media_type: "text/plain" }),
    });
  });
  const originalHash = canonicalSha256(
    original.map((turn) => ({ evidence_id: turn.evidence_id, text: turn.text })),
  );
  const redactedHash = canonicalSha256(
    turns.map((turn) => ({ evidence_id: turn.evidence_id, text: turn.text })),
  );
  const report = RedactionReportSchema.parse({
    schema_version: "1.0.0",
    policy_version: input.policyVersion ?? "1.0.0",
    original_hash: originalHash,
    redacted_hash: redactedHash,
    action: findings.size === 0 ? "accepted" : "redacted",
    finding_categories: [...findings].sort(),
    egress_safe: true,
  });
  return { turns, report };
}

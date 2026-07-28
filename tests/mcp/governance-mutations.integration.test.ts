import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  ApprovalGrantSchema,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import type {
  ApprovalBindingSchema,
} from "../../packages/contracts/src/index.js";
import {
  MemoryServerConfigSchema,
} from "../../packages/mcp-server/src/index.js";
import {
  ApprovalError,
  MemoryRuntime,
  type ApprovalBinding,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "../../packages/memory-kernel/src/index.js";
import { SqliteStorageClient } from "@memo-graph/storage-sqlite";
import type { z } from "zod";

import {
  memoryCandidate,
  memoryProposal,
} from "../helpers/governance-examples.js";
import { inlineEpisode } from "../helpers/storage-examples.js";

const cleanupPaths: string[] = [];
const NOW = "2026-07-28T13:00:00.000Z";
const SCOPE = { kind: "workspace", id: "workspace_local" } as const;

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

class TestApprovalRegistry implements ApprovalRegistry {
  readonly grants = new Map<string, ReturnType<typeof ApprovalGrantSchema.parse>>();
  verifyCalls = 0;

  approve(request: {
    envelope: {
      approval_id: string | null;
      actor_claim: { principal_id: string };
      tool: z.input<typeof ApprovalBindingSchema>["tool"];
      safety_class: z.input<typeof ApprovalBindingSchema>["safety_class"];
      scopes: z.input<typeof ApprovalBindingSchema>["scopes"];
    };
  }): void {
    const approvalId = request.envelope.approval_id;
    if (approvalId === null) {
      throw new Error("effect fixture requires approval id");
    }
    const unsigned = {
      schema_version: "1.0.0",
      approval_id: approvalId,
      principal_id: request.envelope.actor_claim.principal_id,
      tool: request.envelope.tool,
      safety_class: request.envelope.safety_class,
      scopes: request.envelope.scopes,
      request_hash: canonicalSha256(request),
      issued_at: "2026-07-28T12:00:00.000Z",
      expires_at: "2026-07-28T14:00:00.000Z",
      manifest_hash: `sha256:${"0".repeat(64)}`,
    } as const;
    this.grants.set(
      approvalId,
      ApprovalGrantSchema.parse({
        ...unsigned,
        manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
      }),
    );
  }

  async verify(binding: ApprovalBinding): Promise<VerifiedApproval> {
    this.verifyCalls += 1;
    const grant = this.grants.get(binding.approval_id);
    if (grant === undefined) {
      throw new ApprovalError("APPROVAL_REQUIRED");
    }
    expect(grant).toMatchObject(binding);
    return {
      grant,
      registry_hash: canonicalSha256([...this.grants.keys()].sort()),
    };
  }

  async confirmUnchanged(_approval: VerifiedApproval): Promise<void> {}
}

function runtime(
  storage: SqliteStorageClient,
  approvals: TestApprovalRegistry,
  destructiveToolsEnabled = false,
): MemoryRuntime {
  return new MemoryRuntime({
    storage,
    approvalRegistry: approvals,
    clock: () => NOW,
    policy: {
      principal: {
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: destructiveToolsEnabled,
      },
      default_token_budget: 1_800,
    },
  });
}

async function seeded(
  prefix: string,
): Promise<{
  storage: SqliteStorageClient;
  runtime: MemoryRuntime;
  approvals: TestApprovalRegistry;
  memoryId: string;
  revisionId: string;
  dataRoot: string;
}> {
  const dataRoot = temporaryRoot(prefix);
  const storage = await SqliteStorageClient.open({ dataRoot });
  await storage.commitEpisode(inlineEpisode({}));
  const approvals = new TestApprovalRegistry();
  const kernel = runtime(storage, approvals);
  const proposed = await kernel.memoryPropose(
    memoryProposal({
      candidate: memoryCandidate({ scope: SCOPE }),
    }),
  );
  expect(proposed.status).toBe("OK");
  if (proposed.status !== "OK") {
    throw new Error("seed proposal must activate");
  }
  const result = proposed.data as {
    memory_id: string;
    current_revision_id: string;
  };
  return {
    storage,
    runtime: kernel,
    approvals,
    memoryId: result.memory_id,
    revisionId: result.current_revision_id,
    dataRoot,
  };
}

function mutationEnvelope(options: {
  tool:
    | "memory_correct"
    | "memory_pin"
    | "memory_demote"
    | "memory_usage_set"
    | "memory_revoke"
    | "memory_delete";
  idempotencyKey: string;
  expectedRevisionId: string;
  approvalId: string | null;
  dryRun?: boolean;
}) {
  return {
    schema_version: "1.0.0",
    request_id: `request_${options.idempotencyKey}`,
    tool: options.tool,
    safety_class:
      options.tool === "memory_delete"
        ? ("destructive" as const)
        : ("important_mutation" as const),
    actor_claim: {
      principal_id: "user_local",
      authority: "user_stated" as const,
    },
    scopes: [SCOPE],
    purpose: "Apply a distinct governed user control",
    reason: "The local user requested this exact effect",
    requested_at: NOW,
    idempotency_key: options.idempotencyKey,
    expected_revision_id: options.expectedRevisionId,
    approval_id: options.approvalId,
    dry_run: options.dryRun ?? false,
  };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("governance mutation runtime", () => {
  it("keeps destructive tools disabled by default and requires explicit enablement", () => {
    const base = {
      data_root: "/tmp/memo-graph-governance-config",
      principal_id: "user_local",
      allowed_scopes: [SCOPE],
      allowed_authorities: ["user_stated" as const],
    };
    expect(
      MemoryServerConfigSchema.parse(base).destructive_tools_enabled,
    ).toBe(false);
    expect(
      MemoryServerConfigSchema.parse({
        ...base,
        destructive_tools_enabled: true,
      }).destructive_tools_enabled,
    ).toBe(true);
  });

  it("atomically consumes approval and replays before asking for it again", async () => {
    const fixture = await seeded("control-replay");
    const input = {
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-control-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_pin_once",
      }),
      memory_id: fixture.memoryId,
      pinned: true,
    };
    fixture.approvals.approve(input);

    const first = await fixture.runtime.memoryPin(input);
    expect(first).toMatchObject({
      status: "OK",
      data: {
        outcome: "PINNED",
        memory_id: fixture.memoryId,
        pinned: true,
        replayed: false,
      },
    });
    fixture.approvals.grants.clear();
    const replayed = await fixture.runtime.memoryPin(input);
    expect(replayed).toMatchObject({
      status: "OK",
      receipt_id: first.receipt_id,
      data: {
        outcome: "PINNED",
        memory_id: fixture.memoryId,
        replayed: true,
      },
    });
    if (first.status === "OK" && replayed.status === "OK") {
      expect(
        (replayed.data as { receipt: unknown }).receipt,
      ).toEqual((first.data as { receipt: unknown }).receipt);
    }
    expect(fixture.approvals.verifyCalls).toBe(1);

    const reusedInput = {
      ...input,
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-control-002",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_pin_once",
      }),
    };
    fixture.approvals.approve(reusedInput);
    const reused = await fixture.runtime.memoryPin(reusedInput);
    expect(reused).toMatchObject({
      status: "FAILED",
      error: { code: "APPROVAL_INVALID" },
    });

    const health = await fixture.storage.health();
    expect(health.counts).toMatchObject({
      pin_events: 1,
      approval_consumptions: 1,
    });
    await fixture.storage.close();
  });

  it("records a dry-run receipt without changing epoch, pointer, pin, or approval", async () => {
    const fixture = await seeded("control-dry-run");
    const before = await fixture.storage.health();
    const input = {
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-dry-run-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: null,
        dryRun: true,
      }),
      memory_id: fixture.memoryId,
      pinned: true,
    };
    const preview = await fixture.runtime.memoryPin(input);
    const after = await fixture.storage.health();

    expect(preview).toMatchObject({
      status: "OK",
      data: {
        outcome: "DRY_RUN",
        pinned: false,
        receipt: { warnings: ["DRY_RUN"] },
      },
    });
    expect(after.ledger_epoch).toBe(before.ledger_epoch);
    expect(after.counts.pin_events).toBe(before.counts.pin_events);
    expect(after.counts.approval_consumptions).toBe(
      before.counts.approval_consumptions,
    );
    await fixture.storage.close();
  });

  it("keeps pin, scoped usage, demote, and revoke semantically distinct", async () => {
    const fixture = await seeded("control-semantics");
    const pin = {
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-semantics-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_pin_semantics",
      }),
      memory_id: fixture.memoryId,
      pinned: true,
    };
    fixture.approvals.approve(pin);
    expect((await fixture.runtime.memoryPin(pin)).status).toBe("OK");

    const usage = {
      envelope: mutationEnvelope({
        tool: "memory_usage_set",
        idempotencyKey: "memory-usage-semantics-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_usage_semantics",
      }),
      memory_id: fixture.memoryId,
      effect: "block" as const,
      context_scope: SCOPE,
    };
    fixture.approvals.approve(usage);
    expect((await fixture.runtime.memoryUsageSet(usage)).status).toBe("OK");
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: SCOPE,
      }),
    ).toMatchObject({
      eligible: false,
      reason_code: "USAGE_BLOCKED",
    });
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: { kind: "user", id: "user_local" },
      }),
    ).toMatchObject({ eligible: true });

    const globalBlock = {
      envelope: mutationEnvelope({
        tool: "memory_usage_set",
        idempotencyKey: "memory-usage-global-block-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_usage_global_block",
      }),
      memory_id: fixture.memoryId,
      effect: "block" as const,
      context_scope: null,
    };
    fixture.approvals.approve(globalBlock);
    expect(
      (await fixture.runtime.memoryUsageSet(globalBlock)).status,
    ).toBe("OK");
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: { kind: "user", id: "user_local" },
      }),
    ).toMatchObject({ eligible: false, reason_code: "USAGE_BLOCKED" });

    const scopedAllow = {
      envelope: mutationEnvelope({
        tool: "memory_usage_set",
        idempotencyKey: "memory-usage-scoped-allow-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_usage_scoped_allow",
      }),
      memory_id: fixture.memoryId,
      effect: "allow" as const,
      context_scope: SCOPE,
    };
    fixture.approvals.approve(scopedAllow);
    expect(
      (await fixture.runtime.memoryUsageSet(scopedAllow)).status,
    ).toBe("OK");
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: SCOPE,
      }),
    ).toMatchObject({ eligible: true });
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: { kind: "user", id: "user_local" },
      }),
    ).toMatchObject({ eligible: false, reason_code: "USAGE_BLOCKED" });

    const revoke = {
      envelope: mutationEnvelope({
        tool: "memory_revoke",
        idempotencyKey: "memory-revoke-semantics-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_revoke_semantics",
      }),
      memory_id: fixture.memoryId,
    };
    fixture.approvals.approve(revoke);
    expect(await fixture.runtime.memoryRevoke(revoke)).toMatchObject({
      status: "OK",
      data: { outcome: "REVOKED", lifecycle: "revoked", pinned: true },
    });
    expect(
      await fixture.storage.checkMemoryEligibility({
        memory_id: fixture.memoryId,
        revision_id: fixture.revisionId,
        principal_id: "user_local",
        scope: SCOPE,
        as_of: NOW,
        include_sensitive: false,
        context_scope: { kind: "user", id: "user_local" },
      }),
    ).toMatchObject({ eligible: false, reason_code: "REVOKED" });

    const demotedFixture = await seeded("control-demote");
    const demote = {
      envelope: mutationEnvelope({
        tool: "memory_demote",
        idempotencyKey: "memory-demote-semantics-001",
        expectedRevisionId: demotedFixture.revisionId,
        approvalId: "approval_demote_semantics",
      }),
      memory_id: demotedFixture.memoryId,
    };
    demotedFixture.approvals.approve(demote);
    expect(await demotedFixture.runtime.memoryDemote(demote)).toMatchObject({
      status: "OK",
      data: { outcome: "DEMOTED", lifecycle: "candidate", pinned: false },
    });
    await fixture.storage.close();
    await demotedFixture.storage.close();
  });

  it("keeps delete disabled by default before approval lookup", async () => {
    const fixture = await seeded("control-delete-default");
    const deletion = {
      envelope: mutationEnvelope({
        tool: "memory_delete",
        idempotencyKey: "memory-delete-default-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_delete_default",
      }),
      memory_id: fixture.memoryId,
    };
    const result = await fixture.runtime.memoryDelete(deletion);
    expect(result).toMatchObject({
      status: "FAILED",
      error: { code: "PERMISSION_DENIED" },
    });
    expect(fixture.approvals.verifyCalls).toBe(0);
    await fixture.storage.close();
  });

  it("requires trusted approval after destructive delete is explicitly enabled", async () => {
    const fixture = await seeded("control-delete-enabled");
    const enabledRuntime = runtime(
      fixture.storage,
      fixture.approvals,
      true,
    );
    const deletion = {
      envelope: mutationEnvelope({
        tool: "memory_delete",
        idempotencyKey: "memory-delete-enabled-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_delete_enabled",
      }),
      memory_id: fixture.memoryId,
    };
    expect(await enabledRuntime.memoryDelete(deletion)).toMatchObject({
      status: "FAILED",
      error: { code: "APPROVAL_REQUIRED" },
    });
    fixture.approvals.approve(deletion);
    expect(await enabledRuntime.memoryDelete(deletion)).toMatchObject({
      status: "FAILED",
      error: { code: "INTERNAL_FAILURE" },
    });
    expect(
      (await fixture.storage.health()).counts.approval_consumptions,
    ).toBe(0);
    await fixture.storage.close();
  });

  it("corrects by immutable CAS, consumes approval, and replays before re-verification", async () => {
    const fixture = await seeded("correction-approval");
    const content = {
      storage: "inline",
      text: "Prefer one falsifiable conclusion and its verification evidence.",
      media_type: "text/plain",
    } as const;
    const correction = {
      envelope: mutationEnvelope({
        tool: "memory_correct",
        idempotencyKey: "memory-correct-approved-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_correct_once",
      }),
      memory_id: fixture.memoryId,
      replacement: {
        content,
        content_hash: canonicalSha256(content),
        evidence_ids: ["evidence_storage_1"],
        validity: {
          valid_from: NOW,
          valid_to: null,
          recorded_at: NOW,
        },
        reason: "Replace the earlier preference with a precise correction",
      },
    };
    fixture.approvals.approve(correction);

    const corrected = await fixture.runtime.memoryCorrect(correction);
    expect(corrected).toMatchObject({
      status: "OK",
      data: {
        outcome: "REVISED",
        memory_id: fixture.memoryId,
        replayed: false,
      },
    });
    fixture.approvals.grants.clear();
    const replayed = await fixture.runtime.memoryCorrect(correction);
    expect(replayed).toMatchObject({
      status: "OK",
      receipt_id: corrected.receipt_id,
      data: { replayed: true },
    });
    if (corrected.status === "OK" && replayed.status === "OK") {
      expect(
        (replayed.data as { receipt: unknown }).receipt,
      ).toEqual((corrected.data as { receipt: unknown }).receipt);
    }
    expect(fixture.approvals.verifyCalls).toBe(1);

    const health = await fixture.storage.health();
    expect(health.counts.approval_consumptions).toBe(1);
    await fixture.storage.close();
  });

  it("previews correction without changing epoch, revision, candidate, or approval", async () => {
    const fixture = await seeded("correction-dry-run");
    const content = {
      storage: "inline",
      text: "Preview-only correction.",
      media_type: "text/plain",
    } as const;
    const before = await fixture.storage.health();
    const preview = await fixture.runtime.memoryCorrect({
      envelope: mutationEnvelope({
        tool: "memory_correct",
        idempotencyKey: "memory-correct-dry-run-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: null,
        dryRun: true,
      }),
      memory_id: fixture.memoryId,
      replacement: {
        content,
        content_hash: canonicalSha256(content),
        evidence_ids: ["evidence_storage_1"],
        validity: {
          valid_from: NOW,
          valid_to: null,
          recorded_at: NOW,
        },
        reason: "Preview a correction without applying it",
      },
    });
    const after = await fixture.storage.health();

    expect(preview).toMatchObject({
      status: "OK",
      data: {
        outcome: "DRY_RUN",
        current_revision_id: fixture.revisionId,
        receipt: { warnings: ["DRY_RUN"] },
      },
    });
    expect(after.ledger_epoch).toBe(before.ledger_epoch);
    expect(after.counts.memory_candidates).toBe(
      before.counts.memory_candidates,
    );
    expect(after.counts.memory_revisions).toBe(
      before.counts.memory_revisions,
    );
    expect(after.counts.approval_consumptions).toBe(
      before.counts.approval_consumptions,
    );
    await fixture.storage.close();
  });

  it("returns the same governed result through direct runtime and MCP", async () => {
    const fixture = await seeded("control-mcp-parity");
    const input = {
      envelope: mutationEnvelope({
        tool: "memory_pin",
        idempotencyKey: "memory-pin-mcp-parity-001",
        expectedRevisionId: fixture.revisionId,
        approvalId: "approval_pin_mcp_parity",
      }),
      memory_id: fixture.memoryId,
      pinned: true,
    };
    fixture.approvals.approve(input);
    const direct = await fixture.runtime.memoryPin(input);
    await fixture.storage.close();

    const configPath = join(fixture.dataRoot, "mcp-parity.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        data_root: fixture.dataRoot,
        principal_id: "user_local",
        allowed_scopes: [SCOPE],
        allowed_authorities: ["user_stated"],
        destructive_tools_enabled: false,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "packages/mcp-server/dist/cli.js"),
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "governance-parity-client",
      version: "0.1.0",
    });
    await client.connect(transport);
    const called = await client.callTool({
      name: "memory_pin",
      arguments: input,
    });
    expect(called.structuredContent).toMatchObject({
      status: "OK",
      receipt_id: direct.receipt_id,
      data: {
        outcome: "PINNED",
        memory_id: fixture.memoryId,
        replayed: true,
      },
    });
    if (
      direct.status === "OK" &&
      called.structuredContent !== undefined
    ) {
      const viaMcp = called.structuredContent as {
        data: { receipt: unknown };
      };
      expect(viaMcp.data.receipt).toEqual(
        (direct.data as { receipt: unknown }).receipt,
      );
    }
    await client.close();
  });
});

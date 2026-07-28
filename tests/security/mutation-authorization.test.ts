import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalBindingSchema,
  ApprovalGrantSchema,
  ApprovalRegistryManifestSchema,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
} from "../../packages/contracts/src/index.js";
import {
  ApprovalError,
  LocalManifestApprovalRegistry,
} from "../../packages/mcp-server/src/mutations.js";
import type { z } from "zod";

const cleanupPaths: string[] = [];
const NOW = "2026-07-28T13:00:00.000Z";

function temporaryRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `memo-graph-${prefix}-`)),
  );
  cleanupPaths.push(root);
  return root;
}

function requestBinding(overrides: Partial<{
  approval_id: string;
  principal_id: string;
  tool: "memory_pin" | "memory_revoke";
  request_hash: `sha256:${string}`;
}> = {}): z.output<typeof ApprovalBindingSchema> {
  return ApprovalBindingSchema.parse({
    approval_id: overrides.approval_id ?? "approval_pin_1",
    principal_id: overrides.principal_id ?? "user_local",
    tool: overrides.tool ?? "memory_pin",
    safety_class: "important_mutation" as const,
    scopes: [{ kind: "workspace" as const, id: "workspace_local" }],
    request_hash:
      overrides.request_hash ??
      canonicalSha256({ request: "pin memory_pref" }),
  });
}

function grantFor(
  binding = requestBinding(),
  overrides: Partial<{
    expires_at: string;
    tool: "memory_pin" | "memory_revoke";
    request_hash: `sha256:${string}`;
    scopes: Array<{ kind: "workspace"; id: string }>;
  }> = {},
) {
  const unsigned = {
    schema_version: "1.0.0",
    approval_id: binding.approval_id,
    principal_id: binding.principal_id,
    tool: overrides.tool ?? binding.tool,
    safety_class: "important_mutation",
    scopes: overrides.scopes ?? binding.scopes,
    request_hash: overrides.request_hash ?? binding.request_hash,
    issued_at: "2026-07-28T12:00:00.000Z",
    expires_at: overrides.expires_at ?? "2026-07-28T14:00:00.000Z",
    manifest_hash: `sha256:${"0".repeat(64)}`,
  } as const;
  return ApprovalGrantSchema.parse({
    ...unsigned,
    manifest_hash: canonicalSha256Omitting(unsigned, ["manifest_hash"]),
  });
}

function writeManifest(
  root: string,
  grant = grantFor(),
  mode = 0o600,
): string {
  const path = join(root, "approvals.json");
  const manifest = ApprovalRegistryManifestSchema.parse({
    schema_version: "1.0.0",
    approvals: [grant],
  });
  writeFileSync(path, canonicalJson(manifest), {
    encoding: "utf8",
    mode,
  });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe("trusted local approval manifest", () => {
  it("verifies an exact request-bound grant and detects a later manifest change", async () => {
    const root = temporaryRoot("approval-safe");
    const path = writeManifest(root);
    const registry = new LocalManifestApprovalRegistry({
      manifestPath: path,
      clock: () => NOW,
    });

    const verified = await registry.verify(requestBinding());
    expect(verified.grant.approval_id).toBe("approval_pin_1");
    expect(verified.grant.manifest_hash).toBe(
      canonicalSha256Omitting(verified.grant, ["manifest_hash"]),
    );
    await expect(registry.confirmUnchanged(verified)).resolves.toBeUndefined();

    writeFileSync(
      path,
      canonicalJson({
        schema_version: "1.0.0",
        approvals: [
          verified.grant,
          grantFor(requestBinding({ approval_id: "approval_pin_2" })),
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await expect(registry.confirmUnchanged(verified)).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
  });

  it.each([
    {
      name: "missing",
      binding: requestBinding({ approval_id: "approval_missing" }),
      grant: grantFor(),
      code: "APPROVAL_REQUIRED",
    },
    {
      name: "expired",
      binding: requestBinding(),
      grant: grantFor(requestBinding(), {
        expires_at: "2026-07-28T12:59:59.000Z",
      }),
      code: "APPROVAL_INVALID",
    },
    {
      name: "wrong tool",
      binding: requestBinding(),
      grant: grantFor(requestBinding(), { tool: "memory_revoke" }),
      code: "APPROVAL_INVALID",
    },
    {
      name: "wrong principal",
      binding: requestBinding(),
      grant: grantFor(requestBinding({ principal_id: "other_user" })),
      code: "APPROVAL_INVALID",
    },
    {
      name: "wrong request hash",
      binding: requestBinding(),
      grant: grantFor(requestBinding(), {
        request_hash: canonicalSha256({ request: "something else" }),
      }),
      code: "APPROVAL_INVALID",
    },
    {
      name: "wrong scope",
      binding: requestBinding(),
      grant: grantFor(requestBinding(), {
        scopes: [{ kind: "workspace", id: "another_workspace" }],
      }),
      code: "APPROVAL_INVALID",
    },
  ])("rejects a $name grant", async ({ name, binding, grant, code }) => {
    const root = temporaryRoot(`approval-${name}`);
    const registry = new LocalManifestApprovalRegistry({
      manifestPath: writeManifest(root, grant),
      clock: () => NOW,
    });
    await expect(registry.verify(binding)).rejects.toMatchObject({ code });
  });

  it("rejects a forged grant digest", async () => {
    const root = temporaryRoot("approval-forged");
    const path = join(root, "approvals.json");
    writeFileSync(
      path,
      canonicalJson({
        schema_version: "1.0.0",
        approvals: [
          {
            ...grantFor(),
            manifest_hash: `sha256:${"0".repeat(64)}`,
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const registry = new LocalManifestApprovalRegistry({
      manifestPath: path,
      clock: () => NOW,
    });
    await expect(registry.verify(requestBinding())).rejects.toMatchObject({
      code: "APPROVAL_INVALID",
    });
  });

  it("rejects relative, symlinked, writable, and owner-mismatched manifests", async () => {
    const root = temporaryRoot("approval-unsafe");
    const safe = writeManifest(root);
    expect(
      () =>
        new LocalManifestApprovalRegistry({
          manifestPath: relative(process.cwd(), safe),
          clock: () => NOW,
        }),
    ).toThrow(ApprovalError);

    const link = join(root, "approvals-link.json");
    symlinkSync(safe, link);
    await expect(
      new LocalManifestApprovalRegistry({
        manifestPath: link,
        clock: () => NOW,
      }).verify(requestBinding()),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    chmodSync(safe, 0o620);
    await expect(
      new LocalManifestApprovalRegistry({
        manifestPath: safe,
        clock: () => NOW,
      }).verify(requestBinding()),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    chmodSync(safe, 0o600);

    const owner = statSync(safe).uid;
    await expect(
      new LocalManifestApprovalRegistry({
        manifestPath: safe,
        clock: () => NOW,
        expectedUid: owner + 1,
      }).verify(requestBinding()),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });
});

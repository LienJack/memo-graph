import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PINNED_G6_RELEASE_CONTROL_TRUST,
  RuntimeIdentitySchema,
  canonicalSha256,
} from "../../packages/contracts/src/index.js";
import {
  G6_RUNTIME_INPUTS,
  currentRuntimeIdentity,
  productionRuntimeIdentityProvider,
  runtimeConfigurationDigest,
  type RuntimeInput,
} from "../../apps/operator-cli/src/runtime-identity.js";
import { OperatorConfigSchema } from "../../apps/operator-cli/src/config.js";
import { buildG6RuntimeIdentity } from "../../scripts/build-g6-runtime-identity.mjs";

const cleanup: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "memo-g6-runtime-")),
  );
  cleanup.push(root);
  return root;
}

function expectedIdentity() {
  const base = {
    schema_version: "1.0.0" as const,
    tested_implementation_digest: canonicalSha256("expected implementation"),
    tested_envelope_digest: canonicalSha256("tested envelope"),
    dependency_lock_digest: canonicalSha256("expected lock"),
    migration_set_digest: canonicalSha256("expected migrations"),
    platform: {
      node: "24.18.0",
      os: "darwin",
      architecture: "arm64",
      sqlite: "3.50.4",
      filesystem: "apfs",
    },
    configuration_digest: canonicalSha256("expected configuration"),
    decision_authority_hash: canonicalSha256(
      PINNED_G6_RELEASE_CONTROL_TRUST,
    ),
  };
  return RuntimeIdentitySchema.parse({
    ...base,
    runtime_identity_hash: canonicalSha256(base),
  });
}

const TEST_INPUTS = [
  {
    path: "apps",
    kind: "tree",
    suffixes: [".js"],
    excluded_segments: ["node_modules"],
  },
  {
    path: "migrations",
    kind: "tree",
    suffixes: [".sql"],
    excluded_segments: [],
  },
  { path: "pnpm-lock.yaml", kind: "file" },
] as const satisfies readonly RuntimeInput[];

afterEach(() => {
  while (cleanup.length > 0) {
    const root = cleanup.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("G6 production runtime identity", () => {
  it("recomputes the current executable, migration, and lock digests", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "apps", "operator", "dist"), {
      recursive: true,
    });
    mkdirSync(join(root, "migrations"));
    const executable = join(root, "apps", "operator", "dist", "cli.js");
    writeFileSync(executable, "export const runtime = 1;\n");
    writeFileSync(join(root, "migrations", "0001.sql"), "SELECT 1;\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const first = currentRuntimeIdentity({
      schemaVersion: expectedIdentity().schema_version,
      configurationDigest: expectedIdentity().configuration_digest,
      releaseRoot: root,
      inputs: TEST_INPUTS,
    });
    writeFileSync(executable, "export const runtime = 2;\n");
    const changed = currentRuntimeIdentity({
      schemaVersion: expectedIdentity().schema_version,
      configurationDigest: expectedIdentity().configuration_digest,
      releaseRoot: root,
      inputs: TEST_INPUTS,
    });

    expect(changed.tested_implementation_digest).not.toBe(
      first.tested_implementation_digest,
    );
    expect(changed.runtime_identity_hash).not.toBe(
      first.runtime_identity_hash,
    );
  });

  it("fails closed on a symlinked runtime input", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "apps"));
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "outside.js"), "export const hidden = true;\n");
    symlinkSync(join(root, "outside.js"), join(root, "apps", "cli.js"));
    writeFileSync(join(root, "migrations", "0001.sql"), "SELECT 1;\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(() =>
      currentRuntimeIdentity({
        schemaVersion: expectedIdentity().schema_version,
        configurationDigest: expectedIdentity().configuration_digest,
        releaseRoot: root,
        inputs: TEST_INPUTS,
      }),
    ).toThrow();
  });

  it("prunes excluded dependency symlinks before traversing them", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "apps"));
    mkdirSync(join(root, "migrations"));
    const outside = temporaryRoot();
    writeFileSync(join(outside, "dependency.js"), "export const dep = 1;\n");
    symlinkSync(outside, join(root, "apps", "node_modules"));
    writeFileSync(join(root, "apps", "cli.js"), "export const cli = 1;\n");
    writeFileSync(join(root, "migrations", "0001.sql"), "SELECT 1;\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(() =>
      currentRuntimeIdentity({
        schemaVersion: expectedIdentity().schema_version,
        configurationDigest: expectedIdentity().configuration_digest,
        releaseRoot: root,
        inputs: TEST_INPUTS,
      }),
    ).not.toThrow();
  });

  it("changes the measured envelope when live operator configuration drifts", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "apps"));
    mkdirSync(join(root, "migrations"));
    writeFileSync(join(root, "apps", "cli.js"), "export const cli = 1;\n");
    writeFileSync(join(root, "migrations", "0001.sql"), "SELECT 1;\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const expected = expectedIdentity();
    const firstConfig = OperatorConfigSchema.parse({
      data_root: join(root, "data-a"),
      principal_id: "principal:runtime-a",
    });
    const first = currentRuntimeIdentity({
      schemaVersion: expected.schema_version,
      configurationDigest: runtimeConfigurationDigest(firstConfig),
      releaseRoot: root,
      inputs: TEST_INPUTS,
    });
    const driftedConfig = OperatorConfigSchema.parse({
      data_root: join(root, "data-b"),
      principal_id: "principal:runtime-b",
    });
    const drifted = currentRuntimeIdentity({
      schemaVersion: first.schema_version,
      configurationDigest: runtimeConfigurationDigest(driftedConfig),
      releaseRoot: root,
      inputs: TEST_INPUTS,
    });

    expect(drifted.configuration_digest).not.toBe(
      first.configuration_digest,
    );
    expect(drifted.tested_envelope_digest).not.toBe(
      first.tested_envelope_digest,
    );
    expect(drifted.runtime_identity_hash).not.toBe(
      first.runtime_identity_hash,
    );
  });

  it("matches the canonical evidence builder and production provider", async () => {
    const config = OperatorConfigSchema.parse(
      JSON.parse(
        readFileSync("fixtures/g6/operator-config.json", "utf8"),
      ) as unknown,
    );
    const evidenceIdentity = buildG6RuntimeIdentity({
      operatorConfig: config,
    });
    const productionIdentity = await productionRuntimeIdentityProvider(
      evidenceIdentity,
      config,
    ).current();

    expect(productionIdentity).toEqual(evidenceIdentity);
  });

  it("keeps dist output and the native publish helper in the fixed policy", () => {
    const apps = G6_RUNTIME_INPUTS.find(
      (entry) => entry.path === "apps" && entry.kind === "tree",
    );
    expect(apps).toMatchObject({
      suffixes: expect.arrayContaining([".js", ".node"]),
      excluded_segments: ["node_modules"],
    });
    expect(G6_RUNTIME_INPUTS).toContainEqual({
      path: "tools/rename-noreplace/rename-noreplace",
      kind: "file",
    });
    const fixture = JSON.parse(
      readFileSync("fixtures/g6/runtime-inputs.json", "utf8"),
    ) as { paths: unknown };
    expect(fixture.paths).toEqual(G6_RUNTIME_INPUTS);
  });
});

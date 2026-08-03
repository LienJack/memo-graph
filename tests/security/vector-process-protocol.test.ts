import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  VECTOR_PROCESS_TRUST_BOUNDARY,
  VectorChildRuntimeIdentitySchema,
  VectorIpcRequestSchema,
  createVectorChildEnvironment,
  parseBoundedVectorIpcRequest,
  prepareVectorPaths,
  vectorGenerationLayout,
} from "../../packages/vector-retrieval/src/index.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("vector child protocol security", () => {
  it("imports the built package when every optional dependency is blocked", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--experimental-loader",
          new URL(
            "../fixtures/block-vector-loader.mjs",
            import.meta.url,
          ).pathname,
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(
            new URL(
              "../../packages/vector-retrieval/dist/index.js",
              import.meta.url,
            ).href,
          )});`,
        ],
        {
          env: {
            PATH: process.env.PATH,
          },
        },
      ),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("accepts only closed operations and rejects caller-controlled execution", () => {
    expect(
      VectorIpcRequestSchema.safeParse({
        protocol_version: "1.0.0",
        kind: "request",
        request_id: "request_1",
        operation: "health",
        payload: null,
      }).success,
    ).toBe(true);
    for (const adversarial of [
      { operation: "execute", payload: { sql: "DROP TABLE vectors" } },
      {
        operation: "initialize",
        payload: { model_url: "https://example.invalid/model" },
      },
      { operation: "open", payload: { database_path: "/tmp/evil.db" } },
    ]) {
      expect(
        VectorIpcRequestSchema.safeParse({
          protocol_version: "1.0.0",
          kind: "request",
          request_id: "request_bad",
          ...adversarial,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects every drift in the qualified child runtime identity", () => {
    const identity = {
      node_version: "v24.18.0",
      platform: "darwin",
      architecture: "arm64",
      runtime_package: "@huggingface/transformers",
      runtime_version: "4.2.0",
      sqlite_binding: "better-sqlite3",
      sqlite_binding_version: "13.0.1",
      index_package: "sqlite-vec",
      index_package_version: "0.1.9",
      index_extension_version: "v0.1.9",
    } as const;
    expect(VectorChildRuntimeIdentitySchema.safeParse(identity).success)
      .toBe(true);
    for (const mismatch of [
      { ...identity, node_version: "v24.18.1" },
      { ...identity, platform: "linux" },
      { ...identity, architecture: "x64" },
      { ...identity, runtime_version: "4.2.1" },
      { ...identity, sqlite_binding_version: "13.0.2" },
      { ...identity, index_package_version: "0.2.0" },
      { ...identity, index_extension_version: "v0.2.0" },
    ]) {
      expect(
        VectorChildRuntimeIdentitySchema.safeParse(mismatch).success,
      ).toBe(false);
    }
  });

  it("rejects malformed, oversized, and unknown-version messages", () => {
    expect(() =>
      parseBoundedVectorIpcRequest("{not-json", 1_024)
    ).toThrow(/malformed/u);
    expect(() =>
      parseBoundedVectorIpcRequest(
        {
          protocol_version: "1.0.0",
          kind: "request",
          request_id: "request_oversized",
          operation: "health",
          payload: null,
          padding: "x".repeat(2_000),
        },
        1_024,
      )
    ).toThrow(/size limit/u);
    expect(() =>
      parseBoundedVectorIpcRequest({
        protocol_version: "2.0.0",
        kind: "request",
        request_id: "request_unknown",
        operation: "health",
        payload: null,
      })
    ).toThrow();
  });

  it("derives confined paths and rejects symlink substitution", async () => {
    const dataRoot = await tempRoot("memo-graph-vector-data-");
    const modelRoot = await tempRoot("memo-graph-vector-model-");
    const layout = await prepareVectorPaths({
      dataRoot,
      modelRoot,
      principalId: "principal_local",
      scope: { kind: "workspace", id: "workspace_local" },
    });
    expect(layout.databasePath.startsWith(`${layout.dataRoot}/`)).toBe(true);
    expect(layout.modelRoot).toBe(await realpath(modelRoot));

    const outside = await tempRoot("memo-graph-vector-outside-");
    const linked = join(dataRoot, "linked");
    await symlink(outside, linked);
    await expect(
      prepareVectorPaths({
        dataRoot: linked,
        modelRoot,
        principalId: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).rejects.toThrow(/symbolic link/u);

    const secondRoot = await tempRoot("memo-graph-vector-second-");
    await mkdir(join(secondRoot, "derived"), { recursive: true });
    await symlink(outside, join(secondRoot, "derived", "vector"));
    await expect(
      prepareVectorPaths({
        dataRoot: secondRoot,
        modelRoot,
        principalId: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
      }),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("derives generation paths only from hashed scope and epoch identity", async () => {
    const dataRoot = await tempRoot(
      "memo-graph-vector-generation-data-",
    );
    const layout = await vectorGenerationLayout({
      dataRoot,
      principalId: "principal_local",
      scope: { kind: "workspace", id: "workspace_local" },
      epochId: `sha256:${"a".repeat(64)}`,
      generationId: "generation_local_1",
    });
    expect(layout.activeRoot.startsWith(`${layout.vectorRoot}/`))
      .toBe(true);
    expect(layout.activeRoot).not.toContain("principal_local");
    expect(layout.activeRoot).not.toContain("workspace_local");
    expect(layout.activeRoot).not.toContain("generation_local_1");

    const outside = await tempRoot(
      "memo-graph-vector-generation-outside-",
    );
    const linked = join(dataRoot, "linked-generation-root");
    await symlink(outside, linked);
    await expect(
      vectorGenerationLayout({
        dataRoot: linked,
        principalId: "principal_local",
        scope: { kind: "workspace", id: "workspace_local" },
        epochId: `sha256:${"a".repeat(64)}`,
        generationId: "generation_local_1",
      }),
    ).rejects.toMatchObject({
      category: "PROTOCOL_INVALID",
    });
  });

  it("constructs a minimal environment without inherited secrets", async () => {
    const dataRoot = await tempRoot("memo-graph-vector-env-");
    const environment = await createVectorChildEnvironment({
      dataRoot,
      source: {
        PATH: "/secret/toolchain",
        HOME: "/secret/home",
        NODE_OPTIONS: "--require /secret/hook.js",
        AWS_ACCESS_KEY_ID: "secret",
        LANG: "en_US.UTF-8",
        TZ: "Asia/Shanghai",
      },
    });
    expect(environment.PATH).not.toContain("/secret");
    expect(environment.HOME).toContain(dataRoot);
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(environment).toMatchObject({
      LANG: "en_US.UTF-8",
      TZ: "Asia/Shanghai",
    });
  });

  it("states crash containment without claiming an OS sandbox", () => {
    expect(VECTOR_PROCESS_TRUST_BOUNDARY).toContain(
      "availability and crash containment",
    );
    expect(VECTOR_PROCESS_TRUST_BOUNDARY).toContain("not an OS sandbox");
    expect(VECTOR_PROCESS_TRUST_BOUNDARY).toContain(
      "trusted native dependencies",
    );
  });
});

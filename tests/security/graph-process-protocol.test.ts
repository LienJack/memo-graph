import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GraphIpcRequestSchema,
  GRAPH_PROCESS_TRUST_BOUNDARY,
  createGraphChildEnvironment,
  parseBoundedGraphIpcRequest,
  prepareGraphDatabasePath,
} from "../../packages/graph-projection/src/index.js";
import {
  buildGraphScopeSnapshot,
} from "../../packages/contracts/src/index.js";
import {
  HASH_A,
  HASH_B,
  LATER,
  NOW,
  USER_SCOPE,
} from "../helpers/examples.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memo-graph-u2-"));
  roots.push(root);
  return root;
}

function snapshot() {
  return buildGraphScopeSnapshot({
    schema_version: "1.0.0",
    backend: "ladybugdb",
    principal_id: "user_local",
    scope: USER_SCOPE,
    frontier: {
      schema_version: "1.0.0",
      ledger_epoch: 1,
      tombstone_epoch: 0,
      projection_epoch: 1,
      transform: { name: "graph-test", version: "1.0.0" },
      source_frontier_hash: HASH_A,
      projection_frontier_hash: HASH_B,
    },
    nodes: [
      {
        schema_version: "1.0.0",
        graph_node_id: "graph_node_1",
        revision_id: "revision_1",
        projection_revision_id: "projection_revision_1",
        principal_id: "user_local",
        scope: USER_SCOPE,
        abstraction: "l2_topic",
        projection_type: "topic",
        lifecycle: "active",
        validity: {
          valid_from: NOW,
          valid_to: LATER,
          recorded_at: NOW,
        },
        ledger_epoch: 1,
        tombstone_epoch: 0,
        projection_epoch: 1,
        content_hash: HASH_A,
        payload_hash: HASH_B,
        transform: { name: "graph-test", version: "1.0.0" },
        evidence_ids: ["evidence_1"],
        lineage_revision_ids: ["revision_source_1"],
      },
    ],
    edges: [],
  });
}

describe("graph child protocol security", () => {
  it("imports the built package when the optional native module is blocked", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--experimental-loader",
          new URL(
            "../fixtures/block-ladybug-loader.mjs",
            import.meta.url,
          ).pathname,
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(
            new URL(
              "../../packages/graph-projection/dist/index.js",
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

  it("accepts closed operations and rejects raw Cypher or unknown protocol", () => {
    expect(
      GraphIpcRequestSchema.safeParse({
        protocol_version: "1.0.0",
        kind: "request",
        request_id: "request_1",
        operation: "replace_scope",
        payload: snapshot(),
      }).success,
    ).toBe(true);
    expect(
      GraphIpcRequestSchema.safeParse({
        protocol_version: "1.0.0",
        kind: "request",
        request_id: "request_2",
        operation: "query_paths",
        payload: {
          cypher: "MATCH (n) RETURN n",
        },
      }).success,
    ).toBe(false);
    expect(
      GraphIpcRequestSchema.safeParse({
        protocol_version: "2.0.0",
        kind: "request",
        request_id: "request_3",
        operation: "execute",
        payload: null,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and oversized messages before dispatch", () => {
    expect(() =>
      parseBoundedGraphIpcRequest("{not-json", 1_024)
    ).toThrow();
    expect(() =>
      parseBoundedGraphIpcRequest({
        protocol_version: "1.0.0",
        kind: "request",
        request_id: "request_oversized",
        operation: "health",
        payload: null,
        padding: "x".repeat(2_000),
      }, 1_024)
    ).toThrow(/size limit/u);
  });

  it("confines the fixed database path and rejects symlink substitution", async () => {
    const root = await tempRoot();
    const layout = await prepareGraphDatabasePath(root);
    expect(layout.databasePath.startsWith(`${layout.dataRoot}/`)).toBe(true);

    const outside = await tempRoot();
    const linkedRoot = join(root, "linked-root");
    await symlink(outside, linkedRoot);
    await expect(prepareGraphDatabasePath(linkedRoot)).rejects.toThrow(
      /symbolic link/u,
    );

    const secondRoot = await tempRoot();
    await mkdir(join(secondRoot, "derived"), { recursive: true });
    await symlink(outside, join(secondRoot, "derived", "graph"));
    await expect(prepareGraphDatabasePath(secondRoot)).rejects.toThrow(
      /symbolic link/u,
    );
  });

  it("constructs a minimal environment without inherited secrets or paths", async () => {
    const root = await tempRoot();
    const environment = await createGraphChildEnvironment({
      dataRoot: root,
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
    expect(environment.HOME).toContain(root);
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(environment).toMatchObject({
      LANG: "en_US.UTF-8",
      TZ: "Asia/Shanghai",
    });
  });

  it("states the actual containment boundary without claiming a sandbox", () => {
    expect(GRAPH_PROCESS_TRUST_BOUNDARY).toContain(
      "availability and crash containment",
    );
    expect(GRAPH_PROCESS_TRUST_BOUNDARY).toContain("not an OS sandbox");
    expect(GRAPH_PROCESS_TRUST_BOUNDARY).toContain(
      "trusted native dependency",
    );
  });

  it("keeps native loading child-only and bans synchronous graph queries", async () => {
    const [adapterSource, packageSource] = await Promise.all([
      readFile(
        new URL(
          "../../packages/graph-projection/src/ladybug-adapter.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../packages/graph-projection/src/index.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(adapterSource).toContain(
      "await import(LADYBUG_MODULE_NAME)",
    );
    expect(adapterSource).not.toContain("querySync");
    expect(packageSource).not.toContain("ladybug-adapter");
  });

  it("resets the native timeout before every non-query operation", async () => {
    const adapterSource = await readFile(
      new URL(
        "../../packages/graph-projection/src/ladybug-adapter.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(
      adapterSource.match(
        /this\.#connection\.setQueryTimeout\(this\.#operationTimeoutMs\)/gu,
      ),
    ).toHaveLength(4);
  });
});

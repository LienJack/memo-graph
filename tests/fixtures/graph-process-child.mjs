import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout } from "node:timers";

const config = JSON.parse(
  Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"),
);
const snapshotsPath = `${config.database_path}.fake-snapshots.json`;
const pendingPath = `${snapshotsPath}.pending`;

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function snapshots() {
  return existsSync(snapshotsPath)
    ? JSON.parse(readFileSync(snapshotsPath, "utf8"))
    : {};
}

function scopeKey(value) {
  return `${value.principal_id}:${value.scope.kind}:${value.scope.id}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(",")}}`;
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

send({
  protocol_version: "1.0.0",
  kind: "ready",
  identity:
    config.test_identity_override ?? config.expected_identity,
  database_path_hash: config.database_path_hash,
});

process.on("message", (request) => {
  if (request?.kind !== "request") {
    return;
  }
  const respond = (payload) =>
    send({
      protocol_version: "1.0.0",
      kind: "response",
      request_id: request.request_id,
      operation: request.operation,
      ok: true,
      payload,
    });

  if (request.operation === "health") {
    respond({
      schema_version: "1.0.0",
      status: "ready",
      backend_identity:
        config.test_identity_override ?? config.expected_identity,
      process_generation: config.process_generation,
      restart_count: config.restart_count,
      queue_depth: 0,
      active_requests: 0,
      database_path_hash: config.database_path_hash,
      circuit_open_until: null,
      last_failure: null,
    });
    return;
  }
  if (request.operation === "initialize") {
    respond(null);
    return;
  }
  if (request.operation === "replace_scope") {
    const snapshot = request.payload;
    const current = snapshots();
    current[scopeKey(snapshot)] = snapshot;
    writeFileSync(pendingPath, JSON.stringify(current));
    if (
      snapshot.nodes.some(
        (node) => node.graph_node_id === "graph_node_crash_write",
      )
    ) {
      process.exit(92);
    }
    renameSync(pendingPath, snapshotsPath);
    respond(snapshot);
    return;
  }
  if (request.operation === "delete_scope") {
    const current = snapshots();
    delete current[scopeKey(request.payload)];
    writeFileSync(pendingPath, JSON.stringify(current));
    renameSync(pendingPath, snapshotsPath);
    respond(null);
    return;
  }
  if (request.operation === "read_scope_snapshot") {
    respond(snapshots()[scopeKey(request.payload)] ?? null);
    return;
  }
  if (request.operation === "query_paths") {
    const query = request.payload;
    const result = {
      schema_version: "1.0.0",
      query_id: query.query_id,
      status: "complete",
      query_hash: canonicalHash(query),
      frontier: query.frontier,
      paths: [],
      elapsed_ms: 1,
      complete: true,
      reason_codes: [],
      process_outcome: "completed",
    };
    if (query.query_id.includes("timeout")) {
      return;
    }
    if (query.query_id.includes("late")) {
      setTimeout(() => respond(result), 125);
      return;
    }
    if (query.query_id.includes("crash")) {
      process.exit(93);
    }
    if (query.query_id.includes("malformed")) {
      send({
        protocol_version: "999.0.0",
        kind: "unknown",
        request_id: request.request_id,
      });
      return;
    }
    if (query.query_id.includes("oversized")) {
      send({
        protocol_version: "1.0.0",
        kind: "response",
        request_id: request.request_id,
        operation: request.operation,
        ok: true,
        payload: "x".repeat(config.max_ipc_bytes + 1),
      });
      return;
    }
    respond(result);
    if (query.query_id.includes("duplicate")) {
      setTimeout(() => respond(result), 5);
    }
    return;
  }
  if (request.operation === "close") {
    respond(null);
    setTimeout(() => process.exit(0), 0);
  }
});

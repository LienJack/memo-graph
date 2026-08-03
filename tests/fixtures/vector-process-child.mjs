import process from "node:process";
import { Buffer } from "node:buffer";

const config = JSON.parse(
  Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"),
);
let snapshot = null;
let closing = false;
const seen = new Set();

function send(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

async function closeAndExit(code) {
  if (closing) {
    process.exit(code);
  }
  closing = true;
  process.exit(code);
}

function success(request, payload) {
  send({
    protocol_version: "1.0.0",
    kind: "response",
    request_id: request.request_id,
    operation: request.operation,
    ok: true,
    payload,
  });
}

async function handle(request) {
  if (
    request?.protocol_version !== "1.0.0" ||
    request?.kind !== "request" ||
    typeof request?.request_id !== "string" ||
    seen.has(request.request_id)
  ) {
    return closeAndExit(64);
  }
  seen.add(request.request_id);
  switch (request.operation) {
    case "health":
      success(request, {
        schema_version: "1.0.0",
        status: "ready",
        embedding_epoch_id: config.expected_epoch.epoch_id,
        process_id: process.pid,
        restart_count: config.restart_count,
        failure_category: null,
        reason: null,
      });
      return;
    case "initialize":
      success(request, null);
      return;
    case "replace_scope":
      snapshot = request.payload;
      success(request, snapshot);
      return;
    case "delete_scope":
      snapshot = null;
      success(request, null);
      return;
    case "read_scope_snapshot":
      success(request, snapshot);
      return;
    case "query":
      if (request.payload?.query === "__test_hang__") {
        await new Promise(() => undefined);
        return;
      }
      success(request, {
        schema_version: "1.0.0",
        request_id: request.payload.request_id,
        status:
          snapshot?.records?.length > 0 ? "complete" : "no_match",
        embedding_epoch_id:
          request.payload.embedding_epoch_id,
        generation_id: request.payload.generation_id,
        source_frontier_hash:
          request.payload.source_frontier_hash,
        hits:
          snapshot?.records?.length > 0
            ? [
                {
                  revision_id: snapshot.records[0].revision_id,
                  source_content_hash:
                    snapshot.records[0].source_content_hash,
                  distance: 0,
                  rank: 1,
                },
              ]
            : [],
        complete: true,
        reason_codes: [],
      });
      return;
    case "close":
      success(request, null);
      return closeAndExit(0);
    default:
      return closeAndExit(65);
  }
}

send({
  protocol_version: "1.0.0",
  kind: "ready",
  epoch: config.expected_epoch,
  runtime: {
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
  },
  database_path_hash: config.database_path_hash,
});

let chain = Promise.resolve();
process.on("message", (message) => {
  chain = chain.then(() => handle(message));
  void chain.catch(() => closeAndExit(66));
});
process.once("disconnect", () => {
  void closeAndExit(0);
});

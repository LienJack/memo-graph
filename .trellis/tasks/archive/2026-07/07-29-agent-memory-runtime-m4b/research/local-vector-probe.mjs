import { createHash } from "node:crypto";
import {
  readFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { env, pipeline } from "@huggingface/transformers";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const MODEL_ID = "Xenova/multilingual-e5-small";
const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const MODEL_DTYPE = "int8";
const MODEL_DIMENSIONS = 384;
const MODEL_SHA256 =
  "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c";
const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 100;

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) {
    throw new Error(`missing ${name}`);
  }
  return resolve(process.argv[index + 1]);
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined
    ? null
    : resolve(process.argv[index + 1]);
}

function quantile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rows(tensor) {
  const [count, dimensions] = tensor.dims;
  if (dimensions !== MODEL_DIMENSIONS) {
    throw new Error(`unexpected dimensions: ${tensor.dims.join("x")}`);
  }
  return Array.from({ length: count }, (_, index) =>
    new Float32Array(
      tensor.data.slice(
        index * MODEL_DIMENSIONS,
        (index + 1) * MODEL_DIMENSIONS,
      ),
    )
  );
}

function norm(vector) {
  return Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
}

function eligible(revision, declaration) {
  return revision.principal_id === declaration.scope.principal_id &&
    revision.scope.kind === declaration.scope.kind &&
    revision.scope.id === declaration.scope.id &&
    revision.lifecycle === "active" &&
    revision.valid_from <= declaration.as_of &&
    (revision.valid_to === null || revision.valid_to > declaration.as_of);
}

const cacheDir = argument("--cache");
const databasePath = argument("--database");
const fixturePath = argument("--fixture");
const localModelRoot = optionalArgument("--local-model-root");
const allowRemoteModels = process.argv.includes("--allow-remote");
const declaration = JSON.parse(readFileSync(fixturePath, "utf8"));
const calibration = declaration.cases.filter(
  (item) => item.partition === "calibration",
);
const exactScopeRevisions = [
  ...new Map(
    calibration
      .flatMap((item) => item.candidate_revisions)
      .filter((revision) => eligible(revision, declaration))
      .map((revision) => [revision.revision_id, revision]),
  ).values(),
];

env.cacheDir = cacheDir;
env.allowRemoteModels = allowRemoteModels;
env.allowLocalModels = true;
if (localModelRoot !== null) {
  env.localModelPath = localModelRoot;
}

const rssBefore = process.memoryUsage().rss;
const loadStarted = performance.now();
const extractor = await pipeline("feature-extraction", MODEL_ID, {
  revision: MODEL_REVISION,
  dtype: MODEL_DTYPE,
  device: "cpu",
});
const loadMs = performance.now() - loadStarted;
const rssAfterLoad = process.memoryUsage().rss;

const passageStarted = performance.now();
const passageTensor = await extractor(
  exactScopeRevisions.map((revision) => `passage: ${revision.content}`),
  { pooling: "mean", normalize: true },
);
const passageMs = performance.now() - passageStarted;
const passageVectors = rows(passageTensor);

const database = new Database(databasePath);
sqliteVec.load(database);
const extensionVersion = database.prepare(
  "SELECT vec_version() AS version",
).get().version;
database.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vector_probe USING vec0(
    revision_id TEXT PRIMARY KEY,
    embedding FLOAT[384] distance_metric=cosine
  );
  DELETE FROM vector_probe;
`);
const insert = database.prepare(
  "INSERT INTO vector_probe(revision_id, embedding) VALUES (?, ?)",
);
database.transaction(() => {
  exactScopeRevisions.forEach((revision, index) => {
    insert.run(revision.revision_id, passageVectors[index]);
  });
})();
const search = database.prepare(`
  SELECT revision_id, distance
  FROM vector_probe
  WHERE embedding MATCH ? AND k = ?
  ORDER BY distance
`);

async function queryVector(query) {
  const output = await extractor(`query: ${query}`, {
    pooling: "mean",
    normalize: true,
  });
  return rows(output)[0];
}

const caseResults = [];
for (const item of calibration) {
  const vector = await queryVector(item.query);
  const matches = search.all(vector, Math.min(5, exactScopeRevisions.length));
  const returnedIds = matches.map((match) => match.revision_id);
  caseResults.push({
    case_id: item.case_id,
    case_role: item.case_role,
    expected_revision_ids: item.expected_revision_ids,
    returned_revision_ids: returnedIds,
    expected_in_top_5: item.expected_revision_ids.every((revisionId) =>
      returnedIds.includes(revisionId)
    ),
    matches,
  });
}

const benchmarkQuery = calibration[0].query;
for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
  const vector = await queryVector(benchmarkQuery);
  search.all(vector, Math.min(5, exactScopeRevisions.length));
}
const samples = [];
for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
  const started = performance.now();
  const vector = await queryVector(benchmarkQuery);
  search.all(vector, Math.min(5, exactScopeRevisions.length));
  samples.push(performance.now() - started);
}

const deletedId = exactScopeRevisions[0].revision_id;
database.prepare("DELETE FROM vector_probe WHERE revision_id = ?").run(
  deletedId,
);
const deletedQuery = await queryVector(calibration[0].query);
const deleteResults = search.all(
  deletedQuery,
  Math.min(5, exactScopeRevisions.length),
);
if (deleteResults.some((item) => item.revision_id === deletedId)) {
  throw new Error("deleted revision remained searchable");
}
insert.run(deletedId, passageVectors[0]);
const beforeReopen = search.all(
  deletedQuery,
  Math.min(5, exactScopeRevisions.length),
);
database.close();

const reopened = new Database(databasePath);
sqliteVec.load(reopened);
const reopenedResults = reopened.prepare(`
  SELECT revision_id, distance
  FROM vector_probe
  WHERE embedding MATCH ? AND k = ?
  ORDER BY distance
`).all(deletedQuery, Math.min(5, exactScopeRevisions.length));
reopened.close();
if (JSON.stringify(beforeReopen) !== JSON.stringify(reopenedResults)) {
  throw new Error("reopen changed logical vector results");
}

const modelPath = localModelRoot === null
  ? resolve(
    cacheDir,
    MODEL_ID,
    MODEL_REVISION,
    "onnx",
    "model_int8.onnx",
  )
  : resolve(
    localModelRoot,
    MODEL_ID,
    "onnx",
    "model_int8.onnx",
  );
const observedModelSha256 = sha256(modelPath);
if (observedModelSha256 !== MODEL_SHA256) {
  throw new Error(
    `model digest mismatch: expected ${MODEL_SHA256}, observed ${observedModelSha256}`,
  );
}

const norms = passageVectors.map(norm);
const report = {
  schema_version: "1.0.0",
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  mode: allowRemoteModels ? "cache_fill" : "offline",
  candidate: {
    runtime_package: "@huggingface/transformers",
    runtime_version: "4.2.0",
    runtime_overrides: {
      "adm-zip": "0.6.0",
      "sharp": "0.35.3",
    },
    model_id: MODEL_ID,
    model_revision: MODEL_REVISION,
    model_dtype: MODEL_DTYPE,
    model_dimensions: MODEL_DIMENSIONS,
    model_sha256: observedModelSha256,
    pooling: "mean",
    normalization: "l2",
    query_prefix: "query: ",
    passage_prefix: "passage: ",
    index_package: "sqlite-vec",
    index_version: "0.1.9",
    extension_version: extensionVersion,
    index_mode: "flat_cosine",
  },
  privacy: {
    allow_remote_models: allowRemoteModels,
    remote_embedding_endpoint: false,
    explicit_local_model_root: localModelRoot !== null,
    exact_scope_prefiltered_revision_count: exactScopeRevisions.length,
  },
  capability: {
    dimensions: passageTensor.dims,
    minimum_norm: Math.min(...norms),
    maximum_norm: Math.max(...norms),
    calibration_cases: caseResults,
    delete_removed_revision: true,
    reopen_logically_equal: true,
  },
  resources: {
    model_bytes: statSync(modelPath).size,
    vector_database_bytes: statSync(databasePath).size,
    load_ms: loadMs,
    passage_batch_ms: passageMs,
    query_and_search_p50_ms: quantile(samples, 0.5),
    query_and_search_p95_ms: quantile(samples, 0.95),
    query_and_search_p99_ms: quantile(samples, 0.99),
    rss_before_bytes: rssBefore,
    rss_after_load_bytes: rssAfterLoad,
    rss_delta_bytes: rssAfterLoad - rssBefore,
    warmup_samples: WARMUP_SAMPLES,
    measured_samples: MEASURED_SAMPLES,
  },
};

console.log(JSON.stringify(report, null, 2));

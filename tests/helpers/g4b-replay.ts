import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ApprovalGrantSchema,
  EpisodeSchema,
  EvidenceRecordSchema,
  G4BFrozenSubsetSchema,
  MemoryCandidateSchema,
  MemoryProposeInputSchema,
  buildVectorEmbeddingEpoch,
  canonicalJson,
  canonicalSha256,
  canonicalSha256Omitting,
  type EvaluationPartition,
  type G4BArm,
  type G4BFrozenCase,
  type G4BFrozenSubset,
  type RecallLane,
  type Scope,
} from "../../packages/contracts/dist/index.js";
import {
  ApprovalError,
  LayeredLaneRetrievers,
  MemoryRuntime,
  type ApprovalBinding,
  type ApprovalRegistry,
  type VerifiedApproval,
} from "../../packages/memory-kernel/dist/index.js";
import {
  SemanticVectorRetriever,
  VectorScopeProjector,
  type SemanticVectorRuntimeFactory,
  type VectorProjectionRuntimeFactory,
} from "../../packages/vector-retrieval/dist/index.js";
import {
  SqliteStorageClient,
} from "../../packages/storage-sqlite/dist/index.js";

export const G4B_MANIFEST_PATH = resolve(
  "fixtures/g4b/manifest.json",
);
export const G4B_MANIFEST_HASH =
  "sha256:449981ac83b2bc415c60df5237d6c857777e2dda6c03b1778588aa052c6ae3d4";

const HASH = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

export const G4B_VECTOR_EPOCH = buildVectorEmbeddingEpoch({
  schema_version: "1.0.0",
  runtime: {
    package_name: "@huggingface/transformers",
    package_version: "4.2.0",
  },
  sqlite_binding: {
    package_name: "better-sqlite3",
    package_version: "13.0.1",
  },
  model: {
    repository: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    files: [
      {
        path: "config.json",
        sha256:
          "sha256:cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
      },
      {
        path: "onnx/model_int8.onnx",
        sha256:
          "sha256:4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
      },
      {
        path: "tokenizer.json",
        sha256:
          "sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      },
      {
        path: "tokenizer_config.json",
        sha256:
          "sha256:a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
      },
    ],
    onnx_artifact: "onnx/model_int8.onnx",
    dimensions: 384,
    dtype: "int8",
    pooling: "mean",
    normalization: "l2",
    query_prefix: "query: ",
    passage_prefix: "passage: ",
    max_tokens: 512,
  },
  index: {
    package_name: "sqlite-vec",
    package_version: "0.1.9",
    algorithm: "flat",
    metric: "cosine",
  },
  projection_schema_version: "1.0.0",
  dependency_lock_hash:
    "sha256:87f5c3f5dde4b8f29758d83866e2afb7d4fd2ae5748e30d3aeed96738faaf585",
});

export type G4BCalibrationConfiguration = {
  schema_version: "1.0.0";
  vector_top_k: 5;
  similarity_threshold: null;
  fusion: "governed_context_rank_v1";
  max_candidates_per_lane: 5;
};

export type G4BCalibrationReceipt = {
  schema_version: "1.0.0";
  manifest_hash: string;
  calibration_case_hashes: string[];
  configuration: G4BCalibrationConfiguration;
  configuration_hash: string;
  tuner_payload_hash: string;
  sealed_hash: string;
};

export type G4BObservation = {
  arm: G4BArm;
  token_budget: number;
  status: string;
  included_revision_ids: string[];
  evidence_revision_ids: string[];
  selection_revision_ids: string[];
  token_used: number;
  duplicate_count: number;
  contradiction_count: number;
  canonical_eligibility: Record<string, string>;
  common_identity: {
    manifest_hash: string;
    case_hash: string;
    canonical_setup_hash: string;
    principal_id: string;
    scope: Scope;
    as_of: string;
    include_sensitive: false;
    token_budget: number;
    reader_hash: string;
    filter_hash: string;
    compiler_hash: string;
    oracle_hash: string;
    calibration_hash: string;
  };
  arm_configuration_hash: string;
  context_hash: string | null;
  receipt_hash: string | null;
};

export type G4BCaseRun = {
  case_id: string;
  partition: EvaluationPartition;
  case_role: G4BFrozenCase["case_role"];
  family: G4BFrozenCase["family"];
  case_hash: string;
  token_budget: number;
  observations: Record<G4BArm, G4BObservation>;
  scores: Record<G4BArm, ReturnType<typeof scoreObservation>>;
};

export type G4BRuntimeFactoryBundle = {
  projection?: VectorProjectionRuntimeFactory;
  query?: SemanticVectorRuntimeFactory;
};

export type G4BReplayOptions = {
  data_root: string;
  model_root: string;
  implementation_commit: string;
  dependency_lock_hash: string;
  receipt: G4BCalibrationReceipt;
  runtime_factory?: (
    frozenCase: G4BFrozenCase,
  ) => G4BRuntimeFactoryBundle;
  retain_case_roots?: boolean;
  recorded_at?: string;
};

export type G4BResourceHarness = {
  manifest: G4BFrozenSubset;
  frozen_case: G4BFrozenCase;
  storage: SqliteStorageClient;
  retriever: SemanticVectorRetriever;
  fallback_retriever: SemanticVectorRetriever;
  recall(input: {
    sample_id: string;
    query?: string;
  }): ReturnType<SemanticVectorRetriever["retrieve"]>;
  fallback(input: {
    sample_id: string;
  }): ReturnType<SemanticVectorRetriever["retrieve"]>;
  compile(input: {
    sample_id: string;
  }): ReturnType<MemoryRuntime["memoryContextCompile"]>;
  close(): Promise<void>;
};

type CanonicalMapping = {
  declared_revision_id: string;
  memory_id: string;
  revision_id: string;
  evidence_id: string;
  lifecycle: G4BFrozenCase["candidate_revisions"][number]["lifecycle"];
  scope: Scope;
};

class EvaluationGate {
  readonly #manifest: G4BFrozenSubset;
  #sealed: G4BCalibrationReceipt | null = null;

  constructor(manifest: G4BFrozenSubset) {
    this.#manifest = manifest;
  }

  calibrationPayload(): {
    schema_version: "1.0.0";
    manifest_hash: string;
    thresholds_hash: string;
    cases: G4BFrozenCase[];
  } {
    if (this.#sealed !== null) {
      throw new Error("G4B calibration is already sealed");
    }
    return {
      schema_version: "1.0.0",
      manifest_hash: G4B_MANIFEST_HASH,
      thresholds_hash: canonicalSha256(this.#manifest.thresholds),
      cases: this.#manifest.cases.filter(
        (entry) => entry.partition === "calibration",
      ),
    };
  }

  seal(
    configuration: G4BCalibrationConfiguration,
  ): G4BCalibrationReceipt {
    if (this.#sealed !== null) {
      throw new Error("G4B calibration cannot be changed after seal");
    }
    const payload = this.calibrationPayload();
    const unsigned = {
      schema_version: "1.0.0" as const,
      manifest_hash: G4B_MANIFEST_HASH,
      calibration_case_hashes: payload.cases
        .map((entry) => canonicalSha256(entry))
        .sort(),
      configuration,
      configuration_hash: canonicalSha256(configuration),
      tuner_payload_hash: canonicalSha256(payload),
    };
    this.#sealed = {
      ...unsigned,
      sealed_hash: canonicalSha256(unsigned),
    };
    return this.#sealed;
  }

  evaluationCases(
    receipt: G4BCalibrationReceipt,
  ): G4BFrozenCase[] {
    if (
      this.#sealed === null ||
      canonicalJson(this.#sealed) !== canonicalJson(receipt) ||
      canonicalSha256Omitting(receipt, ["sealed_hash"]) !==
        receipt.sealed_hash
    ) {
      throw new Error("G4B evaluation requires the sealed calibration");
    }
    return [...this.#manifest.cases];
  }
}

export async function loadG4BManifest(): Promise<G4BFrozenSubset> {
  const parsed = G4BFrozenSubsetSchema.parse(
    JSON.parse(await readFile(G4B_MANIFEST_PATH, "utf8")) as unknown,
  );
  if (canonicalSha256(parsed) !== G4B_MANIFEST_HASH) {
    throw new Error("frozen G4B manifest changed");
  }
  return parsed;
}

export async function calibrateG4B(): Promise<{
  manifest: G4BFrozenSubset;
  gate: EvaluationGate;
  receipt: G4BCalibrationReceipt;
  tuner_payload: ReturnType<EvaluationGate["calibrationPayload"]>;
}> {
  const manifest = await loadG4BManifest();
  const gate = new EvaluationGate(manifest);
  const tunerPayload = gate.calibrationPayload();
  const receipt = gate.seal({
    schema_version: "1.0.0",
    vector_top_k: 5,
    similarity_threshold: null,
    fusion: "governed_context_rank_v1",
    max_candidates_per_lane: 5,
  });
  return {
    manifest,
    gate,
    receipt,
    tuner_payload: tunerPayload,
  };
}

function inlineEpisode(input: {
  candidate: G4BFrozenCase["candidate_revisions"][number];
  evidenceId: string;
  caseId: string;
}) {
  const occurredAt = "2026-06-30T12:00:00.000Z";
  const payload = {
    storage: "inline",
    text: input.candidate.content,
    media_type: "text/plain",
  } as const;
  const evidence = EvidenceRecordSchema.parse({
    schema_version: "1.0.0",
    evidence_id: input.evidenceId,
    sequence: 0,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    scope: input.candidate.scope,
    actor: {
      principal_id: input.candidate.principal_id,
      authority: "user_stated",
    },
    source: "conversation_turn",
    authority: "user_stated",
    sensitivity: "internal",
    payload,
    content_hash: canonicalSha256(payload),
  });
  const unsigned = {
    schema_version: "1.0.0" as const,
    episode_id: `episode_${input.caseId}_${input.candidate.revision_id}`,
    scope: input.candidate.scope,
    started_at: occurredAt,
    ended_at: "2026-06-30T12:01:00.000Z",
    event_ids: [input.evidenceId],
    artifact_hashes: [],
    outcome: "succeeded" as const,
  };
  return {
    idempotencyKey:
      `commit:${input.caseId}:${input.candidate.revision_id}`,
    episode: EpisodeSchema.parse({
      ...unsigned,
      sealed_hash: canonicalSha256(unsigned),
    }),
    evidence: [evidence],
    blobs: [],
  };
}

function memoryCandidate(input: {
  frozen: G4BFrozenCase["candidate_revisions"][number];
  evidenceId: string;
  logicalKey: string;
}) {
  const content = {
    storage: "inline",
    text: input.frozen.content,
    media_type: "text/plain",
  } as const;
  return MemoryCandidateSchema.parse({
    schema_version: "1.0.0",
    candidate_id: `candidate_${input.frozen.revision_id}`,
    logical_key: input.logicalKey,
    kind: "semantic",
    scope: input.frozen.scope,
    sensitivity: "personal",
    inferred: false,
    content,
    content_hash: canonicalSha256(content),
    evidence_ids: [input.evidenceId],
    validity: {
      valid_from: input.frozen.valid_from,
      valid_to: input.frozen.valid_to,
      recorded_at: "2026-06-30T12:00:00.000Z",
    },
    injection_risk: "none",
    requires_user_confirmation: false,
    transform: {
      name: "g4b-frozen-candidate",
      version: "1.0.0",
    },
  });
}

function memoryProposal(input: {
  frozenCase: G4BFrozenCase;
  candidate: ReturnType<typeof memoryCandidate>;
}) {
  return MemoryProposeInputSchema.parse({
    envelope: {
      schema_version: "1.0.0",
      request_id:
        `request_${input.frozenCase.case_id}_${input.candidate.candidate_id}`,
      tool: "memory_propose",
      safety_class: "proposal",
      actor_claim: {
        principal_id: "user_local",
        authority: "user_stated",
      },
      scopes: [input.candidate.scope],
      purpose: "Materialize one immutable G4B replay candidate",
      reason: "Use one canonical setup for every replay arm",
      requested_at: "2026-06-30T12:02:00.000Z",
      idempotency_key:
        `propose:${input.frozenCase.case_id}:${input.candidate.candidate_id}`,
    },
    candidate: input.candidate,
  });
}

class ReplayApprovalRegistry implements ApprovalRegistry {
  readonly #grants = new Map<
    string,
    ReturnType<typeof ApprovalGrantSchema.parse>
  >();

  approve(request: {
    envelope: {
      approval_id: string | null;
      actor_claim: { principal_id: string };
      tool: ApprovalBinding["tool"];
      safety_class: ApprovalBinding["safety_class"];
      scopes: ApprovalBinding["scopes"];
    };
  }): void {
    const approvalId = request.envelope.approval_id;
    if (approvalId === null) {
      throw new Error("G4B control requires an approval");
    }
    const unsigned = {
      schema_version: "1.0.0" as const,
      approval_id: approvalId,
      principal_id: request.envelope.actor_claim.principal_id,
      tool: request.envelope.tool,
      safety_class: request.envelope.safety_class,
      scopes: request.envelope.scopes,
      request_hash: canonicalSha256(request),
      issued_at: "2026-07-29T04:00:00.000Z",
      expires_at: "2026-07-29T06:00:00.000Z",
      manifest_hash: HASH("0"),
    };
    this.#grants.set(
      approvalId,
      ApprovalGrantSchema.parse({
        ...unsigned,
        manifest_hash: canonicalSha256Omitting(unsigned, [
          "manifest_hash",
        ]),
      }),
    );
  }

  async verify(binding: ApprovalBinding): Promise<VerifiedApproval> {
    const grant = this.#grants.get(binding.approval_id);
    if (
      grant === undefined ||
      grant.principal_id !== binding.principal_id ||
      grant.tool !== binding.tool ||
      grant.safety_class !== binding.safety_class ||
      grant.request_hash !== binding.request_hash
    ) {
      throw new ApprovalError("APPROVAL_INVALID");
    }
    return {
      grant,
      registry_hash: canonicalSha256(
        [...this.#grants.keys()].sort(),
      ),
    };
  }

  async confirmUnchanged(_approval: VerifiedApproval): Promise<void> {}
}

async function seedCanonicalCase(
  storage: SqliteStorageClient,
  manifest: G4BFrozenSubset,
  frozenCase: G4BFrozenCase,
): Promise<CanonicalMapping[]> {
  const candidates = new Map(
    frozenCase.candidate_revisions.map((entry) => [
      entry.revision_id,
      entry,
    ]),
  );
  const mapping = new Map<string, CanonicalMapping>();
  for (const candidate of frozenCase.candidate_revisions) {
    const evidenceId =
      `evidence_${frozenCase.case_id}_${candidate.revision_id}`;
    await storage.commitEpisode(
      inlineEpisode({
        candidate,
        evidenceId,
        caseId: frozenCase.case_id,
      }),
    );
  }

  const superseded = frozenCase.candidate_revisions.find(
    (entry) => entry.lifecycle === "superseded",
  );
  if (superseded !== undefined) {
    const successor = frozenCase.candidate_revisions.find(
      (entry) =>
        entry.lifecycle === "active" &&
        frozenCase.expected_revision_ids.includes(entry.revision_id),
    );
    if (successor === undefined) {
      throw new Error("G4B superseded fixture lacks its successor");
    }
    const logicalKey = `g4b.${frozenCase.case_id}.corrected`;
    const oldCandidate = memoryCandidate({
      frozen: superseded,
      evidenceId:
        `evidence_${frozenCase.case_id}_${superseded.revision_id}`,
      logicalKey,
    });
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        frozenCase,
        candidate: oldCandidate,
      }),
      evaluation: {
        decision: "activate",
        reason: "Create the frozen predecessor before correction.",
      },
    });
    mapping.set(superseded.revision_id, {
      declared_revision_id: superseded.revision_id,
      memory_id: admitted.memory_id,
      revision_id: admitted.current_revision_id,
      evidence_id: oldCandidate.evidence_ids[0] ?? "",
      lifecycle: superseded.lifecycle,
      scope: superseded.scope,
    });
    const successorCandidate = memoryCandidate({
      frozen: successor,
      evidenceId:
        `evidence_${frozenCase.case_id}_${successor.revision_id}`,
      logicalKey,
    });
    const revised = await storage.applyMemoryRevision({
      idempotency_key:
        `revision:${frozenCase.case_id}:${successor.revision_id}`,
      principal_id: "user_local",
      actor_authority: "user_stated",
      scope: successor.scope,
      requested_at: "2026-07-01T00:00:00.000Z",
      memory_id: admitted.memory_id,
      expected_revision_id: admitted.current_revision_id,
      candidate: successorCandidate,
      evaluation: {
        decision: "activate",
        reason: "Publish the frozen immutable successor.",
      },
    });
    mapping.set(successor.revision_id, {
      declared_revision_id: successor.revision_id,
      memory_id: revised.memory_id,
      revision_id: revised.current_revision_id,
      evidence_id: successorCandidate.evidence_ids[0] ?? "",
      lifecycle: successor.lifecycle,
      scope: successor.scope,
    });
    candidates.delete(superseded.revision_id);
    candidates.delete(successor.revision_id);
  }

  for (const candidate of candidates.values()) {
    const built = memoryCandidate({
      frozen: candidate,
      evidenceId:
        `evidence_${frozenCase.case_id}_${candidate.revision_id}`,
      logicalKey:
        `g4b.${frozenCase.case_id}.${candidate.revision_id}`,
    });
    const admitted = await storage.admitMemory({
      request: memoryProposal({
        frozenCase,
        candidate: built,
      }),
      evaluation: {
        decision:
          candidate.lifecycle === "candidate"
            ? "candidate_only"
            : "activate",
        reason: "Materialize the frozen G4B lifecycle.",
      },
    });
    mapping.set(candidate.revision_id, {
      declared_revision_id: candidate.revision_id,
      memory_id: admitted.memory_id,
      revision_id: admitted.current_revision_id,
      evidence_id: built.evidence_ids[0] ?? "",
      lifecycle: candidate.lifecycle,
      scope: candidate.scope,
    });
  }

  const revoked = [...mapping.values()].filter(
    (entry) => entry.lifecycle === "revoked",
  );
  if (revoked.length > 0) {
    const approvals = new ReplayApprovalRegistry();
    const runtime = new MemoryRuntime({
      storage,
      approvalRegistry: approvals,
      clock: () => manifest.as_of,
      policy: {
        principal: {
          principal_id: manifest.scope.principal_id,
          allowed_scopes: [
            {
              kind: manifest.scope.kind,
              id: manifest.scope.id,
            },
          ],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: true,
        },
        default_token_budget: manifest.token_budgets[0],
      },
    });
    for (const entry of revoked) {
      const request = {
        envelope: {
          schema_version: "1.0.0",
          request_id: `request_revoke_${entry.declared_revision_id}`,
          tool: "memory_revoke" as const,
          safety_class: "important_mutation" as const,
          actor_claim: {
            principal_id: manifest.scope.principal_id,
            authority: "user_stated" as const,
          },
          scopes: [entry.scope],
          purpose: "Materialize one frozen revoked control",
          reason: "Verify lifecycle postvalidation in every G4B arm",
          requested_at: "2026-07-29T04:30:00.000Z",
          idempotency_key:
            `revoke:${frozenCase.case_id}:${entry.declared_revision_id}`,
          expected_revision_id: entry.revision_id,
          approval_id:
            `approval_revoke_${entry.declared_revision_id}`,
          dry_run: false,
        },
        memory_id: entry.memory_id,
      };
      approvals.approve(request);
      const response = await runtime.memoryRevoke(request);
      if (response.status !== "OK") {
        throw new Error("G4B revoked fixture failed");
      }
    }
  }
  await storage.drainFtsOutbox();
  return [...mapping.values()].sort((left, right) =>
    left.declared_revision_id.localeCompare(
      right.declared_revision_id,
    )
  );
}

function lanePolicy(
  arm: G4BArm,
  configuration: G4BCalibrationConfiguration,
) {
  const allowedLanes: RecallLane[] = arm === "fts_recency"
    ? ["recent_l1"]
    : arm === "layered"
      ? ["recent_l1", "relation_sqlite"]
      : arm === "vector"
        ? ["semantic_vector"]
        : [
            "recent_l1",
            "relation_sqlite",
            "semantic_vector",
          ];
  return {
    allowed_lanes: allowedLanes,
    limits: {
      max_candidates_per_lane:
        configuration.max_candidates_per_lane,
      max_concurrent_lanes: 2,
      relation_max_depth: 2,
      relation_max_fanout: 5,
      relation_max_starts: 20,
      relation_max_paths: 20,
      vector_top_k: configuration.vector_top_k,
      vector_query_timeout_ms: 50,
      vector_max_response_bytes: 65_536,
    },
  };
}

function observationFromResponse(input: {
  arm: G4BArm;
  budget: number;
  response: Awaited<ReturnType<MemoryRuntime["memoryContextCompile"]>>;
  manifest: G4BFrozenSubset;
  frozenCase: G4BFrozenCase;
  mapping: CanonicalMapping[];
  eligibility: Record<string, string>;
  receipt: G4BCalibrationReceipt;
  implementationCommit: string;
  dependencyLockHash: string;
}): G4BObservation {
  const data =
    input.response.status === "OK" ||
    input.response.status === "DEGRADED"
      ? input.response.data as {
          context_slice?: {
            token_used: number;
            items: Array<{
              revision_id: string;
              evidence_ids: string[];
              selection_reason: string;
              vector?: unknown;
            }>;
            frozen_hash: string;
          } | null;
          receipt?: { receipt_hash?: string };
        }
      : {};
  const items = data.context_slice?.items ?? [];
  const declaredByRevision = new Map(
    input.mapping.map((entry) => [
      entry.revision_id,
      entry.declared_revision_id,
    ]),
  );
  const declaredByEvidence = new Map(
    input.mapping.map((entry) => [
      entry.evidence_id,
      entry.declared_revision_id,
    ]),
  );
  const included = items.flatMap((item) => {
    const declared = declaredByRevision.get(item.revision_id);
    return declared === undefined ? [] : [declared];
  });
  const evidence = items.flatMap((item) =>
    item.evidence_ids.flatMap((evidenceId) => {
      const declared = declaredByEvidence.get(evidenceId);
      return declared === undefined ? [] : [declared];
    })
  );
  const selected = items.flatMap((item) => {
    const declared = declaredByRevision.get(item.revision_id);
    return declared === undefined ||
        item.selection_reason.trim().length === 0
      ? []
      : [declared];
  });
  const commonIdentity = {
    manifest_hash: G4B_MANIFEST_HASH,
    case_hash: canonicalSha256(input.frozenCase),
    canonical_setup_hash: canonicalSha256({
      mapping: input.mapping,
      eligibility: input.eligibility,
    }),
    principal_id: input.manifest.scope.principal_id,
    scope: {
      kind: input.manifest.scope.kind,
      id: input.manifest.scope.id,
    },
    as_of: input.manifest.as_of,
    include_sensitive: false as const,
    token_budget: input.budget,
    reader_hash: canonicalSha256({
      reader: "SqliteStorageClient.searchGovernedMemory",
      version: "0013",
    }),
    filter_hash: canonicalSha256({
      exact_scope: true,
      lifecycle: true,
      validity: true,
      sensitivity: true,
      usage: true,
      canonical_postvalidation: true,
    }),
    compiler_hash: canonicalSha256({
      compiler: "MemoryRuntime.memoryContextCompile",
      policy: "3.0.0",
    }),
    oracle_hash: canonicalSha256({
      expected_revision_ids:
        input.frozenCase.expected_revision_ids,
      candidate_revisions:
        input.frozenCase.candidate_revisions,
    }),
    calibration_hash: input.receipt.sealed_hash,
  };
  return {
    arm: input.arm,
    token_budget: input.budget,
    status: input.response.status,
    included_revision_ids: [...new Set(included)].sort(),
    evidence_revision_ids: [...new Set(evidence)].sort(),
    selection_revision_ids: [...new Set(selected)].sort(),
    token_used: data.context_slice?.token_used ?? 0,
    duplicate_count: included.length - new Set(included).size,
    contradiction_count: 0,
    canonical_eligibility: input.eligibility,
    common_identity: commonIdentity,
    arm_configuration_hash: canonicalSha256({
      arm: input.arm,
      lane_policy: lanePolicy(
        input.arm,
        input.receipt.configuration,
      ),
      implementation_commit: input.implementationCommit,
      dependency_lock_hash: input.dependencyLockHash,
    }),
    context_hash: data.context_slice?.frozen_hash ?? null,
    receipt_hash: data.receipt?.receipt_hash ?? null,
  };
}

function scoreObservation(
  frozenCase: G4BFrozenCase,
  observation: G4BObservation,
) {
  const expected = [...frozenCase.expected_revision_ids].sort();
  const expectedSet = new Set<string>(expected);
  const eligible = new Set(
    Object.entries(observation.canonical_eligibility)
      .filter(([, status]) => status === "eligible")
      .map(([revisionId]) => revisionId),
  );
  const prohibited = observation.included_revision_ids.filter(
    (revisionId) => !eligible.has(revisionId),
  );
  const distractors = observation.included_revision_ids.filter(
    (revisionId) =>
      eligible.has(revisionId) && !expectedSet.has(revisionId)
  );
  const expectedIncluded = expected.every((revisionId) =>
    observation.included_revision_ids.includes(revisionId)
  );
  const provenancePassed = expected.every((revisionId) =>
    observation.evidence_revision_ids.includes(revisionId)
  );
  const explanationPassed = expected.every((revisionId) =>
    observation.selection_revision_ids.includes(revisionId)
  );
  const taskPassed =
    expectedIncluded &&
    prohibited.length === 0 &&
    (expected.length > 0 ||
      observation.included_revision_ids.length === 0);
  return {
    passed:
      taskPassed &&
      provenancePassed &&
      explanationPassed &&
      observation.token_used <= observation.token_budget,
    task_passed: taskPassed,
    provenance_passed: provenancePassed,
    explanation_passed: explanationPassed,
    expected_included: expectedIncluded,
    prohibited_revision_ids: prohibited.sort(),
    distractor_revision_ids: distractors.sort(),
    duplicate_count: observation.duplicate_count,
    contradiction_count: observation.contradiction_count,
    token_used: observation.token_used,
  };
}

function assertComparable(
  observations: Record<G4BArm, G4BObservation>,
): void {
  const common = Object.values(observations).map(
    (entry) => canonicalJson(entry.common_identity),
  );
  if (new Set(common).size !== 1) {
    throw new Error("G4B arm comparison identity drift");
  }
}

async function eligibilityForCase(input: {
  storage: SqliteStorageClient;
  manifest: G4BFrozenSubset;
  mapping: CanonicalMapping[];
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of input.mapping) {
    const eligibility = await input.storage.checkMemoryEligibility({
      memory_id: entry.memory_id,
      revision_id: entry.revision_id,
      principal_id: input.manifest.scope.principal_id,
      scope: {
        kind: input.manifest.scope.kind,
        id: input.manifest.scope.id,
      },
      as_of: input.manifest.as_of,
      include_sensitive: false,
      context_scope: {
        kind: input.manifest.scope.kind,
        id: input.manifest.scope.id,
      },
    });
    result[entry.declared_revision_id] = eligibility.eligible
      ? "eligible"
      : eligibility.reason_code;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );
}

export async function openG4BResourceHarness(options: {
  data_root: string;
  model_root: string;
}): Promise<G4BResourceHarness> {
  const { manifest, gate, receipt } = await calibrateG4B();
  const frozenCase = gate
    .evaluationCases(receipt)
    .find((entry) => entry.case_role === "positive_gap");
  if (frozenCase === undefined) {
    throw new Error("G4B resource harness requires a positive case");
  }
  const storage = await SqliteStorageClient.open({
    dataRoot: options.data_root,
  });
  try {
    await seedCanonicalCase(storage, manifest, frozenCase);
    await storage.registerVectorEmbeddingEpoch({
      epoch: G4B_VECTOR_EPOCH,
      registered_at: manifest.as_of,
    });
    await storage.configureVectorProjection({
      mode: "evaluating",
      epoch_id: G4B_VECTOR_EPOCH.epoch_id,
      configured_at: manifest.as_of,
    });
    const projector = new VectorScopeProjector({
      storage,
      dataRoot: options.data_root,
      modelRoot: options.model_root,
      epoch: G4B_VECTOR_EPOCH,
    });
    const projected = await projector.drain({
      worker_id: "g4b_resource_projector",
      claimed_at: "2026-07-29T05:00:01.000Z",
      lease_expires_at: "2026-07-29T05:10:00.000Z",
      completed_at: "2026-07-29T05:09:00.000Z",
      retry_at: "2026-07-29T05:10:01.000Z",
      limit: 10,
    });
    if (projected.failed > 0 || projected.stale > 0) {
      throw new Error("G4B resource projection did not publish");
    }
    const retriever = new SemanticVectorRetriever({
      storage,
      dataRoot: options.data_root,
      modelRoot: options.model_root,
      epoch: G4B_VECTOR_EPOCH,
      allowEvaluating: true,
    });
    const fallbackRetriever = new SemanticVectorRetriever({
      storage,
      dataRoot: options.data_root,
      modelRoot: join(options.data_root, "missing-model"),
      epoch: G4B_VECTOR_EPOCH,
      allowEvaluating: true,
    });
    const laneRetriever = new LayeredLaneRetrievers(storage, {
      vectorRetriever: retriever,
    });
    const runtime = new MemoryRuntime({
      storage,
      clock: () => manifest.as_of,
      policy: {
        principal: {
          principal_id: manifest.scope.principal_id,
          allowed_scopes: [
            {
              kind: manifest.scope.kind,
              id: manifest.scope.id,
            },
          ],
          allowed_authorities: ["user_stated"],
          destructive_tools_enabled: false,
        },
        default_token_budget: manifest.token_budgets[0] ?? 1_800,
        lane_policy: {
          ...lanePolicy("hybrid", receipt.configuration),
          allowed_lanes: [
            "recent_l1" as const,
            "semantic_vector" as const,
          ],
        },
      },
      laneRetriever,
    });
    const semanticRequest = (query: string) => ({
      lane: "semantic_vector" as const,
      principal_id: manifest.scope.principal_id,
      scope: {
        kind: manifest.scope.kind,
        id: manifest.scope.id,
      },
      query,
      as_of: manifest.as_of,
      include_sensitive: false,
      limit: receipt.configuration.max_candidates_per_lane,
      vector_top_k: receipt.configuration.vector_top_k,
      vector_query_timeout_ms: 50,
      vector_max_response_bytes: 65_536,
    });
    return {
      manifest,
      frozen_case: frozenCase,
      storage,
      retriever,
      fallback_retriever: fallbackRetriever,
      recall: ({ query }) =>
        retriever.retrieve(
          semanticRequest(query ?? frozenCase.query),
        ),
      fallback: () =>
        fallbackRetriever.retrieve(
          semanticRequest(frozenCase.query),
        ),
      compile: ({ sample_id: sampleId }) =>
        runtime.memoryContextCompile({
          envelope: {
            schema_version: "1.0.0",
            request_id: `request_g4b_resource_${sampleId}`,
            tool: "memory_context_compile",
            safety_class: "read_only",
            actor_claim: {
              principal_id: manifest.scope.principal_id,
              authority: "user_stated",
            },
            scopes: [
              {
                kind: manifest.scope.kind,
                id: manifest.scope.id,
              },
            ],
            purpose: "Measure governed G4B Context compilation",
            reason: "Apply the frozen vector resource gate",
            requested_at: manifest.as_of,
          },
          recall: {
            schema_version: "1.0.0",
            request_id: `request_g4b_resource_${sampleId}`,
            goal: "Answer the frozen G4B resource Oracle",
            query: frozenCase.query,
            scopes: [
              {
                kind: manifest.scope.kind,
                id: manifest.scope.id,
              },
            ],
            as_of: manifest.as_of,
            token_budget: manifest.token_budgets[0] ?? 1_800,
            include_sensitive: false,
          },
        }),
      close: async () => {
        await storage.close();
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}

export async function runG4BReplay(
  options: G4BReplayOptions,
): Promise<ReturnType<typeof buildG4BReplayReport>> {
  const { manifest, gate } = await calibrateG4B();
  const cases = gate.evaluationCases(options.receipt);
  const runs: G4BCaseRun[] = [];
  for (const frozenCase of cases) {
    const caseRoot = join(options.data_root, frozenCase.case_id);
    const storage = await SqliteStorageClient.open({
      dataRoot: caseRoot,
    });
    try {
      const mapping = await seedCanonicalCase(
        storage,
        manifest,
        frozenCase,
      );
      const eligibility = await eligibilityForCase({
        storage,
        manifest,
        mapping,
      });
      for (const expected of frozenCase.expected_revision_ids) {
        if (eligibility[expected] !== "eligible") {
          throw new Error(
            `G4B expected revision ${expected} is not canonical`,
          );
        }
      }
      await storage.registerVectorEmbeddingEpoch({
        epoch: G4B_VECTOR_EPOCH,
        registered_at: manifest.as_of,
      });
      await storage.configureVectorProjection({
        mode: "evaluating",
        epoch_id: G4B_VECTOR_EPOCH.epoch_id,
        configured_at: manifest.as_of,
      });
      const runtimeBundle =
        options.runtime_factory?.(frozenCase) ?? {};
      const projector = new VectorScopeProjector({
        storage,
        dataRoot: caseRoot,
        modelRoot: options.model_root,
        epoch: G4B_VECTOR_EPOCH,
        ...(runtimeBundle.projection === undefined
          ? {}
          : { runtimeFactory: runtimeBundle.projection }),
      });
      const projected = await projector.drain({
        worker_id: `g4b_projector_${frozenCase.case_id}`,
        claimed_at: "2026-07-29T05:00:01.000Z",
        lease_expires_at: "2026-07-29T05:10:00.000Z",
        completed_at: "2026-07-29T05:09:00.000Z",
        retry_at: "2026-07-29T05:10:01.000Z",
        limit: 10,
      });
      if (projected.failed > 0 || projected.stale > 0) {
        throw new Error(
          `G4B vector projection failed for ${frozenCase.case_id}`,
        );
      }
      const retriever = new SemanticVectorRetriever({
        storage,
        dataRoot: caseRoot,
        modelRoot: options.model_root,
        epoch: G4B_VECTOR_EPOCH,
        allowEvaluating: true,
        ...(runtimeBundle.query === undefined
          ? {}
          : { runtimeFactory: runtimeBundle.query }),
      });
      const laneRetriever = new LayeredLaneRetrievers(storage, {
        vectorRetriever: retriever,
      });
      for (const budget of manifest.token_budgets) {
        const observations = {} as Record<G4BArm, G4BObservation>;
        for (const arm of manifest.arms) {
          const runtime = new MemoryRuntime({
            storage,
            clock: () => manifest.as_of,
            policy: {
              principal: {
                principal_id: manifest.scope.principal_id,
                allowed_scopes: [
                  {
                    kind: manifest.scope.kind,
                    id: manifest.scope.id,
                  },
                ],
                allowed_authorities: ["user_stated"],
                destructive_tools_enabled: false,
              },
              default_token_budget: budget,
              lane_policy: lanePolicy(
                arm,
                options.receipt.configuration,
              ),
            },
            laneRetriever,
          });
          const response = await runtime.memoryContextCompile({
            envelope: {
              schema_version: "1.0.0",
              request_id:
                `request_${frozenCase.case_id}_${arm}_${budget}`,
              tool: "memory_context_compile",
              safety_class: "read_only",
              actor_claim: {
                principal_id: manifest.scope.principal_id,
                authority: "user_stated",
              },
              scopes: [
                {
                  kind: manifest.scope.kind,
                  id: manifest.scope.id,
                },
              ],
              purpose: "Execute one frozen comparable G4B arm",
              reason: "Measure governed semantic utility and pollution",
              requested_at: manifest.as_of,
            },
            recall: {
              schema_version: "1.0.0",
              request_id:
                `request_${frozenCase.case_id}_${arm}_${budget}`,
              goal: "Answer the frozen G4B task Oracle",
              query: frozenCase.query,
              scopes: [
                {
                  kind: manifest.scope.kind,
                  id: manifest.scope.id,
                },
              ],
              as_of: manifest.as_of,
              token_budget: budget,
              include_sensitive: false,
            },
          });
          observations[arm] = observationFromResponse({
            arm,
            budget,
            response,
            manifest,
            frozenCase,
            mapping,
            eligibility,
            receipt: options.receipt,
            implementationCommit:
              options.implementation_commit,
            dependencyLockHash: options.dependency_lock_hash,
          });
        }
        assertComparable(observations);
        runs.push({
          case_id: frozenCase.case_id,
          partition: frozenCase.partition,
          case_role: frozenCase.case_role,
          family: frozenCase.family,
          case_hash: canonicalSha256(frozenCase),
          token_budget: budget,
          observations,
          scores: Object.fromEntries(
            manifest.arms.map((arm) => [
              arm,
              scoreObservation(frozenCase, observations[arm]),
            ]),
          ) as G4BCaseRun["scores"],
        });
      }
    } finally {
      await storage.close();
      if (!options.retain_case_roots) {
        await import("node:fs/promises").then(({ rm }) =>
          rm(caseRoot, { recursive: true, force: true })
        );
      }
    }
  }
  return buildG4BReplayReport({
    manifest,
    receipt: options.receipt,
    implementationCommit: options.implementation_commit,
    dependencyLockHash: options.dependency_lock_hash,
    runs,
    recordedAt:
      options.recorded_at ?? new Date().toISOString(),
  });
}

export function buildG4BReplayReport(input: {
  manifest: G4BFrozenSubset;
  receipt: G4BCalibrationReceipt;
  implementationCommit: string;
  dependencyLockHash: string;
  runs: G4BCaseRun[];
  recordedAt: string;
}) {
  const cases = input.manifest.cases.map((frozenCase) => {
    const budgets = input.runs.filter(
      (run) => run.case_id === frozenCase.case_id,
    );
    if (budgets.length !== input.manifest.token_budgets.length) {
      throw new Error(
        `G4B case ${frozenCase.case_id} lacks both budgets`,
      );
    }
    const hybridPassed = budgets.every(
      (run) => run.scores.hybrid.passed,
    );
    const strictGain =
      frozenCase.case_role === "positive_gap" &&
      hybridPassed &&
      budgets.every(
        (run) =>
          !run.scores.fts_recency.passed &&
          !run.scores.layered.passed,
      );
    return {
      case_id: frozenCase.case_id,
      partition: frozenCase.partition,
      case_role: frozenCase.case_role,
      family: frozenCase.family,
      case_hash: canonicalSha256(frozenCase),
      hybrid_passed: hybridPassed,
      strict_gain: strictGain,
      budgets,
    };
  });
  const positiveSolved = cases.filter(
    (entry) =>
      entry.case_role === "positive_gap" &&
      entry.hybrid_passed,
  ).length;
  const strictGains = cases.filter((entry) => entry.strict_gain);
  const prohibitedRegressions = input.runs.flatMap((run) =>
    Object.entries(run.scores).flatMap(([arm, score]) =>
      score.prohibited_revision_ids.map(
        (revisionId) =>
          `${run.case_id}:${run.token_budget}:${arm}:${revisionId}`,
      )
    )
  );
  const negativeControlRegressions = cases
    .filter(
      (entry) =>
        entry.case_role === "negative_control" &&
        !entry.hybrid_passed,
    )
    .map((entry) =>
      `${entry.case_id}:HYBRID_NEGATIVE_CONTROL_FAILED`
    );
  const criticalRegressions = [
    ...prohibitedRegressions,
    ...negativeControlRegressions,
  ].sort();
  const pollutionDeltas = input.runs.map((run) => {
    const pollution = (
      score: G4BCaseRun["scores"][G4BArm],
    ) =>
      score.distractor_revision_ids.length +
      score.duplicate_count +
      score.contradiction_count;
    return {
      case_id: run.case_id,
      token_budget: run.token_budget,
      layered: pollution(run.scores.layered),
      hybrid: pollution(run.scores.hybrid),
      delta:
        pollution(run.scores.hybrid) -
        pollution(run.scores.layered),
    };
  });
  const thresholdResults = {
    hybrid_positive_success:
      positiveSolved >=
      input.manifest.thresholds.minimum_positive_cases_solved,
    strict_case_gains:
      strictGains.length >=
      input.manifest.thresholds.minimum_strict_case_gains,
    holdout_gain:
      strictGains.filter(
        (entry) => entry.partition === "holdout",
      ).length >= input.manifest.thresholds.minimum_holdout_gains,
    transfer_gain:
      strictGains.filter(
        (entry) => entry.partition === "transfer",
      ).length >= input.manifest.thresholds.minimum_transfer_gains,
    critical_regressions:
      criticalRegressions.length <=
      input.manifest.thresholds.critical_regression_tolerance,
    negative_controls:
      negativeControlRegressions.length === 0,
    context_pollution:
      pollutionDeltas.every(
        (entry) =>
          entry.delta <=
          input.manifest.thresholds
            .context_pollution_delta_tolerance,
      ),
  };
  const withoutHash = {
    schema_version: "1.0.0",
    recorded_at: input.recordedAt,
    gate: "G4B_REPLAY",
    manifest_hash: G4B_MANIFEST_HASH,
    thresholds_hash: canonicalSha256(
      input.manifest.thresholds,
    ),
    calibration_receipt: input.receipt,
    implementation_commit: input.implementationCommit,
    dependency_lock_hash: input.dependencyLockHash,
    arms: input.manifest.arms,
    token_budgets: input.manifest.token_budgets,
    cases,
    summary: {
      positive_cases_solved: positiveSolved,
      strict_case_gains: strictGains.length,
      holdout_gains: strictGains.filter(
        (entry) => entry.partition === "holdout",
      ).length,
      transfer_gains: strictGains.filter(
        (entry) => entry.partition === "transfer",
      ).length,
      critical_regressions: criticalRegressions,
      pollution_deltas: pollutionDeltas,
    },
    threshold_results: thresholdResults,
    utility_gate: Object.values(thresholdResults).every(Boolean),
    logical_results_hash: canonicalSha256(
      cases.map((entry) => ({
        case_id: entry.case_id,
        hybrid_passed: entry.hybrid_passed,
        strict_gain: entry.strict_gain,
        budgets: entry.budgets.map((run) => ({
          token_budget: run.token_budget,
          scores: run.scores,
          observations: Object.fromEntries(
            Object.entries(run.observations).map(
              ([arm, observation]) => [
                arm,
                {
                  included_revision_ids:
                    observation.included_revision_ids,
                  evidence_revision_ids:
                    observation.evidence_revision_ids,
                  selection_revision_ids:
                    observation.selection_revision_ids,
                  token_used: observation.token_used,
                  common_identity:
                    observation.common_identity,
                },
              ],
            ),
          ),
        })),
      })),
    ),
  };
  return {
    ...withoutHash,
    report_hash: canonicalSha256(withoutHash),
  };
}

export function materializeG4BExpectedProfile(
  profile: G4BFrozenSubset["expected_profile"],
) {
  const partitions = 100;
  const scopes = Array.from({ length: partitions }, (_, index) => {
    const activeL1 =
      Math.floor(profile.active_l1_memories / partitions) +
      (index < profile.active_l1_memories % partitions ? 1 : 0);
    const projections =
      Math.floor(profile.l2_l3_projections / partitions) +
      (index < profile.l2_l3_projections % partitions ? 1 : 0);
    const relations =
      Math.floor(profile.relations / partitions) +
      (index < profile.relations % partitions ? 1 : 0);
    return {
      scope_id: `g4b_expected_scope_${String(index).padStart(3, "0")}`,
      evidence_events:
        Math.floor(profile.evidence_events / partitions) +
        (index < profile.evidence_events % partitions ? 1 : 0),
      active_l1_memories: activeL1,
      l2_l3_projections: projections,
      relations,
      logical_digest: canonicalSha256({
        scope_index: index,
        active_l1_memories: activeL1,
        l2_l3_projections: projections,
        relations,
      }),
    };
  });
  return {
    schema_version: "1.0.0" as const,
    ...profile,
    scope_count: scopes.length,
    scopes,
    logical_digest: canonicalSha256(scopes),
  };
}

export function percentile(
  values: number[],
  ratio: number,
): number {
  if (values.length === 0) {
    throw new Error("G4B percentile requires samples");
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.max(0, Math.ceil(ordered.length * ratio) - 1)
  ] ?? 0;
}

export function evaluateG4BResourceMetrics(input: {
  thresholds: G4BFrozenSubset["thresholds"];
  samples: {
    warmups: number;
    measured: number;
  };
  outcomes: {
    direct_complete: number;
    governed_complete: number;
    context_ok: number;
    fallback_typed_degraded: number;
  };
  latency_ms: {
    governed_recall_p50: number;
    governed_recall_p95: number;
    governed_recall_p99: number;
    context_compile_p50: number;
    context_compile_p95: number;
    context_compile_p99: number;
    fallback_p95: number;
    cold_ready: number;
    scope_rebuild: number;
    full_rebuild: number | null;
    epoch_migration: number | null;
  };
  expected_profile: {
    logical_materialized: boolean;
    native_physical_materialized: boolean;
    full_rebuild_measured: boolean;
    epoch_migration_measured: boolean;
  };
}) {
  return {
    warmups:
      input.samples.warmups >= input.thresholds.warmup_samples,
    measured_samples:
      input.samples.measured >= input.thresholds.measured_samples,
    direct_warm_outcomes:
      input.outcomes.direct_complete >=
      input.thresholds.measured_samples,
    governed_recall_outcomes:
      input.outcomes.governed_complete >=
      input.thresholds.measured_samples,
    context_compile_outcomes:
      input.outcomes.context_ok >=
      input.thresholds.measured_samples,
    fallback_outcomes:
      input.outcomes.fallback_typed_degraded >=
      input.thresholds.measured_samples,
    governed_recall_p50:
      input.latency_ms.governed_recall_p50 <=
      input.thresholds.governed_recall_p50_ms,
    governed_recall_p95:
      input.latency_ms.governed_recall_p95 <=
      input.thresholds.governed_recall_p95_ms,
    context_compile_p50:
      input.latency_ms.context_compile_p50 <=
      input.thresholds.context_compile_p50_ms,
    context_compile_p95:
      input.latency_ms.context_compile_p95 <=
      input.thresholds.context_compile_p95_ms,
    fallback_p95:
      input.latency_ms.fallback_p95 <=
      input.thresholds.fallback_p95_ms,
    expected_logical_profile:
      input.expected_profile.logical_materialized,
    expected_native_profile:
      input.expected_profile.native_physical_materialized,
    expected_full_rebuild:
      input.expected_profile.full_rebuild_measured &&
      input.latency_ms.full_rebuild !== null,
    expected_epoch_migration:
      input.expected_profile.epoch_migration_measured &&
      input.latency_ms.epoch_migration !== null,
  };
}

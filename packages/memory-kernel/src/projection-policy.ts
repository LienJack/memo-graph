import {
  ProjectionRevisionSchema,
  ProjectionSourceSchema,
  canonicalJson,
  canonicalSha256,
  deriveProjectionIdentity,
  type ProjectionPayload,
  type ProjectionRevision,
  type ProjectionSource,
  type ProjectionType,
} from "@memo-graph/contracts";
import type { ProjectionSourceListResult } from "@memo-graph/storage-sqlite";

export const PROJECTION_TRANSFORM = {
  name: "deterministic-layered-consolidation",
  version: "1.0.0",
} as const;

type GovernedSource = ProjectionSourceListResult["items"][number];

export type ProjectionPolicyInput = {
  principal_id: string;
  scope: GovernedSource["scope"];
  ledger_epoch: number;
  tombstone_epoch: number;
  projection_epoch: number;
  sources: GovernedSource[];
};

type ProjectionDescriptor = {
  projection_type: ProjectionType;
  payload: ProjectionPayload;
  sources: GovernedSource[];
  content: {
    storage: "inline";
    text: string;
    media_type: "application/json";
  };
  content_hash: `sha256:${string}`;
  projection_id: string;
};

const SENSITIVITY_RANK = {
  public: 0,
  internal: 1,
  personal: 2,
  sensitive: 3,
  secret: 4,
} as const;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sourceText(source: GovernedSource): string {
  if (source.content.storage !== "inline") {
    throw new Error("projection policy accepts inline governed sources only");
  }
  return source.content.text;
}

function sourceRef(
  principalId: string,
  source: GovernedSource,
): ProjectionSource {
  return ProjectionSourceSchema.parse({
    memory_id: source.memory_id,
    revision_id: source.revision_id,
    abstraction: "l1_memory",
    principal_id: principalId,
    scope: source.scope,
    authority: source.authority,
    sensitivity: source.sensitivity,
    validity: source.validity,
    content_hash: source.content_hash,
    evidence_ids: uniqueSorted(source.evidence_ids),
  });
}

function normalizedSourceOrder(sources: GovernedSource[]): GovernedSource[] {
  return [...sources].sort((left, right) =>
    left.revision_id.localeCompare(right.revision_id)
  );
}

function descriptor(
  principalId: string,
  scope: GovernedSource["scope"],
  projectionType: ProjectionType,
  payload: ProjectionPayload,
  sources: GovernedSource[],
): ProjectionDescriptor {
  const orderedSources = normalizedSourceOrder(sources);
  const content = {
    storage: "inline" as const,
    text: canonicalJson(payload),
    media_type: "application/json" as const,
  };
  const contentHash = canonicalSha256(content);
  const projectionId = deriveProjectionIdentity({
    projection_type: projectionType,
    principal_id: principalId,
    scope,
    source_revisions: orderedSources.map((source) => ({
      revision_id: source.revision_id,
    })),
    transform: PROJECTION_TRANSFORM,
    content_hash: contentHash,
  });
  return {
    projection_type: projectionType,
    payload,
    sources: orderedSources,
    content,
    content_hash: contentHash,
    projection_id: projectionId,
  };
}

function intersectValidity(sources: GovernedSource[]) {
  const validFrom = sources
    .map((source) => source.validity.valid_from)
    .sort()
    .at(-1);
  const recordedAt = sources
    .map((source) => source.validity.recorded_at)
    .sort()
    .at(-1);
  const finiteValidTo = sources
    .flatMap((source) =>
      source.validity.valid_to === null ? [] : [source.validity.valid_to]
    )
    .sort();
  if (validFrom === undefined || recordedAt === undefined) {
    throw new Error("projection validity requires at least one source");
  }
  return {
    valid_from: validFrom,
    valid_to: finiteValidTo[0] ?? null,
    recorded_at: recordedAt,
  };
}

function strictestSensitivity(
  sources: GovernedSource[],
): GovernedSource["sensitivity"] {
  const sensitivity = [...sources].sort(
    (left, right) =>
      SENSITIVITY_RANK[right.sensitivity] -
      SENSITIVITY_RANK[left.sensitivity],
  )[0]?.sensitivity;
  if (sensitivity === undefined) {
    throw new Error("projection sensitivity requires at least one source");
  }
  return sensitivity;
}

function topicDescriptor(
  input: ProjectionPolicyInput,
  sources: GovernedSource[],
): ProjectionDescriptor {
  const summary = sources
    .map((source) => `${source.kind}: ${sourceText(source)}`)
    .join("\n")
    .slice(0, 8_000);
  return descriptor(
    input.principal_id,
    input.scope,
    "topic",
    {
      kind: "topic",
      key: `${input.scope.kind}:${input.scope.id}`,
      summary,
      open_items: [],
    },
    sources,
  );
}

function scenarioAndProcedureDescriptors(
  input: ProjectionPolicyInput,
  sources: GovernedSource[],
): ProjectionDescriptor[] {
  return sources.flatMap((source) => {
    const text = sourceText(source);
    if (source.kind === "episodic") {
      return [
        descriptor(
          input.principal_id,
          input.scope,
          "scenario",
          {
            kind: "scenario",
            key: source.memory_id,
            trigger: text,
            preconditions: [],
            outcomes: [text],
          },
          [source],
        ),
      ];
    }
    if (source.kind === "procedural") {
      return [
        descriptor(
          input.principal_id,
          input.scope,
          "procedure",
          {
            kind: "procedure",
            key: source.memory_id,
            goal: text,
            preconditions: [],
            steps: [text],
            exceptions: [],
            failure_modes: [],
            recovery_steps: [],
          },
          [source],
        ),
      ];
    }
    return [];
  });
}

function coreDescriptors(
  input: ProjectionPolicyInput,
  sources: GovernedSource[],
): ProjectionDescriptor[] {
  const groups = new Map<string, GovernedSource[]>();
  for (const source of sources) {
    if (source.kind !== "semantic") {
      continue;
    }
    const normalized = sourceText(source)
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/gu, " ");
    groups.set(normalized, [...(groups.get(normalized) ?? []), source]);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, members]) =>
      descriptor(
        input.principal_id,
        input.scope,
        "core",
        {
          kind: "core",
          statement: sourceText(normalizedSourceOrder(members)[0] as GovernedSource),
          applicability: [`${input.scope.kind}:${input.scope.id}`],
          constraints: [
            "Revalidate every source revision before Context use.",
          ],
          confidence: 1,
          promotion_basis: [
            `${members.length} exact governed sources carry the same statement.`,
          ],
        },
        members,
      )
    );
}

function relationDescriptors(
  input: ProjectionPolicyInput,
  sources: GovernedSource[],
): ProjectionDescriptor[] {
  const ordered = [...sources].sort(
    (left, right) =>
      left.validity.valid_from.localeCompare(right.validity.valid_from) ||
      left.revision_id.localeCompare(right.revision_id),
  );
  const results: ProjectionDescriptor[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const source = ordered[index];
    const target = ordered[index + 1];
    if (
      source === undefined ||
      target === undefined ||
      source.validity.valid_from === target.validity.valid_from
    ) {
      continue;
    }
    results.push(
      descriptor(
        input.principal_id,
        input.scope,
        "relation",
        {
          kind: "relation",
          source_revision_id: source.revision_id,
          target_revision_id: target.revision_id,
          relation_type: "precedes",
          direction: "directed",
          description:
            "The source validity window begins before the target window.",
        },
        [source, target],
      ),
    );
  }
  return results;
}

export function buildDeterministicProjections(
  input: ProjectionPolicyInput,
): ProjectionRevision[] {
  const sources = normalizedSourceOrder(input.sources);
  if (sources.length === 0) {
    return [];
  }
  const descriptors = [
    topicDescriptor(input, sources),
    ...scenarioAndProcedureDescriptors(input, sources),
    ...coreDescriptors(input, sources),
    ...relationDescriptors(input, sources),
  ];
  const projectionFrontierHash = canonicalSha256(
    descriptors
      .map((item) => ({
        projection_id: item.projection_id,
        content_hash: item.content_hash,
      }))
      .sort((left, right) =>
        left.projection_id.localeCompare(right.projection_id)
      ),
  );
  const sourceFrontierHash = canonicalSha256(
    sources.map((source) => ({
      revision_id: source.revision_id,
      content_hash: source.content_hash,
    })),
  );
  const frontier = {
    schema_version: "1.0.0",
    ledger_epoch: input.ledger_epoch,
    tombstone_epoch: input.tombstone_epoch,
    projection_epoch: input.projection_epoch,
    transform: PROJECTION_TRANSFORM,
    source_frontier_hash: sourceFrontierHash,
    projection_frontier_hash: projectionFrontierHash,
  } as const;

  return descriptors
    .map((item) => {
      const sourceReferences = item.sources.map((source) =>
        sourceRef(input.principal_id, source)
      );
      const validity = intersectValidity(item.sources);
      const projectionRevisionId =
        `projection-revision:${canonicalSha256({
          projection_id: item.projection_id,
          frontier,
        }).slice("sha256:".length, 48)}`;
      return ProjectionRevisionSchema.parse({
        schema_version: "1.0.0",
        projection_id: item.projection_id,
        projection_revision_id: projectionRevisionId,
        revision: 1,
        projection_type: item.projection_type,
        abstraction:
          item.projection_type === "topic"
            ? "l2_topic"
            : item.projection_type === "relation"
              ? "l2_relation"
              : item.projection_type === "core"
                ? "l3_core"
                : "l2_scenario",
        principal_id: input.principal_id,
        scope: input.scope,
        lifecycle: "active",
        authority: "derived",
        sensitivity: strictestSensitivity(item.sources),
        validity,
        payload: item.payload,
        content: item.content,
        content_hash: item.content_hash,
        source_revisions: sourceReferences,
        evidence_ids: uniqueSorted(
          sourceReferences.flatMap((source) => source.evidence_ids),
        ),
        supersedes_projection_revision_id: null,
        transform: PROJECTION_TRANSFORM,
        frontier,
        created_at: validity.recorded_at,
        invalidated_at: null,
        invalidation_reason: null,
      });
    })
    .sort(
      (left, right) =>
        left.projection_type.localeCompare(right.projection_type) ||
        left.projection_id.localeCompare(right.projection_id),
    );
}

export function emptyProjectionFrontier(input: {
  ledger_epoch: number;
  tombstone_epoch: number;
  projection_epoch: number;
}) {
  return {
    schema_version: "1.0.0",
    ledger_epoch: input.ledger_epoch,
    tombstone_epoch: input.tombstone_epoch,
    projection_epoch: input.projection_epoch,
    transform: PROJECTION_TRANSFORM,
    source_frontier_hash: canonicalSha256([]),
    projection_frontier_hash: canonicalSha256([]),
  } as const;
}

export function projectionStructuralDigest(
  projections: ProjectionRevision[],
): `sha256:${string}` {
  return canonicalSha256(
    [...projections]
      .map((projection) => ({
        projection_id: projection.projection_id,
        projection_revision_id: projection.projection_revision_id,
        projection_type: projection.projection_type,
        content_hash: projection.content_hash,
        source_revision_ids: projection.source_revisions
          .map((source) => source.revision_id)
          .sort(),
        relation:
          projection.payload?.kind === "relation"
            ? projection.payload
            : null,
        frontier: projection.frontier,
      }))
      .sort((left, right) =>
        left.projection_id.localeCompare(right.projection_id)
      ),
  );
}

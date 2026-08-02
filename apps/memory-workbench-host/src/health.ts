import {
  WorkbenchHealthComponentSchema,
  WorkbenchHealthLaneSchema,
  WorkbenchHealthResultSchema,
  type OperationalStatus,
  type WorkbenchHealthComponent,
  type WorkbenchHealthResult,
} from "@memo-graph/contracts";
import type { BackgroundLaneObservation } from "@memo-graph/runtime-host";
import type { GraphProjectionStatus } from "@memo-graph/storage-sqlite";

type ComponentId = WorkbenchHealthComponent["component"];
type Plane = WorkbenchHealthComponent["authority_plane"];

function observationScope(component: ComponentId) {
  if (component === "canonical_storage") return "canonical_root" as const;
  if (component === "runtime_owner" || component === "background_work") {
    return "runtime_instance" as const;
  }
  return "configured_scopes" as const;
}

const STATE_REASON = {
  lagging: "OBSERVATION_LAGGING",
  degraded: "COMPONENT_DEGRADED",
  failed: "COMPONENT_FAILED",
  unavailable: "OBSERVATION_UNAVAILABLE",
} as const;

function unavailable(
  component: ComponentId,
  authorityPlane: Plane,
  reasonCode: string,
  guidanceCode: WorkbenchHealthComponent["guidance_code"],
): WorkbenchHealthComponent {
  return WorkbenchHealthComponentSchema.parse({
    component,
    authority_plane: authorityPlane,
    observation_scope: observationScope(component),
    state: "unavailable",
    observed_at: null,
    reason_code: reasonCode,
    guidance_code: guidanceCode,
    metrics: [],
  });
}

function fromOperational(
  status: OperationalStatus,
  source: "canonical_store" | "fts" | "layered_projection",
  component: ComponentId,
  authorityPlane: Plane,
): WorkbenchHealthComponent {
  const observation = status.components.find(
    (candidate) => candidate.component === source,
  );
  if (observation === undefined) {
    return unavailable(
      component,
      authorityPlane,
      `${source.toUpperCase()}_OBSERVATION_MISSING`,
      source === "canonical_store"
        ? "PROTECT_CANONICAL_DATA"
        : "INSPECT_PROJECTION_LOGS",
    );
  }
  const state = (() => {
    switch (observation.state) {
      case "ready":
      case "active":
        return "healthy" as const;
      case "rebuilding":
        return "lagging" as const;
      case "degraded":
      case "read_only":
        return "degraded" as const;
      case "blocked":
        return "failed" as const;
      case "disabled":
        return "unavailable" as const;
    }
  })();
  const reasonCode = state === "healthy"
    ? null
    : observation.reason_code ?? STATE_REASON[state];
  const guidanceCode = state === "healthy"
    ? "NONE"
    : source === "canonical_store"
      ? "PROTECT_CANONICAL_DATA"
      : state === "lagging"
        ? "WAIT_FOR_PROJECTION"
        : "INSPECT_PROJECTION_LOGS";
  return WorkbenchHealthComponentSchema.parse({
    component,
    authority_plane: authorityPlane,
    observation_scope: observationScope(component),
    state,
    observed_at: status.observed_at,
    reason_code: reasonCode,
    guidance_code: guidanceCode,
    metrics: observation.measurements.map(({ name, value, unit }) => ({
      name,
      value,
      unit,
    })),
  });
}

function runtimeComponent(input: {
  runtimeState: "ready" | "health_only";
  lifecycle: "ready" | "draining" | "stopped" | null;
  observedAt: string;
}): WorkbenchHealthComponent {
  if (input.runtimeState !== "ready" || input.lifecycle === null) {
    return unavailable(
      "runtime_owner",
      "runtime",
      "RUNTIME_OWNER_UNAVAILABLE",
      "REOPEN_WORKBENCH",
    );
  }
  const healthy = input.lifecycle === "ready";
  return WorkbenchHealthComponentSchema.parse({
    component: "runtime_owner",
    authority_plane: "runtime",
    observation_scope: "runtime_instance",
    state: healthy ? "healthy" : "degraded",
    observed_at: input.observedAt,
    reason_code: healthy ? null : "RUNTIME_DRAINING",
    guidance_code: healthy ? "NONE" : "REOPEN_WORKBENCH",
    metrics: [],
  });
}

function laneObservation(lane: BackgroundLaneObservation) {
  const state = lane.terminal > 0 || lane.state === "terminal"
    ? "failed"
    : lane.consecutive_failures > 0 || lane.retrying > 0 || lane.state === "retrying"
      ? "lagging"
      : lane.state === "stopped"
        ? "unavailable"
        : "healthy";
  return WorkbenchHealthLaneSchema.parse({
    lane: lane.lane,
    state,
    in_flight: lane.in_flight,
    observed_at: lane.observed_at,
    last_success_at: lane.last_success_at,
    reason_code:
      state === "healthy"
        ? null
        : lane.last_failure_code ??
          (state === "failed"
            ? "BACKGROUND_TERMINAL_FAILURE"
            : state === "lagging"
              ? "BACKGROUND_RETRYING"
              : "BACKGROUND_STOPPED"),
    claimed: lane.claimed,
    completed: lane.completed,
    failed: lane.failed,
    retrying: lane.retrying,
    terminal: lane.terminal,
  });
}

function backgroundComponent(
  lanes: ReturnType<typeof laneObservation>[],
  observedAt: string,
): WorkbenchHealthComponent {
  if (lanes.length === 0) {
    return unavailable(
      "background_work",
      "worker",
      "BACKGROUND_OBSERVATION_MISSING",
      "INSPECT_BACKGROUND_LOGS",
    );
  }
  const state = lanes.some((lane) => lane.state === "failed")
    ? "failed"
    : lanes.some((lane) => lane.state === "lagging")
      ? "lagging"
      : lanes.some((lane) => lane.state === "unavailable")
        ? "degraded"
        : "healthy";
  return WorkbenchHealthComponentSchema.parse({
    component: "background_work",
    authority_plane: "worker",
    observation_scope: "runtime_instance",
    state,
    observed_at: observedAt,
    reason_code:
      state === "healthy"
        ? null
        : state === "failed"
          ? "BACKGROUND_TERMINAL_FAILURE"
          : state === "lagging"
            ? "BACKGROUND_RETRYING"
            : "BACKGROUND_PARTIALLY_UNAVAILABLE",
    guidance_code:
      state === "healthy" ? "NONE" : "INSPECT_BACKGROUND_LOGS",
    metrics: [
      { name: "lane_count", value: lanes.length, unit: "count" },
      {
        name: "completed",
        value: lanes.reduce((sum, lane) => sum + lane.completed, 0),
        unit: "count",
      },
      {
        name: "failed",
        value: lanes.reduce((sum, lane) => sum + lane.failed, 0),
        unit: "count",
      },
      {
        name: "retrying",
        value: lanes.reduce((sum, lane) => sum + lane.retrying, 0),
        unit: "count",
      },
      {
        name: "terminal",
        value: lanes.reduce((sum, lane) => sum + lane.terminal, 0),
        unit: "count",
      },
    ],
  });
}

function graphComponent(input: {
  graph: GraphProjectionStatus | null;
  lanes: ReturnType<typeof laneObservation>[];
  observedAt: string;
}): WorkbenchHealthComponent {
  const lane = input.lanes.find(({ lane }) => lane === "graph_projection");
  if (lane === undefined || input.graph === null) {
    return unavailable(
      "graph_projection",
      "projection",
      "GRAPH_PROJECTION_NOT_CONFIGURED",
      "CHECK_RUNTIME_CONFIG",
    );
  }
  const state = input.graph.outbox_terminal > 0 || lane.state === "failed"
    ? "failed"
    : input.graph.unavailable_scopes > 0
      ? "degraded"
      : input.graph.pending_scopes > 0 ||
          input.graph.outbox_pending > 0 ||
          input.graph.outbox_retrying > 0 ||
          lane.state === "lagging"
        ? "lagging"
        : input.graph.scope_states === 0
          ? "unavailable"
          : "healthy";
  return WorkbenchHealthComponentSchema.parse({
    component: "graph_projection",
    authority_plane: "projection",
    observation_scope: "configured_scopes",
    state,
    observed_at: input.observedAt,
    reason_code:
      state === "healthy"
        ? null
        : state === "failed"
          ? "GRAPH_PROJECTION_FAILED"
          : state === "lagging"
            ? "GRAPH_PROJECTION_LAGGING"
            : state === "degraded"
              ? "GRAPH_PROJECTION_DEGRADED"
              : "GRAPH_SCOPE_OBSERVATION_MISSING",
    guidance_code:
      state === "healthy"
        ? "NONE"
        : state === "lagging"
          ? "WAIT_FOR_PROJECTION"
          : "INSPECT_PROJECTION_LOGS",
    metrics:
      state === "unavailable"
        ? []
        : [
            { name: "scope_count", value: input.graph.scope_states, unit: "count" },
            { name: "ready_scopes", value: input.graph.ready_scopes, unit: "count" },
            { name: "pending_scopes", value: input.graph.pending_scopes, unit: "count" },
            { name: "unavailable_scopes", value: input.graph.unavailable_scopes, unit: "count" },
            { name: "outbox_pending", value: input.graph.outbox_pending, unit: "count" },
            { name: "outbox_terminal", value: input.graph.outbox_terminal, unit: "count" },
          ],
  });
}

export function workbenchHealth(input: {
  runtimeState: "ready" | "health_only";
  operational: OperationalStatus;
  lifecycle: "ready" | "draining" | "stopped" | null;
  background: BackgroundLaneObservation[];
  graph: GraphProjectionStatus | null;
  observedAt: string;
}): WorkbenchHealthResult {
  const lanes = input.background.map(laneObservation).sort((left, right) =>
    left.lane.localeCompare(right.lane)
  );
  const canonical = fromOperational(
    input.operational,
    "canonical_store",
    "canonical_storage",
    "canonical",
  );
  const runtime = runtimeComponent(input);
  const projections = [
    fromOperational(
      input.operational,
      "fts",
      "fts_projection",
      "projection",
    ),
    fromOperational(
      input.operational,
      "layered_projection",
      "layered_projection",
      "projection",
    ),
    graphComponent({
      graph: input.graph,
      lanes,
      observedAt: input.observedAt,
    }),
  ];
  const background = backgroundComponent(lanes, input.observedAt);
  const staleAfter = new Date(Date.parse(input.observedAt) + 15_000).toISOString();
  return WorkbenchHealthResultSchema.parse({
    status: "ready",
    observed_at: input.observedAt,
    stale_after: staleAfter,
    runtime_state: input.runtimeState,
    canonical,
    runtime,
    projections,
    background,
    lanes,
    warnings: [
      ...(canonical.state === "healthy" ? [] : ["canonical_authority_unhealthy"]),
      ...(runtime.state === "healthy" ? [] : ["runtime_owner_unavailable"]),
      ...(projections.some(({ state }) => state !== "healthy")
        ? ["derived_projection_attention"]
        : []),
      ...(background.state === "healthy" ? [] : ["background_work_attention"]),
    ],
  });
}

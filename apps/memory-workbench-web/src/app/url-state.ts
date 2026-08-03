export const WORKBENCH_VIEWS = ["memory", "automatic", "graph", "runtime"] as const;
export type WorkbenchView = (typeof WORKBENCH_VIEWS)[number];

export type StructuralUrlState = {
  view: WorkbenchView;
  scopeKind:
    | "thread"
    | "topic"
    | "scenario"
    | "user"
    | "workspace"
    | "agent"
    | null;
  scopeId: string | null;
  selectedMemoryId: string | null;
  selectedRevisionId: string | null;
  graphCenterKind: "memory_revision" | "projection_revision" | null;
  graphCenterRevisionId: string | null;
  includeNonCurrent: boolean;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SCOPE_KINDS = new Set([
  "thread",
  "topic",
  "scenario",
  "user",
  "workspace",
  "agent",
]);
const ALLOWED_KEYS = new Set([
  "view",
  "scope_kind",
  "scope_id",
  "memory_id",
  "revision_id",
  "graph_center_kind",
  "graph_revision_id",
  "include_non_current",
]);

export function parseStructuralUrl(url: URL): {
  state: StructuralUrlState;
  sanitizedUrl: URL;
  changed: boolean;
} {
  const source = url.searchParams;
  const sanitizedUrl = new URL(url.href);
  sanitizedUrl.search = "";

  const rawView = source.get("view");
  const view = isWorkbenchView(rawView) ? rawView : "memory";
  if (view !== "memory") {
    sanitizedUrl.searchParams.set("view", view);
  }

  const rawScopeKind = source.get("scope_kind");
  const rawScopeId = source.get("scope_id");
  const scopeKind =
    rawScopeKind !== null && SCOPE_KINDS.has(rawScopeKind)
      ? (rawScopeKind as StructuralUrlState["scopeKind"])
      : null;
  const scopeId = rawScopeId !== null && IDENTIFIER.test(rawScopeId) ? rawScopeId : null;
  if (scopeKind !== null && scopeId !== null) {
    sanitizedUrl.searchParams.set("scope_kind", scopeKind);
    sanitizedUrl.searchParams.set("scope_id", scopeId);
  }

  const rawMemoryId = source.get("memory_id");
  const selectedMemoryId =
    rawMemoryId !== null && IDENTIFIER.test(rawMemoryId) ? rawMemoryId : null;
  if (selectedMemoryId !== null) {
    sanitizedUrl.searchParams.set("memory_id", selectedMemoryId);
  }
  const rawRevisionId = source.get("revision_id");
  const selectedRevisionId =
    selectedMemoryId !== null &&
    rawRevisionId !== null &&
    IDENTIFIER.test(rawRevisionId)
      ? rawRevisionId
      : null;
  if (selectedRevisionId !== null) {
    sanitizedUrl.searchParams.set("revision_id", selectedRevisionId);
  }
  const rawGraphCenterKind = source.get("graph_center_kind");
  const rawGraphRevisionId = source.get("graph_revision_id");
  const graphCenterKind =
    rawGraphCenterKind === "memory_revision" ||
    rawGraphCenterKind === "projection_revision"
      ? rawGraphCenterKind
      : null;
  const graphCenterRevisionId =
    graphCenterKind !== null &&
    rawGraphRevisionId !== null &&
    IDENTIFIER.test(rawGraphRevisionId)
      ? rawGraphRevisionId
      : null;
  if (graphCenterKind !== null && graphCenterRevisionId !== null) {
    sanitizedUrl.searchParams.set("graph_center_kind", graphCenterKind);
    sanitizedUrl.searchParams.set("graph_revision_id", graphCenterRevisionId);
  }

  const includeNonCurrent = source.get("include_non_current") === "1";
  if (includeNonCurrent) {
    sanitizedUrl.searchParams.set("include_non_current", "1");
  }

  const unknownKey = [...source.keys()].some((key) => !ALLOWED_KEYS.has(key));
  return {
    state: {
      view,
      scopeKind: scopeKind !== null && scopeId !== null ? scopeKind : null,
      scopeId: scopeKind !== null && scopeId !== null ? scopeId : null,
      selectedMemoryId,
      selectedRevisionId,
      graphCenterKind:
        graphCenterRevisionId === null ? null : graphCenterKind,
      graphCenterRevisionId,
      includeNonCurrent,
    },
    sanitizedUrl,
    changed: unknownKey || normalizedSearch(url) !== normalizedSearch(sanitizedUrl),
  };
}

export function urlForView(url: URL, view: WorkbenchView): URL {
  const { sanitizedUrl } = parseStructuralUrl(url);
  if (view === "memory") {
    sanitizedUrl.searchParams.delete("view");
  } else {
    sanitizedUrl.searchParams.set("view", view);
  }
  return sanitizedUrl;
}

export function urlForMemoryStructure(
  url: URL,
  input: {
    scope: { kind: StructuralUrlState["scopeKind"]; id: string } | null;
    selectedMemoryId: string | null;
    selectedRevisionId: string | null;
    includeNonCurrent: boolean;
  },
): URL {
  const { sanitizedUrl } = parseStructuralUrl(url);
  sanitizedUrl.searchParams.delete("view");
  for (const key of [
    "scope_kind",
    "scope_id",
    "memory_id",
    "revision_id",
    "graph_center_kind",
    "graph_revision_id",
    "include_non_current",
  ]) {
    sanitizedUrl.searchParams.delete(key);
  }
  if (
    input.scope !== null &&
    input.scope.kind !== null &&
    IDENTIFIER.test(input.scope.id)
  ) {
    sanitizedUrl.searchParams.set("scope_kind", input.scope.kind);
    sanitizedUrl.searchParams.set("scope_id", input.scope.id);
  }
  if (
    input.selectedMemoryId !== null &&
    IDENTIFIER.test(input.selectedMemoryId)
  ) {
    sanitizedUrl.searchParams.set("memory_id", input.selectedMemoryId);
    if (
      input.selectedRevisionId !== null &&
      IDENTIFIER.test(input.selectedRevisionId)
    ) {
      sanitizedUrl.searchParams.set("revision_id", input.selectedRevisionId);
    }
  }
  if (input.includeNonCurrent) {
    sanitizedUrl.searchParams.set("include_non_current", "1");
  }
  return sanitizedUrl;
}

export function urlForGraphCenter(
  url: URL,
  input: {
    scope: { kind: NonNullable<StructuralUrlState["scopeKind"]>; id: string };
    center: {
      kind: NonNullable<StructuralUrlState["graphCenterKind"]>;
      revisionId: string;
    };
  },
): URL {
  const { sanitizedUrl } = parseStructuralUrl(url);
  for (const key of [
    "memory_id",
    "revision_id",
    "graph_center_kind",
    "graph_revision_id",
  ]) {
    sanitizedUrl.searchParams.delete(key);
  }
  sanitizedUrl.searchParams.set("view", "graph");
  sanitizedUrl.searchParams.set("scope_kind", input.scope.kind);
  sanitizedUrl.searchParams.set("scope_id", input.scope.id);
  if (IDENTIFIER.test(input.center.revisionId)) {
    sanitizedUrl.searchParams.set("graph_center_kind", input.center.kind);
    sanitizedUrl.searchParams.set("graph_revision_id", input.center.revisionId);
  }
  return sanitizedUrl;
}

function isWorkbenchView(value: string | null): value is WorkbenchView {
  return value !== null && WORKBENCH_VIEWS.some((candidate) => candidate === value);
}

function normalizedSearch(url: URL): string {
  const entries = [...url.searchParams.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return new URLSearchParams(entries).toString();
}

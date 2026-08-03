import type { Core } from "cytoscape";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  WorkbenchGraphResult,
  WorkbenchMemorySummary,
} from "@memo-graph/contracts/workbench";

import { RequestCoordinator } from "../../api/request-coordinator.js";
import type { StructuralUrlState } from "../../app/url-state.js";
import type { MemoryWorkbenchApi } from "../memories/api.js";

type ReadyGraph = Extract<
  WorkbenchGraphResult,
  { status: "ready" | "ready_empty" | "degraded" }
>;
type GraphNode = ReadyGraph["nodes"][number];
type GraphEdge = ReadyGraph["edges"][number];

export function GraphExplorer({
  api,
  structure,
  onCenterChange,
  onOpenMemory,
}: {
  api: MemoryWorkbenchApi;
  structure: StructuralUrlState;
  onCenterChange(
    scope: GraphNode["scope"],
    center: {
      kind: "memory_revision" | "projection_revision";
      revisionId: string;
    },
  ): void;
  onOpenMemory(memoryId: string, revisionId: string, scope: GraphNode["scope"]): void;
}) {
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<readonly WorkbenchMemorySummary[]>([]);
  const [candidateState, setCandidateState] = useState<"loading" | "ready" | "empty" | "failed">("loading");
  const [graph, setGraph] = useState<WorkbenchGraphResult | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const listCoordinator = useRef(new RequestCoordinator());
  const graphCoordinator = useRef(new RequestCoordinator());
  const seededRevision = useRef<string | null>(null);

  useEffect(() => {
    setCandidateState("loading");
    void listCoordinator.current.run((signal) =>
      api.listMemories(
        {
          query: appliedSearch,
          scope: null,
          include_non_current: false,
          limit: 40,
        },
        signal,
      )
    ).then((result) => {
      if (result.status === "superseded") return;
      if (result.value.status === "ready" || result.value.status === "degraded") {
        setCandidates(result.value.items);
        setCandidateState(result.value.items.length === 0 ? "empty" : "ready");
      } else {
        setCandidates([]);
        setCandidateState(
          result.value.status === "ready_empty" ||
          result.value.status === "filtered_empty"
            ? "empty"
            : "failed",
        );
      }
    }).catch(() => {
      setCandidates([]);
      setCandidateState("failed");
    });
    return () => listCoordinator.current.cancel();
  }, [api, appliedSearch]);

  useEffect(() => {
    if (
      structure.graphCenterKind !== null ||
      structure.selectedRevisionId === null ||
      seededRevision.current === structure.selectedRevisionId
    ) {
      return;
    }
    const selected = candidates.find(
      (candidate) => candidate.revision_id === structure.selectedRevisionId,
    );
    if (selected !== undefined) {
      seededRevision.current = selected.revision_id;
      onCenterChange(selected.scope, {
        kind: "memory_revision",
        revisionId: selected.revision_id,
      });
    }
  }, [candidates, onCenterChange, structure.graphCenterKind, structure.selectedRevisionId]);

  useEffect(() => {
    const scopeKind = structure.scopeKind;
    const scopeId = structure.scopeId;
    const centerKind = structure.graphCenterKind;
    const centerRevisionId = structure.graphCenterRevisionId;
    if (
      scopeKind === null ||
      scopeId === null ||
      centerKind === null ||
      centerRevisionId === null
    ) {
      graphCoordinator.current.cancel();
      setGraph(null);
      setGraphLoading(false);
      return;
    }
    setGraphLoading(true);
    void graphCoordinator.current.run((signal) =>
      api.graph(
        {
          scope: { kind: scopeKind, id: scopeId },
          center: {
            kind: centerKind,
            revision_id: centerRevisionId,
          },
          max_depth: 2,
          max_fanout: 20,
          max_nodes: 80,
          max_edges: 120,
        },
        signal,
      )
    ).then((result) => {
      if (result.status === "superseded") return;
      setGraph(result.value);
      setSelectedNodeId(
        result.value.status === "ready" ||
        result.value.status === "ready_empty" ||
        result.value.status === "degraded"
          ? result.value.center_node_id
          : null,
      );
      setSelectedEdgeId(null);
      setGraphLoading(false);
    }).catch(() => {
      setGraph({
        status: "failed",
        reason_code: "GRAPH_REQUEST_FAILED",
        retryable: true,
        warnings: [],
      });
      setGraphLoading(false);
    });
    return () => graphCoordinator.current.cancel();
  }, [
    api,
    structure.graphCenterKind,
    structure.graphCenterRevisionId,
    structure.scopeId,
    structure.scopeKind,
  ]);

  const ready = isReadyGraph(graph) ? graph : null;
  const selectedNode = ready?.nodes.find((node) => node.node_id === selectedNodeId) ?? null;
  const selectedEdge = ready?.edges.find((edge) => edge.edge_id === selectedEdgeId) ?? null;

  return (
    <section className="graph-explorer" aria-labelledby="graph-heading">
      <header className="feature-intro graph-intro">
        <p className="eyebrow">BOUNDED · EXPLAINABLE · READ ONLY</p>
        <h2 id="graph-heading">关系图谱</h2>
        <p>Graph 只解释真实 revision、projection lineage 与受治理 relation；画布和语义列表表达同一份有界快照。</p>
      </header>

      <form
        className="graph-picker"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setAppliedSearch(searchDraft.trim() || null);
        }}
        role="search"
      >
        <label className="search-field">
          <span>查找 Graph 中心记忆</span>
          <input
            autoComplete="off"
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="搜索文本只进入认证请求"
            type="search"
            value={searchDraft}
          />
          <small>中心选择只写入 revision id 与 exact scope；搜索文本不进入 URL。</small>
        </label>
        <button className="button-primary" type="submit">查找中心</button>
      </form>

      {structure.graphCenterRevisionId === null ? (
        <CenterPicker
          candidates={candidates}
          state={candidateState}
          onSelect={(memory) => onCenterChange(memory.scope, {
            kind: "memory_revision",
            revisionId: memory.revision_id,
          })}
        />
      ) : null}

      {graphLoading ? <p className="graph-state" role="status">正在验证并组合有界 Graph…</p> : null}
      {!graphLoading && graph !== null && !isReadyGraph(graph) ? (
        <div className="graph-state" role="status">
          <strong>{graph.status === "governance_excluded" ? "Graph 受治理规则限制" : "Graph 当前不可用"}</strong>
          <p>{graph.reason_code}</p>
        </div>
      ) : null}

      {ready === null ? null : (
        <>
          <GraphBoundary graph={ready} />
          <div className="graph-layout">
            <div className="graph-surface">
              <GraphCanvas
                graph={ready}
                selectedEdgeId={selectedEdgeId}
                selectedNodeId={selectedNodeId}
                onSelectEdge={(edgeId) => {
                  setSelectedEdgeId(edgeId);
                  setSelectedNodeId(null);
                }}
                onSelectNode={(nodeId) => {
                  setSelectedNodeId(nodeId);
                  setSelectedEdgeId(null);
                }}
              />
              <SemanticGraph
                graph={ready}
                onSelectEdge={(edgeId) => {
                  setSelectedEdgeId(edgeId);
                  setSelectedNodeId(null);
                }}
                onSelectNode={(nodeId) => {
                  setSelectedNodeId(nodeId);
                  setSelectedEdgeId(null);
                }}
              />
            </div>
            <GraphSelection
              edge={selectedEdge}
              node={selectedNode}
              onOpenMemory={onOpenMemory}
              onRecenter={(node) => onCenterChange(node.scope, {
                kind: node.kind === "memory_revision"
                  ? "memory_revision"
                  : "projection_revision",
                revisionId: node.revision_id,
              })}
            />
          </div>
        </>
      )}
    </section>
  );
}

function CenterPicker({
  candidates,
  state,
  onSelect,
}: {
  candidates: readonly WorkbenchMemorySummary[];
  state: "loading" | "ready" | "empty" | "failed";
  onSelect(memory: WorkbenchMemorySummary): void;
}) {
  return (
    <div className="center-picker" aria-labelledby="center-picker-heading">
      <div className="section-heading">
        <div><p className="eyebrow">CENTER PICKER</p><h3 id="center-picker-heading">选择一个真实 revision</h3></div>
        <span>{candidates.length} 个候选</span>
      </div>
      {state === "loading" ? <p role="status">正在读取可用中心…</p> : null}
      {state === "empty" ? <p role="status">当前查询没有可作为中心的记忆。</p> : null}
      {state === "failed" ? <p role="status">无法读取中心候选；Graph 不会伪造默认节点。</p> : null}
      {state === "ready" ? (
        <ul className="center-list">
          {candidates.map((memory) => (
            <li key={memory.revision_id}>
              <button onClick={() => onSelect(memory)} type="button">
                <strong>{memory.content.status === "available" ? memory.content.text : `内容不可用 · ${memory.content.reason_code}`}</strong>
                <code>{memory.scope.kind}:{memory.scope.id}</code>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GraphBoundary({ graph }: { graph: ReadyGraph }) {
  return (
    <div className="graph-boundary" data-state={graph.status}>
      <div><span>节点</span><strong>{graph.nodes.length}</strong></div>
      <div><span>关系</span><strong>{graph.edges.length}</strong></div>
      <div><span>Projection</span><strong>{graph.projection_state}</strong></div>
      <div><span>边界</span><strong>{graph.truncated ? `省略 ${graph.omitted_node_count + graph.omitted_edge_count}` : "完整快照"}</strong></div>
      {graph.status === "degraded" ? <p role="status">Graph 处于降级解释模式；canonical 记忆仍可独立查看。</p> : null}
      {graph.status === "ready_empty" ? <p role="status">中心已验证，但当前没有受治理关系。</p> : null}
    </div>
  );
}

function GraphCanvas({
  graph,
  selectedEdgeId,
  selectedNodeId,
  onSelectEdge,
  onSelectNode,
}: {
  graph: ReadyGraph;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
  onSelectEdge(edgeId: string): void;
  onSelectNode(nodeId: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Core | null>(null);
  const [canvasState, setCanvasState] = useState<"loading" | "ready" | "failed">("loading");
  const selectEdge = useRef(onSelectEdge);
  const selectNode = useRef(onSelectNode);
  useEffect(() => {
    selectEdge.current = onSelectEdge;
    selectNode.current = onSelectNode;
  }, [onSelectEdge, onSelectNode]);
  useEffect(() => {
    if (container.current === null) return;
    const host = container.current;
    let disposed = false;
    let mounted: Core | null = null;
    setCanvasState("loading");
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed) return;
      const cy = cytoscape({
        container: host,
        elements: [
          ...graph.nodes.map((node) => ({
            data: { id: node.node_id, label: shortLabel(node.label), kind: node.kind },
          })),
          ...graph.edges.map((edge) => ({
            data: {
              id: edge.edge_id,
              source: edge.from_node_id,
              target: edge.to_node_id,
              label: edge.relation,
              plane: edge.authority_plane,
            },
          })),
        ],
        style: [
          { selector: "node", style: { "background-color": "#c7f36b", color: "#f4f6ef", label: "data(label)", "font-family": "Geist Mono", "font-size": "10px", "text-wrap": "wrap", "text-max-width": "120px", "text-valign": "bottom", "text-margin-y": 8, width: 30, height: 30 } },
          { selector: 'node[kind = "memory_revision"]', style: { shape: "round-rectangle", "background-color": "#f0f2eb", "border-color": "#7d8c70", "border-width": 2 } },
          { selector: "edge", style: { width: 1.5, "line-color": "#66705f", "target-arrow-color": "#66705f", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: "#a8b29f", "font-size": "8px", "text-background-color": "#111411", "text-background-opacity": 0.85, "text-background-padding": "3px" } },
          { selector: 'edge[plane = "governed_relation"]', style: { "line-color": "#c7f36b", "target-arrow-color": "#c7f36b" } },
          { selector: ":selected", style: { "border-color": "#ffb86b", "border-width": 4, "line-color": "#ffb86b", "target-arrow-color": "#ffb86b" } },
        ],
        layout: { name: "breadthfirst", directed: true, animate: false, spacingFactor: 1.4 },
        autoungrabify: true,
        boxSelectionEnabled: false,
        minZoom: 0.4,
        maxZoom: 2.2,
      });
      cy.on("tap", "node", (event) => selectNode.current(event.target.id()));
      cy.on("tap", "edge", (event) => selectEdge.current(event.target.id()));
      mounted = cy;
      instance.current = cy;
      setCanvasState("ready");
    }).catch(() => {
      if (!disposed) setCanvasState("failed");
    });
    return () => {
      disposed = true;
      if (instance.current === mounted) instance.current = null;
      mounted?.destroy();
    };
  }, [graph]);
  useEffect(() => {
    const cy = instance.current;
    if (cy === null) return;
    cy.elements().unselect();
    const id = selectedNodeId ?? selectedEdgeId;
    if (id !== null) cy.$id(id).select();
  }, [selectedEdgeId, selectedNodeId]);
  return (
    <>
      <div aria-hidden="true" className="graph-canvas" data-state={canvasState} ref={container} />
      {canvasState === "failed" ? (
        <p className="graph-canvas-fallback" role="status">
          视觉图层加载失败；下方语义列表仍可完整检查和导航。
        </p>
      ) : null}
    </>
  );
}

function SemanticGraph({
  graph,
  onSelectEdge,
  onSelectNode,
}: {
  graph: ReadyGraph;
  onSelectEdge(edgeId: string): void;
  onSelectNode(nodeId: string): void;
}) {
  const labels = useMemo(() => new Map(graph.nodes.map((node) => [node.node_id, node.label])), [graph.nodes]);
  return (
    <div className="semantic-graph" aria-label="Graph 的完整键盘语义表示">
      <section><h3>节点</h3><ul>{graph.nodes.map((node) => <li key={node.node_id}><button onClick={() => onSelectNode(node.node_id)} type="button"><span>{nodeKindLabel(node.kind)}</span><strong>{node.label}</strong></button></li>)}</ul></section>
      <section><h3>关系</h3>{graph.edges.length === 0 ? <p>没有受治理关系。</p> : <ul>{graph.edges.map((edge) => <li key={edge.edge_id}><button onClick={() => onSelectEdge(edge.edge_id)} type="button"><strong>{labels.get(edge.from_node_id)} → {edge.relation} → {labels.get(edge.to_node_id)}</strong><span>{edge.authority_plane}</span></button></li>)}</ul>}</section>
    </div>
  );
}

function GraphSelection({
  edge,
  node,
  onOpenMemory,
  onRecenter,
}: {
  edge: GraphEdge | null;
  node: GraphNode | null;
  onOpenMemory(memoryId: string, revisionId: string, scope: GraphNode["scope"]): void;
  onRecenter(node: GraphNode): void;
}) {
  if (edge !== null) {
    return <aside className="graph-selection" aria-label="所选关系"><p className="eyebrow">SELECTED RELATION</p><h3>{edge.relation}</h3><dl className="compact-facts"><div><dt>权威平面</dt><dd>{edge.authority_plane}</dd></div><div><dt>来源</dt><dd><code>{edge.source_reference_id}</code></dd></div><div><dt>方向</dt><dd>{edge.direction}</dd></div></dl><p>{edge.description ?? "此关系没有额外描述；语义以类型和来源 revision 为准。"}</p></aside>;
  }
  if (node === null) {
    return <aside className="graph-selection" aria-label="Graph 选择"><p>从画布或语义列表选择一个节点或关系。</p></aside>;
  }
  return (
    <aside className="graph-selection" aria-label="所选节点">
      <p className="eyebrow">SELECTED NODE</p><h3>{node.label}</h3>
      <dl className="compact-facts"><div><dt>类型</dt><dd>{nodeKindLabel(node.kind)}</dd></div><div><dt>权威平面</dt><dd>{node.authority_plane}</dd></div><div><dt>Revision</dt><dd><code>{node.revision_id}</code></dd></div><div><dt>状态</dt><dd>{node.is_current ? "当前" : "历史"} · {node.lifecycle}</dd></div></dl>
      <p>{node.content.status === "available" ? node.content.text : `内容不可用 · ${node.content.reason_code}`}</p>
      <div className="graph-selection-actions">
        <button onClick={() => onRecenter(node)} type="button">以此节点为中心</button>
        {node.kind === "memory_revision" ? <button className="button-primary" onClick={() => onOpenMemory(node.reference_id, node.revision_id, node.scope)} type="button">在记忆中查看</button> : null}
      </div>
    </aside>
  );
}

function isReadyGraph(value: WorkbenchGraphResult | null): value is ReadyGraph {
  return value !== null && ["ready", "ready_empty", "degraded"].includes(value.status);
}

function shortLabel(value: string): string {
  return value.length > 36 ? `${value.slice(0, 34)}…` : value;
}

function nodeKindLabel(kind: GraphNode["kind"]): string {
  return kind === "memory_revision" ? "Canonical memory" : `${kind} projection`;
}

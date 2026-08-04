import type { Network } from "vis-network/standalone/esm";
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

const GRAPH_KIND_COLORS = {
  memory_revision: "#d7d3c7",
  topic: "#74c7c1",
  scenario: "#f29a57",
  procedure: "#a99ad1",
  core: "#ee7d88",
} as const satisfies Record<GraphNode["kind"], string>;

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
  const instance = useRef<Network | null>(null);
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
    let mounted: Network | null = null;
    setCanvasState("loading");
    void import("vis-network/standalone/esm").then(({ DataSet, Network: VisNetwork }) => {
      if (disposed) return;
      const degrees = graphDegrees(graph);
      const showEveryLabel = graph.nodes.length <= 18;
      const nodes = new DataSet(graph.nodes.map((node) => {
        const color = GRAPH_KIND_COLORS[node.kind];
        const degree = degrees.get(node.node_id) ?? 0;
        const prominent = showEveryLabel || degree >= 3 || node.node_id === graph.center_node_id;
        return {
          id: node.node_id,
          label: prominent ? visibleGraphLabel(node.label) : "",
          title: safeGraphTooltip(`${nodeKindLabel(node.kind)} · ${node.label}`),
          group: node.kind,
          value: Math.max(1, degree),
          shape: "dot",
          size: node.node_id === graph.center_node_id ? 25 : nodeSize(degree),
          borderWidth: node.authority_plane === "canonical" ? 3 : 1.25,
          color: {
            background: color,
            border: node.authority_plane === "canonical" ? "#f1efe7" : color,
            highlight: { background: "#fff7da", border: "#ffbd63" },
            hover: { background: "#f6f1df", border: color },
          },
          font: {
            color: "#d7ddd4",
            face: "Geist Mono Variable",
            size: prominent ? 10 : 0,
            strokeWidth: 3,
            strokeColor: "#0b0e12",
            vadjust: 7,
          },
        };
      }));
      const edges = new DataSet(graph.edges.map((edge) => ({
        id: edge.edge_id,
        from: edge.from_node_id,
        to: edge.to_node_id,
        title: safeGraphTooltip(edge.description ?? edge.relation),
        ...(edge.direction === "directed"
          ? { arrows: { to: { enabled: true, scaleFactor: 0.45 } } }
          : {}),
        dashes: edge.authority_plane === "projection_lineage" ? [3, 5] : false,
        width: edge.authority_plane === "governed_relation" ? 1.35 : 0.8,
        color: {
          color: edge.authority_plane === "governed_relation" ? "#688cb3" : "#64706c",
          highlight: "#ffbd63",
          hover: "#a8c8e5",
          opacity: edge.authority_plane === "governed_relation" ? 0.72 : 0.48,
        },
      })));
      const network = new VisNetwork(host, { nodes, edges }, {
        autoResize: true,
        physics: {
          enabled: true,
          solver: "forceAtlas2Based",
          forceAtlas2Based: {
            gravitationalConstant: -62,
            centralGravity: 0.008,
            springLength: 118,
            springConstant: 0.075,
            damping: 0.43,
            avoidOverlap: 0.78,
          },
          stabilization: {
            enabled: true,
            iterations: 240,
            updateInterval: 24,
            fit: true,
          },
        },
        interaction: {
          dragNodes: true,
          dragView: true,
          hideEdgesOnDrag: true,
          hover: true,
          hoverConnectedEdges: true,
          multiselect: false,
          navigationButtons: false,
          selectable: true,
          tooltipDelay: 120,
          zoomView: true,
        },
        nodes: {
          chosen: true,
          scaling: { min: 11, max: 34 },
        },
        edges: {
          chosen: true,
          hoverWidth: 0.8,
          selectionWidth: 2.2,
          smooth: { enabled: true, type: "continuous", roundness: 0.22 },
        },
      });
      network.once("stabilizationIterationsDone", () => {
        network.setOptions({ physics: { enabled: false } });
        network.fit({ animation: { duration: 420, easingFunction: "easeInOutQuad" } });
      });
      network.on("selectNode", ({ nodes: selectedNodes }) => {
        const nodeId = selectedNodes[0];
        if (nodeId !== undefined) selectNode.current(String(nodeId));
      });
      network.on("selectEdge", ({ edges: selectedEdges, nodes: selectedNodes }) => {
        if (selectedNodes.length > 0) return;
        const edgeId = selectedEdges[0];
        if (edgeId !== undefined) selectEdge.current(String(edgeId));
      });
      if (selectedNodeId !== null) network.selectNodes([selectedNodeId]);
      if (selectedEdgeId !== null) network.selectEdges([selectedEdgeId]);
      mounted = network;
      instance.current = network;
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
    const network = instance.current;
    if (network === null) return;
    network.unselectAll();
    if (selectedNodeId !== null) network.selectNodes([selectedNodeId]);
    if (selectedEdgeId !== null) network.selectEdges([selectedEdgeId]);
  }, [selectedEdgeId, selectedNodeId]);
  return (
    <div className="graph-visual">
      <div className="graph-canvas-toolbar" aria-label="Graph 图例与画布控制">
        <ul className="graph-legend" aria-label="节点类型">
          {Object.entries(GRAPH_KIND_COLORS).map(([kind, color]) => (
            <li key={kind}><span style={{ backgroundColor: color }} />{nodeKindLabel(kind as GraphNode["kind"])}</li>
          ))}
        </ul>
        <button onClick={() => instance.current?.fit({ animation: true })} type="button">适应画布</button>
      </div>
      <div aria-hidden="true" className="graph-canvas" data-state={canvasState} ref={container} />
      {canvasState === "failed" ? (
        <p className="graph-canvas-fallback" role="status">
          视觉图层加载失败；下方语义列表仍可完整检查和导航。
        </p>
      ) : null}
    </div>
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

function visibleGraphLabel(value: string): string {
  const normalized = value.trim();
  return [...normalized].length <= 18 ? normalized : "";
}

function graphDegrees(graph: ReadyGraph): Map<string, number> {
  const degrees = new Map(graph.nodes.map((node) => [node.node_id, 0]));
  for (const edge of graph.edges) {
    degrees.set(edge.from_node_id, (degrees.get(edge.from_node_id) ?? 0) + 1);
    degrees.set(edge.to_node_id, (degrees.get(edge.to_node_id) ?? 0) + 1);
  }
  return degrees;
}

function nodeSize(degree: number): number {
  return Math.min(30, 10 + Math.sqrt(Math.max(1, degree)) * 4.5);
}

function safeGraphTooltip(text: string): HTMLElement {
  const tooltip = document.createElement("span");
  tooltip.textContent = text;
  return tooltip;
}

function nodeKindLabel(kind: GraphNode["kind"]): string {
  return kind === "memory_revision" ? "Canonical memory" : `${kind} projection`;
}

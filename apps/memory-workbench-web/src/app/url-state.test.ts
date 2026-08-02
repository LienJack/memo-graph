import { describe, expect, it } from "vitest";

import {
  parseStructuralUrl,
  urlForMemoryStructure,
  urlForView,
} from "./url-state.js";

describe("structural URL state", () => {
  it("keeps reviewed structure and removes free text and malformed identifiers", () => {
    const secret = "sk-secret@example.test";
    const parsed = parseStructuralUrl(
      new URL(
        `http://127.0.0.1:4321/?view=graph&scope_kind=workspace&scope_id=memo-graph&memory_id=bad%2Fpath&query=${secret}&draft=%3Cscript%3E`,
      ),
    );

    expect(parsed.state).toEqual({
      view: "graph",
      scopeKind: "workspace",
      scopeId: "memo-graph",
      selectedMemoryId: null,
      selectedRevisionId: null,
      includeNonCurrent: false,
    });
    expect(parsed.changed).toBe(true);
    expect(parsed.sanitizedUrl.href).not.toContain(secret);
    expect(parsed.sanitizedUrl.searchParams.has("query")).toBe(false);
    expect(parsed.sanitizedUrl.searchParams.has("draft")).toBe(false);
  });

  it("uses Memory as the default route", () => {
    const parsed = parseStructuralUrl(new URL("http://127.0.0.1:4321/?view=unknown"));
    expect(parsed.state.view).toBe("memory");
    expect(parsed.sanitizedUrl.search).toBe("");
  });

  it("changes only the structural view", () => {
    const next = urlForView(
      new URL("http://127.0.0.1:4321/?scope_kind=topic&scope_id=memory"),
      "runtime",
    );
    expect(next.searchParams.get("view")).toBe("runtime");
    expect(next.searchParams.get("scope_id")).toBe("memory");
  });

  it("persists only exact governed memory structure", () => {
    const next = urlForMemoryStructure(
      new URL("http://127.0.0.1:4321/?query=private@example.test"),
      {
        scope: { kind: "workspace", id: "memo-graph" },
        selectedMemoryId: "memory_current",
        selectedRevisionId: "revision_current",
        includeNonCurrent: true,
      },
    );
    expect(next.searchParams.toString()).toBe(
      "scope_kind=workspace&scope_id=memo-graph&memory_id=memory_current&revision_id=revision_current&include_non_current=1",
    );
    expect(next.href).not.toContain("private");
  });
});

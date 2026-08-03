import type {
  WorkbenchCorrectionConfirmResult,
  WorkbenchCorrectionDraft,
  WorkbenchCorrectionPreviewResult,
  WorkbenchMemoryDetailResult,
  WorkbenchMemoryListRequest,
  WorkbenchMemoryListResult,
  WorkbenchGraphRequest,
  WorkbenchGraphResult,
  WorkbenchHealthResult,
  WorkbenchAutomaticMemoryListRequest,
  WorkbenchAutomaticMemoryListResult,
  WorkbenchAutomaticMemoryUndoPreviewResult,
  WorkbenchAutomaticMemoryUndoConfirmResult,
} from "@memo-graph/contracts/workbench";

export type MemoryWorkbenchApi = {
  listMemories(
    request: WorkbenchMemoryListRequest,
    signal?: AbortSignal,
  ): Promise<WorkbenchMemoryListResult>;
  memoryDetail(
    memoryId: string,
    revisionId: string | null,
    signal?: AbortSignal,
  ): Promise<WorkbenchMemoryDetailResult>;
  graph(
    request: WorkbenchGraphRequest,
    signal?: AbortSignal,
  ): Promise<WorkbenchGraphResult>;
  health(signal?: AbortSignal): Promise<WorkbenchHealthResult>;
  automaticMemory(
    request: WorkbenchAutomaticMemoryListRequest,
    signal?: AbortSignal,
  ): Promise<WorkbenchAutomaticMemoryListResult>;
  previewAutomaticMemoryUndo(
    memoryId: string,
    expectedRevisionId: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchAutomaticMemoryUndoPreviewResult>;
  confirmAutomaticMemoryUndo(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchAutomaticMemoryUndoConfirmResult>;
  previewCorrection(
    draft: WorkbenchCorrectionDraft,
    signal?: AbortSignal,
  ): Promise<WorkbenchCorrectionPreviewResult>;
  confirmCorrection(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchCorrectionConfirmResult>;
};

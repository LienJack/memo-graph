import type {
  WorkbenchCorrectionConfirmResult,
  WorkbenchCorrectionDraft,
  WorkbenchCorrectionPreviewResult,
  WorkbenchMemoryDetailResult,
  WorkbenchMemoryListRequest,
  WorkbenchMemoryListResult,
  WorkbenchGraphRequest,
  WorkbenchGraphResult,
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
  previewCorrection(
    draft: WorkbenchCorrectionDraft,
    signal?: AbortSignal,
  ): Promise<WorkbenchCorrectionPreviewResult>;
  confirmCorrection(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchCorrectionConfirmResult>;
};

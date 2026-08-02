import type {
  WorkbenchGraphRequest,
  WorkbenchMemoryListRequest,
} from "@memo-graph/contracts/workbench";
import {
  WorkbenchCorrectionConfirmResultSchema,
  WorkbenchCorrectionPreviewResultSchema,
  WorkbenchMemoryDetailResultSchema,
  WorkbenchMemoryListResultSchema,
  WorkbenchGraphResultSchema,
} from "@memo-graph/contracts/workbench";
import type { ZodType } from "zod";

export class WorkbenchApiError extends Error {
  constructor(
    readonly code: "HTTP_ERROR" | "INVALID_RESPONSE",
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "WorkbenchApiError";
  }
}

export type WorkbenchApiClientOptions = {
  bearer: string;
  instanceId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class WorkbenchApiClient {
  readonly #bearer: string;
  readonly #instanceId: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: WorkbenchApiClientOptions) {
    this.#bearer = options.bearer;
    this.#instanceId = options.instanceId;
    this.#baseUrl = options.baseUrl ?? "";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  listMemories(request: WorkbenchMemoryListRequest, signal?: AbortSignal) {
    return this.#request(
      "/api/workbench/memories/query",
      WorkbenchMemoryListResultSchema,
      request,
      signal,
    );
  }

  memoryDetail(memoryId: string, revisionId: string | null, signal?: AbortSignal) {
    return this.#request(
      "/api/workbench/memories/detail",
      WorkbenchMemoryDetailResultSchema,
      { memory_id: memoryId, revision_id: revisionId },
      signal,
    );
  }

  graph(request: WorkbenchGraphRequest, signal?: AbortSignal) {
    return this.#request(
      "/api/workbench/graph/query",
      WorkbenchGraphResultSchema,
      request,
      signal,
    );
  }

  previewCorrection(draft: unknown, signal?: AbortSignal) {
    return this.#request(
      "/api/workbench/corrections/preview",
      WorkbenchCorrectionPreviewResultSchema,
      draft,
      signal,
    );
  }

  confirmCorrection(previewId: string, signal?: AbortSignal) {
    return this.#request(
      "/api/workbench/corrections/confirm",
      WorkbenchCorrectionConfirmResultSchema,
      { preview_id: previewId, confirmed: true },
      signal,
    );
  }

  async #request<T>(
    path: string,
    schema: ZodType<T>,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#bearer}`,
        "Content-Type": "application/json",
        "X-Memo-Graph-Instance": this.#instanceId,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new WorkbenchApiError(
        "HTTP_ERROR",
        `Workbench request failed with status ${response.status}`,
        response.status,
      );
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new WorkbenchApiError(
        "INVALID_RESPONSE",
        "Workbench response did not match the browser contract",
        response.status,
      );
    }
    return parsed.data;
  }
}

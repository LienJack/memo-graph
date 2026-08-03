import {
  GraphStoreError,
  type GraphStore,
} from "@memo-graph/graph-projection";

export class SharedGraphStoreManager {
  readonly #factory: () => Promise<GraphStore>;
  #store: GraphStore | null = null;
  #opening: Promise<GraphStore> | null = null;
  #closed = false;

  constructor(factory: () => Promise<GraphStore>) {
    this.#factory = factory;
  }

  borrowedStore(): GraphStore {
    return {
      health: () => this.#withStore((store) => store.health()),
      replaceScope: (input) =>
        this.#withStore((store) => store.replaceScope(input)),
      deleteScope: (input) =>
        this.#withStore((store) => store.deleteScope(input)),
      readScopeSnapshot: (input) =>
        this.#withStore((store) => store.readScopeSnapshot(input)),
      queryPaths: (input) =>
        this.#withStore((store) => store.queryPaths(input)),
      close: async () => undefined,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const store = this.#store ??
      (this.#opening === null
        ? null
        : await this.#opening.catch(() => null));
    this.#store = null;
    this.#opening = null;
    await store?.close();
  }

  async #withStore<T>(operation: (store: GraphStore) => Promise<T>): Promise<T> {
    return operation(await this.#open());
  }

  async #open(): Promise<GraphStore> {
    if (this.#closed) {
      throw new GraphStoreError("GRAPH_CHILD_EXITED");
    }
    if (this.#store !== null) {
      return this.#store;
    }
    this.#opening ??= this.#factory();
    try {
      this.#store = await this.#opening;
      return this.#store;
    } catch (error) {
      this.#opening = null;
      throw error;
    }
  }
}

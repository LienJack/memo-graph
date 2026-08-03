export type CoordinatedResult<T> =
  | { status: "accepted"; value: T }
  | { status: "superseded" };

export class RequestCoordinator {
  #active: AbortController | null = null;
  #generation = 0;

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<CoordinatedResult<T>> {
    this.#active?.abort("superseded");
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#active = controller;

    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted || generation !== this.#generation) {
        return { status: "superseded" };
      }
      return { status: "accepted", value };
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#generation) {
        return { status: "superseded" };
      }
      throw error;
    } finally {
      if (generation === this.#generation) {
        this.#active = null;
      }
    }
  }

  cancel(): void {
    this.#generation += 1;
    this.#active?.abort("cancelled");
    this.#active = null;
  }
}

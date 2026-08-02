import { z } from "zod";

const LaneNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

export type BackgroundLaneResult = {
  claimed: number;
  completed: number;
  failed: number;
  retrying?: number;
  terminal: number;
  failure_code?: string | null;
};

export type BackgroundLane = {
  name: string;
  intervalMs: number;
  runOnce(): Promise<BackgroundLaneResult>;
};

export type BackgroundLaneObservation = {
  lane: string;
  state: "idle" | "running" | "retrying" | "terminal" | "stopped";
  in_flight: boolean;
  consecutive_failures: number;
  next_run_at: string | null;
  last_success_at: string | null;
  last_failure_code: string | null;
  claimed: number;
  completed: number;
  failed: number;
  retrying: number;
  terminal: number;
  observed_at: string;
};

type LaneState = {
  lane: BackgroundLane;
  inFlight: Promise<void> | null;
  consecutiveFailures: number;
  nextRunAtMs: number;
  lastSuccessAt: string | null;
  lastFailureCode: string | null;
  claimed: number;
  completed: number;
  failed: number;
  retrying: number;
  terminal: number;
};

function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "BACKGROUND_LANE_FAILED";
}

export class BackgroundSupervisor {
  readonly #clock: () => number;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #maxConcurrency: number;
  readonly #maxBackoffMs: number;
  readonly #lanes: LaneState[];
  #state: "starting" | "running" | "draining" | "stopped" = "starting";
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    lanes: BackgroundLane[];
    clock?: () => number;
    maxConcurrency?: number;
    maxBackoffMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }) {
    const names = options.lanes.map((lane) => LaneNameSchema.parse(lane.name));
    if (new Set(names).size !== names.length) {
      throw new Error("background lane names must be unique");
    }
    this.#clock = options.clock ?? Date.now;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#maxConcurrency = z.number().int().min(1).max(8)
      .parse(options.maxConcurrency ?? 1);
    this.#maxBackoffMs = z.number().int().min(100).max(60 * 60_000)
      .parse(options.maxBackoffMs ?? 60_000);
    const now = this.#clock();
    this.#lanes = options.lanes.map((lane) => ({
      lane: {
        ...lane,
        name: LaneNameSchema.parse(lane.name),
        intervalMs: z.number().int().min(10).max(60 * 60_000)
          .parse(lane.intervalMs),
      },
      inFlight: null,
      consecutiveFailures: 0,
      nextRunAtMs: now,
      lastSuccessAt: null,
      lastFailureCode: null,
      claimed: 0,
      completed: 0,
      failed: 0,
      retrying: 0,
      terminal: 0,
    }));
  }

  start(): void {
    if (this.#state !== "starting") {
      return;
    }
    this.#state = "running";
    this.#schedule(0);
  }

  async runDueOnce(): Promise<void> {
    if (this.#state !== "running") {
      return;
    }
    const now = this.#clock();
    let available =
      this.#maxConcurrency -
      this.#lanes.filter((state) => state.inFlight !== null).length;
    for (const state of this.#lanes) {
      if (
        available <= 0 ||
        state.inFlight !== null ||
        state.nextRunAtMs > now
      ) {
        continue;
      }
      available -= 1;
      const running = this.#runLane(state);
      state.inFlight = running;
      void running.finally(() => {
        if (state.inFlight === running) {
          state.inFlight = null;
        }
        if (this.#state === "running") {
          this.#scheduleNext();
        }
      });
    }
  }

  observations(): BackgroundLaneObservation[] {
    const observedAt = new Date(this.#clock()).toISOString();
    return this.#lanes.map((state) => ({
      lane: state.lane.name,
      state:
        this.#state === "stopped"
          ? "stopped"
          : state.inFlight !== null
            ? "running"
            : state.terminal > 0
              ? "terminal"
            : state.consecutiveFailures > 0
              ? "retrying"
              : "idle",
      in_flight: state.inFlight !== null,
      consecutive_failures: state.consecutiveFailures,
      next_run_at:
        this.#state === "running"
          ? new Date(state.nextRunAtMs).toISOString()
          : null,
      last_success_at: state.lastSuccessAt,
      last_failure_code: state.lastFailureCode,
      claimed: state.claimed,
      completed: state.completed,
      failed: state.failed,
      retrying: state.retrying,
      terminal: state.terminal,
      observed_at: observedAt,
    }));
  }

  async drain(deadlineMs = 5_000): Promise<boolean> {
    if (this.#state === "stopped") {
      return true;
    }
    this.#state = "draining";
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const inFlight = this.#lanes
      .map((lane) => lane.inFlight)
      .filter((value): value is Promise<void> => value !== null);
    if (inFlight.length === 0) {
      this.#state = "stopped";
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      Promise.allSettled(inFlight).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = this.#setTimer(() => resolve(false), deadlineMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) {
      this.#clearTimer(timer);
    }
    this.#state = "stopped";
    return completed;
  }

  async close(): Promise<void> {
    await this.drain();
  }

  async #runLane(state: LaneState): Promise<void> {
    try {
      const result = await state.lane.runOnce();
      const exact = z
        .object({
          claimed: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          retrying: z.number().int().nonnegative().default(0),
          terminal: z.number().int().nonnegative(),
          failure_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
            .nullable().default(null),
        })
        .strict()
        .parse(result);
      state.claimed += exact.claimed;
      state.completed += exact.completed;
      state.failed += exact.failed;
      state.retrying = exact.retrying;
      state.terminal = exact.terminal;
      if (exact.failed > 0 || exact.retrying > 0) {
        state.consecutiveFailures = Math.max(
          1,
          state.consecutiveFailures + (exact.failed > 0 ? 1 : 0),
        );
        state.lastFailureCode =
          exact.failure_code ?? "BACKGROUND_WORK_FAILED";
        const backoff = Math.min(
          this.#maxBackoffMs,
          state.lane.intervalMs *
            2 ** Math.min(10, state.consecutiveFailures - 1),
        );
        state.nextRunAtMs = this.#clock() + backoff;
      } else {
        state.consecutiveFailures = 0;
        state.lastFailureCode = null;
        state.lastSuccessAt = new Date(this.#clock()).toISOString();
        state.nextRunAtMs = this.#clock() + state.lane.intervalMs;
      }
    } catch (error) {
      state.consecutiveFailures += 1;
      state.lastFailureCode = failureCode(error);
      const backoff = Math.min(
        this.#maxBackoffMs,
        state.lane.intervalMs * 2 ** Math.min(10, state.consecutiveFailures - 1),
      );
      state.nextRunAtMs = this.#clock() + backoff;
    }
  }

  #scheduleNext(): void {
    if (this.#state !== "running") {
      return;
    }
    const available = this.#lanes.filter((lane) => lane.inFlight === null);
    if (available.length === 0) {
      return;
    }
    const next = Math.min(...available.map((lane) => lane.nextRunAtMs));
    this.#schedule(Math.max(0, next - this.#clock()));
  }

  #schedule(delayMs: number): void {
    if (this.#state !== "running") {
      return;
    }
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
    }
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.runDueOnce().then(() => this.#scheduleNext());
    }, delayMs);
    this.#timer.unref?.();
  }
}

import type { SqliteStorageClient } from "@memo-graph/storage-sqlite";

export type LearningLabStorage = Pick<
  SqliteStorageClient,
  | "getEvidence"
  | "getGovernedMemory"
  | "readLearningLedger"
  | "replayLearningLedger"
  | "writeLearningLedger"
>;

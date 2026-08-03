import {
  blockedOperationalStatus,
  operationalStatusFromStorageHealth,
  SqliteStorageClient,
} from "@memo-graph/storage-sqlite";
import type {
  OperationalStatus,
  ReleaseQualification,
} from "@memo-graph/contracts";

export async function runDoctor(
  input: {
    dataRoot: string;
    qualification: ReleaseQualification;
  },
  dependencies?: {
    now?: () => string;
    inspectStorage?: typeof SqliteStorageClient.inspect;
  },
): Promise<OperationalStatus> {
  const observedAt = dependencies?.now?.() ?? new Date().toISOString();
  const inspectStorage =
    dependencies?.inspectStorage ?? SqliteStorageClient.inspect;
  try {
    const storage = await inspectStorage({ dataRoot: input.dataRoot });
    try {
      return operationalStatusFromStorageHealth(await storage.health(), {
        observedAt,
        qualification: input.qualification,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    return blockedOperationalStatus(error, {
      observedAt,
      qualification: input.qualification,
    });
  }
}

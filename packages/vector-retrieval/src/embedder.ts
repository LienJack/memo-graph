import {
  VectorEmbeddingEpochSchema,
  type VectorEmbeddingEpoch,
} from "@memo-graph/contracts";

import { verifyLocalModelSnapshot } from "./local-model.js";

export type VectorEmbedder = {
  embedPassages(input: readonly string[]): Promise<number[][]>;
  embedQuery(input: string): Promise<number[]>;
  close(): Promise<void>;
};

type TensorLike = {
  dims: readonly number[];
  data: ArrayLike<number>;
};

type Extractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorLike>;

function tensorRows(
  tensor: TensorLike,
  dimensions: number,
): number[][] {
  const [count, observedDimensions] = tensor.dims;
  if (
    count === undefined ||
    observedDimensions !== dimensions ||
    tensor.data.length !== count * dimensions
  ) {
    throw new Error("embedding output dimensions do not match the epoch");
  }
  return Array.from({ length: count }, (_unused, index) =>
    Array.from(
      { length: dimensions },
      (_inner, offset) =>
        Number(tensor.data[index * dimensions + offset]),
    )
  );
}

function assertNormalized(vectors: readonly number[][]): void {
  for (const vector of vectors) {
    const norm = Math.sqrt(
      vector.reduce(
        (sum, component) => sum + component ** 2,
        0,
      ),
    );
    if (
      vector.some((component) => !Number.isFinite(component)) ||
      Math.abs(norm - 1) > 0.001
    ) {
      throw new Error("embedding output is not a normalized finite vector");
    }
  }
}

export async function createLocalTransformersEmbedder(options: {
  modelRoot: string;
  epoch: VectorEmbeddingEpoch;
}): Promise<VectorEmbedder> {
  const epoch = VectorEmbeddingEpochSchema.parse(options.epoch);
  await verifyLocalModelSnapshot(options.modelRoot, epoch);
  const moduleName = "@huggingface/transformers";
  const imported = await import(moduleName) as {
    env: {
      allowRemoteModels: boolean;
      allowLocalModels: boolean;
      localModelPath: string;
      cacheDir?: string;
    };
    pipeline: (
      task: "feature-extraction",
      model: string,
      options: {
        revision: string;
        dtype: "int8";
        device: "cpu";
      },
    ) => Promise<Extractor>;
  };
  imported.env.allowRemoteModels = false;
  imported.env.allowLocalModels = true;
  imported.env.localModelPath = options.modelRoot;
  const extractor = await imported.pipeline(
    "feature-extraction",
    epoch.model.repository,
    {
      revision: epoch.model.revision,
      dtype: epoch.model.dtype,
      device: "cpu",
    },
  );

  async function embed(
    texts: readonly string[],
    prefix: string,
  ): Promise<number[][]> {
    if (texts.length === 0 || texts.length > 1_000) {
      throw new Error("embedding batch size is outside the fixed bound");
    }
    const prepared = texts.map((text) => {
      const value = text.trim();
      if (value.length < 1 || value.length > 20_000) {
        throw new Error("embedding input is outside the fixed text bound");
      }
      return `${prefix}${value}`;
    });
    const output = await extractor(
      prepared.length === 1 ? prepared[0] ?? "" : prepared,
      { pooling: "mean", normalize: true },
    );
    const vectors = tensorRows(output, epoch.model.dimensions);
    assertNormalized(vectors);
    return vectors;
  }

  return {
    embedPassages: async (input) =>
      embed(input, epoch.model.passage_prefix),
    embedQuery: async (input) => {
      const [vector] = await embed(
        [input],
        epoch.model.query_prefix,
      );
      if (vector === undefined) {
        throw new Error("embedding runtime returned no query vector");
      }
      return vector;
    },
    close: async () => undefined,
  };
}

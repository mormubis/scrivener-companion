import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

export class Embedder {
  private pipe: FeatureExtractionPipeline | null = null;
  private modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async initialize(): Promise<void> {
    this.pipe = (await pipeline("feature-extraction", this.modelDir, {
      local_files_only: true,
    })) as FeatureExtractionPipeline;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error("Embedder not initialized");

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data as Float64Array);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

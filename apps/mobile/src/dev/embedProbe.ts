// Development only: loads the text encoder from a folder on the Mac (the simulator can read it),
// embeds a query a few times, and writes the timings and the vector's start to /tmp. Used to check
// onnxruntime runs the int8 encoder on iOS and lands where the hub's own embedding does.
import { File } from "expo-file-system";
import { QUERY_TEMPLATES, NOISE_PROMPTS } from "@lifer/shared";
import { loadTextEmbedder } from "../search/textEmbedder";

export async function embedProbe(dir: string, text: string): Promise<void> {
  const out: Record<string, unknown> = { text };
  try {
    let t = Date.now();
    const embedder = await loadTextEmbedder(
      `${dir}/text_model_quantized.onnx`,
      await new File(`file://${dir}/tokenizer.json`).text(),
    );
    out.loadMs = Date.now() - t;
    const runs: number[] = [];
    let vector: Float32Array = new Float32Array();
    for (let i = 0; i < 5; i++) {
      t = Date.now();
      [vector] = await embedder.embedTexts([text]);
      runs.push(Date.now() - t);
    }
    out.embedMs = runs;
    out.first8 = Array.from(vector.slice(0, 8));
    out.length = vector.length;
    // A first query embeds its templates and the noise prompts once.
    t = Date.now();
    await embedder.embedTexts([...QUERY_TEMPLATES(text), ...NOISE_PROMPTS]);
    out.firstQueryMs = Date.now() - t;
    await embedder.release();
  } catch (e) {
    out.error = String((e as Error)?.stack ?? e);
  }
  console.log("embed probe", JSON.stringify(out));
  new File("file:///tmp/lifer-embed-result.json").write(JSON.stringify(out));
}

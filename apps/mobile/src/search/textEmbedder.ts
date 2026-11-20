// The hub's CLIP text encoder (int8 ONNX) run on the phone with onnxruntime-react-native. Same
// token ids, same encoder, then L2 normalised: a query lands where the hub's own would.
import { InferenceSession, Tensor } from "onnxruntime-react-native";
import { createClipTokenizer, type ClipTokenizerFile } from "./clipTokenizer";

export interface TextEmbedder {
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  release(): Promise<void>;
}

export async function loadTextEmbedder(encoderPath: string, tokenizerJson: string): Promise<TextEmbedder> {
  const tokenizer = createClipTokenizer(JSON.parse(tokenizerJson) as ClipTokenizerFile);
  const session = await InferenceSession.create(encoderPath);
  return {
    async embedTexts(texts) {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const ids = tokenizer.encode(text);
        // The exported encoder takes the ids alone (the hub's loader drops the mask for the same reason).
        const feeds = { input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]) };
        const res = await session.run(feeds, ["text_embeds"]);
        const v = Float32Array.from(res.text_embeds.data as Float32Array);
        let n = 0;
        for (let i = 0; i < v.length; i++) n += v[i] * v[i];
        n = Math.sqrt(n) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= n;
        out.push(v);
      }
      return out;
    },
    release: () => session.release(),
  };
}

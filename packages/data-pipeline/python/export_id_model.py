"""Exports the species identification model's image encoder (BioCLIP 2) to the int8 ONNX file
installs download (apps/api/src/species/idModel.ts).

Same input/output names as the CLIP export the app already runs (pixel_values -> image_embeds),
and the same preprocessing (224px, CLIP mean/std), so the app's existing preprocessing applies
unchanged. Per-channel int8 kept the vectors at ~0.997 cosine of full precision in testing,
where the default per-tensor quantization only reached ~0.991 and lost accuracy.

Run:
  .venv/bin/python packages/data-pipeline/python/export_id_model.py <output-dir>
Then publish <output-dir>/bioclip-2-v1.onnx (see SCRIPTS.md).
"""

import os
import sys

import open_clip
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

# Must match ID_MODEL_VERSION in packages/shared/src/idModel.ts.
ID_MODEL_VERSION = "bioclip-2-v1"


class Vision(torch.nn.Module):
    def __init__(self, visual):
        super().__init__()
        self.visual = visual

    def forward(self, pixel_values):
        return self.visual(pixel_values)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    fp32 = os.path.join(out_dir, f"{ID_MODEL_VERSION}-fp32.onnx")
    final = os.path.join(out_dir, f"{ID_MODEL_VERSION}.onnx")

    model, _, _ = open_clip.create_model_and_transforms("hf-hub:imageomics/bioclip-2")
    model.eval()
    torch.onnx.export(
        Vision(model.visual),
        (torch.randn(1, 3, 224, 224),),
        fp32,
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={"pixel_values": {0: "batch_size"}, "image_embeds": {0: "batch_size"}},
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(fp32, final, weight_type=QuantType.QInt8, per_channel=True)
    os.remove(fp32)
    print(f"wrote {final} ({os.path.getsize(final) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()

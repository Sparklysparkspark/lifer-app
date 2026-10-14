"""Exports the scene model (UperNet with a ConvNeXt-tiny backbone, trained on ADE20K's 150
classes, MIT licensed) to the ONNX files installs download (packages/core/src/species/sceneModel.ts):
per-channel int8 for the CPU, and full precision for Intel Macs, whose onnxruntime has no
ConvInteger kernel.

The graph ends in an argmax, so it returns one class index per pixel (uint8, 512x512) instead
of 150 score maps. Input is the photo squashed to 512x512 with ImageNet mean/std. Per-channel int8
agreed with full precision on ~96% of pixels in testing, per-tensor on ~95%.

Run:
  .venv/bin/python packages/data-pipeline/python/export_scene_model.py <output-dir>
Then publish <output-dir>/upernet-convnext-tiny-ade-v1.onnx and its -fp32 copy (see SCRIPTS.md).
"""

import os
import sys

import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSemanticSegmentation

# Must match SCENE_MODEL_VERSION in packages/core/src/config.ts.
SCENE_MODEL_VERSION = "upernet-convnext-tiny-ade-v1"
# Pinned so a re-export gives the same file.
SOURCE = "openmmlab/upernet-convnext-tiny"
REVISION = "876ffc56b819a829448f7e81e9f8606deef6fb65"


class LabelMap(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, pixel_values):
        return self.model(pixel_values=pixel_values).logits.argmax(1).to(torch.uint8)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    fp32 = os.path.join(out_dir, f"{SCENE_MODEL_VERSION}-fp32.onnx")
    final = os.path.join(out_dir, f"{SCENE_MODEL_VERSION}.onnx")

    model = AutoModelForSemanticSegmentation.from_pretrained(SOURCE, revision=REVISION).eval()
    # The TorchScript exporter fails on this model; the dynamo one doesn't.
    torch.onnx.export(
        LabelMap(model),
        (torch.zeros(1, 3, 512, 512),),
        fp32,
        input_names=["pixel_values"],
        output_names=["labels"],
        opset_version=18,
        dynamo=True,
        external_data=False,
    )
    quantize_dynamic(fp32, final, weight_type=QuantType.QInt8, per_channel=True)
    for path in (final, fp32):
        print(f"wrote {path} ({os.path.getsize(path) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()

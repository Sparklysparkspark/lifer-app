"""Exports the animal detector (MegaDetector v6, the Apache-2.0 RT-DETR "c" weights) to the ONNX
file installs download (packages/core/src/species/detectorModel.ts).

Input: RGB [1,3,640,640] in 0..1, the photo squashed to a square (as in training). Outputs: raw
class logits [1,300,3] (animal, person, vehicle; a sigmoid gives the score) and boxes [1,300,4]
as (cx, cy, w, h) fractions of the image. Decoding is in inferenceWorker.ts (readAnimalDetector).
Full precision only: the CPU runs it faster than an fp16 export, with the same boxes.

Run (needs torch, torchvision, onnx, pyyaml, scipy):
  .venv/bin/python packages/data-pipeline/python/export_detector_model.py <output-dir>
Then publish <output-dir>/megadetector-v6c-v1.onnx (see rebuilding-data.md). torch.onnx output
isn't byte-stable across versions, so a fresh export needs its new sha256 in modelChecksums.ts.
"""

import hashlib
import io
import os
import sys
import tarfile
import urllib.request

import onnx
import torch

# Must match ANIMAL_DETECTOR_VERSION in packages/core/src/config.ts.
VERSION = "megadetector-v6c-v1"
# Pinned weights (Zenodo, md5 checked) and model code (microsoft/Pytorch-Wildlife), so a
# re-export starts from the same files.
WEIGHTS_URL = "https://zenodo.org/records/15398270/files/MDV6-apa-rtdetr-c.pth?download=1"
WEIGHTS_MD5 = "3992888e26f627ee5a4ff9f116be97c3"
CODE_COMMIT = "f78ae44ad8dbd1b70723d02468562b22eeadb0e4"
CODE_DIR = "src/PytorchWildlife/models/detection/rtdetr_apache/rtdetrv2_pytorch"
CONFIG = "configs/rtdetrv2/rtdetrv2_r18vd_120e_megadetector.yml"


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    work = os.path.join(out_dir, "detector-work")
    os.makedirs(work, exist_ok=True)

    weights = os.path.join(work, "MDV6-apa-rtdetr-c.pth")
    if not os.path.exists(weights):
        urllib.request.urlretrieve(WEIGHTS_URL, weights)
    with open(weights, "rb") as f:
        if hashlib.md5(f.read()).hexdigest() != WEIGHTS_MD5:
            sys.exit(f"{weights}: md5 mismatch, delete it and rerun")

    code = os.path.join(work, "code")
    if not os.path.exists(code):
        url = f"https://codeload.github.com/microsoft/Pytorch-Wildlife/tar.gz/{CODE_COMMIT}"
        prefix = f"Pytorch-Wildlife-{CODE_COMMIT}/{CODE_DIR}/"
        with tarfile.open(fileobj=io.BytesIO(urllib.request.urlopen(url).read())) as tar:
            for member in tar.getmembers():
                if member.isfile() and member.name.startswith(prefix):
                    member.name = member.name[len(prefix):]
                    tar.extract(member, code)

    sys.path.insert(0, code)
    from src.core import YAMLConfig  # noqa: E402

    # The checkpoint carries every weight, so no ImageNet backbone download.
    cfg = YAMLConfig(os.path.join(code, CONFIG), resume=weights, PResNet={"pretrained": False})
    ckpt = torch.load(weights, map_location="cpu", weights_only=False)
    cfg.model.load_state_dict(ckpt["ema"]["module"] if "ema" in ckpt else ckpt["model"])
    model = cfg.model.deploy().eval()

    class Raw(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.model = model

        def forward(self, images):
            out = self.model(images)
            return out["pred_logits"], out["pred_boxes"]

    path = os.path.join(out_dir, f"{VERSION}.onnx")
    torch.onnx.export(
        Raw(), torch.zeros(1, 3, 640, 640), path, input_names=["images"],
        output_names=["logits", "boxes"], opset_version=17, dynamo=False,
    )
    # One self-contained file rather than external weight data.
    onnx.save(onnx.load(path), path, save_as_external_data=False)
    with open(path, "rb") as f:
        print(f"{path}\t{os.path.getsize(path)}\t{hashlib.sha256(f.read()).hexdigest()}")


if __name__ == "__main__":
    main()

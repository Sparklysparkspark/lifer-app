"""Builds the CLIP model files for version clip-vit-l14-v2: the CPU's int8 copy, quantized from
Xenova's full-precision export at the pinned revision, which GPUs run as is.

Xenova's own int8 file (clip-vit-l14-quantized-v1) is per-tensor and lands only ~0.96 cosine of
full precision, too far to share vectors with a GPU. Per-channel int8, as export_id_model.py
does for the identification model, keeps it close enough that one set of stored vectors (made
at full precision) serves both.

Run:
  .venv/bin/python packages/data-pipeline/python/export_clip_model.py <output-dir> [fp32.onnx]
Downloads the fp32 file into <output-dir> unless a path to it is given. Then publish
<output-dir>/clip-vit-l14-v2.onnx (see SCRIPTS.md).
"""

import hashlib
import os
import sys
import urllib.request

from onnxruntime.quantization import QuantType, quantize_dynamic

# Must match EMBEDDING_MODEL_VERSION in apps/api/src/config.ts once the app switches over.
CLIP_MODEL_VERSION = "clip-vit-l14-v2"
FP32_URL = (
    "https://huggingface.co/Xenova/clip-vit-large-patch14/resolve/"
    "c307790166907339eed5a9a53a249af534102536/onnx/vision_model.onnx"
)
FP32_BYTES = 1_216_438_437
# Hugging Face's LFS object id (X-Linked-ETag) for this file, which is its sha256.
FP32_SHA256 = "ff49f8aa57c7abfd26e382eb083e4dbf988505223a9bd3767dbfd4e729206709"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, path):
    part = path + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
    with urllib.request.urlopen(req) as res:
        # A server that ignores Range sends the whole file again.
        mode = "ab" if have and res.status == 206 else "wb"
        done = have if mode == "ab" else 0
        with open(part, mode) as f:
            while chunk := res.read(1 << 22):
                f.write(chunk)
                done += len(chunk)
                print(f"\rdownloading {done / 1e6:.0f}/{FP32_BYTES / 1e6:.0f} MB", end="", flush=True)
    print()
    os.replace(part, path)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    fp32 = sys.argv[2] if len(sys.argv) > 2 else os.path.join(out_dir, f"{CLIP_MODEL_VERSION}-fp32.onnx")
    final = os.path.join(out_dir, f"{CLIP_MODEL_VERSION}.onnx")

    if not os.path.exists(fp32):
        download(FP32_URL, fp32)
    size = os.path.getsize(fp32)
    if size != FP32_BYTES:
        sys.exit(f"{fp32} is {size} bytes, expected {FP32_BYTES}: delete it and run again")
    digest = sha256(fp32)
    if digest != FP32_SHA256:
        sys.exit(f"{fp32} has sha256 {digest}, expected {FP32_SHA256}: delete it and run again")

    quantize_dynamic(fp32, final, weight_type=QuantType.QInt8, per_channel=True)
    for path in (fp32, final):
        print(f"{path}\n  {os.path.getsize(path)} bytes  sha256 {sha256(path)}")


if __name__ == "__main__":
    main()

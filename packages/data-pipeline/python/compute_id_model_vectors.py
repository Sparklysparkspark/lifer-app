"""Computes species identification model (BioCLIP 2) vectors into the pipeline database.

Fills id_model_text_embeddings, id_model_reference_embeddings and id_model_gallery_embeddings
(migration 105) from the reference photos already cached on disk. build-catalog-seed.ts then
publishes them as their own assets, and build-region-pack.ts puts them in packs.

Runs the full-precision PyTorch model (Apple GPU when available). Installs match against these
with the int8 ONNX export from export_id_model.py; the two agree to ~0.997 cosine, and a
real-library benchmark scored the same with either. Resumable: rows already at ID_MODEL_VERSION
are skipped, so an interrupted run picks up where it stopped.

Setup (once):
  python3 -m venv .venv && .venv/bin/pip install -r packages/data-pipeline/python/requirements.txt
Run:
  DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer \\
    .venv/bin/python packages/data-pipeline/python/compute_id_model_vectors.py [--only=text|reference|gallery] [--region=Canada]
"""

import argparse
import os
import sys
import time

import open_clip
import psycopg2
import psycopg2.extras
import torch
from PIL import Image

# Must match ID_MODEL_VERSION in packages/shared/src/idModel.ts.
ID_MODEL_VERSION = "bioclip-2-v1"
HF_MODEL = "hf-hub:imageomics/bioclip-2"
IMAGE_BATCH = 64
TEXT_BATCH = 512


def text_prompt(scientific_name: str) -> str:
    # Plain scientific name won a small prompt comparison on a real library (52/55 vs 50/55 with
    # the common name appended). Keep in sync with anything that reads these vectors.
    return f"a photo of {scientific_name}."


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def region_filter(cur, region: str | None, column: str) -> tuple[str, list]:
    if not region:
        return "", []
    cur.execute("SELECT id FROM regions WHERE name = %s", (region,))
    row = cur.fetchone()
    if not row:
        sys.exit(f'No region named "{region}"')
    return f"AND {column} IN (SELECT species_id FROM region_species WHERE region_id = %s)", [row[0]]


def normalize(t: torch.Tensor) -> torch.Tensor:
    return t / t.norm(dim=-1, keepdim=True)


def store(conn, sql: str, rows: list) -> None:
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, sql, rows, page_size=len(rows))
    conn.commit()


def run_text(conn, model, tokenizer, device, region) -> None:
    with conn.cursor() as cur:
        extra, params = region_filter(cur, region, "s.id")
        cur.execute(
            f"""SELECT s.id, s.scientific_name FROM species s
                LEFT JOIN id_model_text_embeddings e ON e.species_id = s.id AND e.model_version = %s
                WHERE e.species_id IS NULL {extra} ORDER BY s.id""",
            [ID_MODEL_VERSION, *params],
        )
        todo = cur.fetchall()
    print(f"[text] {len(todo)} species need a vector")
    started = time.time()
    for i in range(0, len(todo), TEXT_BATCH):
        batch = todo[i : i + TEXT_BATCH]
        with torch.no_grad():
            vecs = normalize(model.encode_text(tokenizer([text_prompt(n) for _, n in batch]).to(device))).cpu().tolist()
        store(
            conn,
            """INSERT INTO id_model_text_embeddings (species_id, embedding, model_version) VALUES %s
               ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding,
                 model_version = EXCLUDED.model_version, computed_at = now()""",
            [(sid, v, ID_MODEL_VERSION) for (sid, _), v in zip(batch, vecs)],
        )
        progress("text", i + len(batch), len(todo), started)


def run_images(conn, model, preprocess, device, region, kind: str) -> None:
    with conn.cursor() as cur:
        if kind == "reference":
            extra, params = region_filter(cur, region, "s.id")
            cur.execute(
                f"""SELECT s.id, s.id, s.reference_display_path FROM species s
                    LEFT JOIN id_model_reference_embeddings e ON e.species_id = s.id AND e.model_version = %s
                    WHERE s.reference_display_path IS NOT NULL AND e.species_id IS NULL {extra} ORDER BY s.id""",
                [ID_MODEL_VERSION, *params],
            )
            sql = """INSERT INTO id_model_reference_embeddings (species_id, embedding, model_version) VALUES %s
                     ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding,
                       model_version = EXCLUDED.model_version, computed_at = now()"""
            row_of = lambda key, species_id, v: (species_id, v, ID_MODEL_VERSION)
        else:
            extra, params = region_filter(cur, region, "p.species_id")
            cur.execute(
                f"""SELECT p.id, p.species_id, p.display_path FROM species_reference_photos p
                    LEFT JOIN id_model_gallery_embeddings e ON e.reference_photo_id = p.id AND e.model_version = %s
                    WHERE p.display_path IS NOT NULL AND e.reference_photo_id IS NULL {extra} ORDER BY p.id""",
                [ID_MODEL_VERSION, *params],
            )
            sql = """INSERT INTO id_model_gallery_embeddings (reference_photo_id, species_id, embedding, model_version) VALUES %s
                     ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding,
                       species_id = EXCLUDED.species_id, model_version = EXCLUDED.model_version, computed_at = now()"""
            row_of = lambda key, species_id, v: (key, species_id, v, ID_MODEL_VERSION)
        todo = cur.fetchall()
    print(f"[{kind}] {len(todo)} photos need a vector")
    started = time.time()
    skipped = 0
    for i in range(0, len(todo), IMAGE_BATCH):
        batch = todo[i : i + IMAGE_BATCH]
        tensors, kept = [], []
        for key, species_id, file_path in batch:
            try:
                tensors.append(preprocess(Image.open(file_path).convert("RGB")))
                kept.append((key, species_id))
            except Exception:
                skipped += 1  # missing or unreadable file: leave it for a later run
        if tensors:
            with torch.no_grad():
                vecs = normalize(model.encode_image(torch.stack(tensors).to(device))).cpu().tolist()
            store(conn, sql, [row_of(key, species_id, v) for (key, species_id), v in zip(kept, vecs)])
        progress(kind, i + len(batch), len(todo), started, skipped)


def progress(label: str, done: int, total: int, started: float, skipped: int = 0) -> None:
    rate = done / max(time.time() - started, 1e-6)
    eta = (total - done) / rate if rate else 0
    extra = f", {skipped} unreadable" if skipped else ""
    print(f"[{label}] {done}/{total} ({rate:.1f}/s, ~{eta / 60:.0f} min left{extra})", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["text", "reference", "gallery"])
    parser.add_argument("--region")
    args = parser.parse_args()

    device = pick_device()
    print(f"[id-model] {HF_MODEL} on {device}, version {ID_MODEL_VERSION}")
    model, _, preprocess = open_clip.create_model_and_transforms(HF_MODEL)
    tokenizer = open_clip.get_tokenizer(HF_MODEL)
    model = model.to(device).eval()

    conn = psycopg2.connect(os.environ.get("DATABASE_URL", "postgres://lifer:lifer@localhost:5432/lifer"))
    try:
        if args.only in (None, "text"):
            run_text(conn, model, tokenizer, device, args.region)
        if args.only in (None, "reference"):
            run_images(conn, model, preprocess, device, args.region, "reference")
        if args.only in (None, "gallery"):
            run_images(conn, model, preprocess, device, args.region, "gallery")
    finally:
        conn.close()


if __name__ == "__main__":
    main()

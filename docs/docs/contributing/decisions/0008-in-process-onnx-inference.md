---
id: 0008-in-process-onnx-inference
title: "ADR 0008: In-process ONNX inference"
description: Species matching runs ONNX models inside the API process on a worker thread, with optional GPU runtimes downloaded and pinned by hash.
---

# ADR 0008: ONNX models run in the API process on a worker thread

**Status:** Accepted. Models have run in the API through `onnxruntime-node` since `e774b2c` (2026-08-31); the worker thread, the GPU selection and the pinned GPU runtime arrived in `92fdf8e` (2026-10-03).

## Context

Species suggestions need image models (CLIP ViT-L/14 and BioCLIP 2, plus a small YOLOv8 detector). Lifer runs on laptops, small NAS boxes and servers with GPUs, often offline, and must never send photos elsewhere ([Privacy](../../privacy.md)). The commit that added matching describes it as "local-first ... nothing ever leaves the device" (`e774b2c`).

## Decision

Run the models (BioCLIP 2 for identification, CLIP for search and as a fallback) with `onnxruntime-node` inside the shared API process, comparing a photo's vector against reference vectors that ship in the catalog seed, on a worker thread (`packages/core/src/species/inferenceWorker.ts`), with a priority queue and timeouts on the main thread (`inference.ts`). From `inferenceWorker.ts`: it's a worker "because onnxruntime blocks the calling thread", and it "Imports nothing from the rest of the app so the desktop inference sidecar can reuse it as is" (used for [matching on the desktop while connected to a server](../state-and-sync.md#desktop-app-connected-to-a-server)).

Model files are downloaded on first use and checked against pinned SHA-256 hashes, "so a truncated or tampered download is caught before it's ever loaded" (`modelChecksums.ts`). On a machine with a usable GPU, `acceleration.ts` checks the GPU gives the same answers as the CPU and is faster before switching. GPU runtime libraries (CUDA and the onnxruntime GPU build) are "downloaded once ... and only on machines with a card, so CPU-only installs and the Docker image carry none of it", and "Every file is pinned by sha256" (`apps/api/src/species/gpuRuntime.ts`).

## Alternatives considered

- **A Python service** (the usual way to run these models): never used by the app. Python appears only in the maintainer pipeline, to compute reference vectors and export the models ([Rebuilding the data](../rebuilding-data.md#the-model-files)).
- **Matching on the main thread:** the first version (`e774b2c`); moved to a worker so that a batch of photos doesn't block requests.
- **Matching in the Rust shell:** tried and shelved. A desktop-only proof of concept ran BioCLIP in a Rust crate, called from the web app through Tauri commands, and matched photos against region-scoped candidate packs (birds and mammals of British Columbia, fish of the Red Sea). End-to-end testing showed an accuracy regression, and it was shelved. It never reached the repository's history. Beyond the regression, it had a structural problem: matching that lives in the Tauri shell can't serve a Docker server, while matching in the shared Node API serves both.

  **The regression was never root-caused.** Anyone revisiting Rust-side or desktop-only matching should find out what regressed before building on that design again.

  The same work included an experiment worth keeping: **separate reference vectors per form** (male, female, juvenile) instead of one averaged vector per species. Photos for each form came from iNaturalist observations filtered by their Sex and Life Stage annotations. In a held-out test this measurably fixed a real misidentification involving Mallard and Savannah Sparrow. The current matcher keeps one set of reference vectors per species with no per-form split, so this is a candidate improvement for species whose sexes or ages look different.

## Consequences

Positive:

- No extra service, container or language runtime for users to run; the same code matches on desktop and server.
- Photos never leave the machine for identification.
- GPU support costs nothing on machines without one, and is used only when it's verified to give the same results.

Negative:

- **Memory:** the models live in the API's process. Two large models need roughly 4 GB of RAM to be comfortable ([Requirements](../../install/requirements.md#memory)); models are unloaded when idle (`d3d29bd`).
- **A hung model run can only be handled by restarting the worker**, which the queue does on timeout.
- **Large optional downloads:** about 620 MB of models, and about 2.7 GB of NVIDIA runtime libraries from PyPI and NuGet on servers with an NVIDIA card. Every pinned version needs its hashes updated by hand.
- **Platform gaps:** onnxruntime stopped publishing Intel Mac binaries after 1.23, so the Intel app ships an older onnxruntime that some quantized models don't support ([Desktop app](../desktop-app.md#intel-macs)).

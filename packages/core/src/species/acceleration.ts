// Where each model runs: the CPU, or a GPU backend the hardware self-test (accelerationSelect.ts)
// found faster and correct on this machine, with the model copy that backend runs best (the int8
// file on the CPU, full precision on a GPU). Everything that builds an inference target asks here.
// Config-free, for the desktop's inference sidecar too.
import { existsSync } from "node:fs";
import type { ProviderSpec } from "./inferenceWorker.js";

export type ModelFamily = "detector" | "id" | "clip";

export interface Placement {
  /** "cpu", "cuda", "webgpu", "coreml" or "dml". */
  backend: string;
  modelPath: string;
  providers: ProviderSpec[];
}

export interface AccelerationPlan {
  /** What the GPU is called, for Settings; null when everything runs on the CPU. */
  device: string | null;
  /** A downloaded GPU runtime the inference process must load (gpuRuntime.ts), or null. */
  runtime: { id: string; ortModule: string; libraryPath: string } | null;
  placements: Partial<Record<ModelFamily, Placement>>;
}

let plan: AccelerationPlan = { device: null, runtime: null, placements: {} };
const listeners = new Set<(plan: AccelerationPlan) => void>();

export function currentPlan(): AccelerationPlan {
  return plan;
}

export function setPlan(next: AccelerationPlan): void {
  plan = next;
  for (const l of listeners) l(next);
}

export function onPlanChange(listener: (plan: AccelerationPlan) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The file and backend for a model: the plan's, while its file is there, else the CPU one. */
export function placementFor(family: ModelFamily, cpuPath: string): { modelPath: string; providers?: ProviderSpec[] } {
  const p = plan.placements[family];
  if (!p || p.backend === "cpu" || !existsSync(p.modelPath)) return { modelPath: cpuPath };
  return { modelPath: p.modelPath, providers: p.providers };
}

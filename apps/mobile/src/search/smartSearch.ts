// Smart search offline for a paired phone: keeps the hub's text encoder, every photo's vector, and
// what the hub read of each frame (subject box, light, background vector) on the phone, and answers a typed query by embedding it here and ranking locally. Starts by itself
// after pairing; the person can remove it in Settings, and search then falls back to the hub, then names.
import { downloadsAllowed } from "../media/cache";
import type { Db } from "../store/db";
import type { Settings } from "../store/settings";
import type { HubApi } from "../sync/hubApi";
import { clearFrames, syncFrames } from "./frameStore";
import { cachedEmbedder, phoneScorer, searchLocal, type LocalResult } from "./localSearch";
import { ensureModel, loadModelState, modelBytes, removeModel, type ModelFs } from "./modelDownload";
import type { TextEmbedder } from "./textEmbedder";
import { clearVectors, loadVectorState, syncVectors, vectorCount, VectorIndex } from "./vectorStore";

export type SmartPhase = "off" | "idle" | "downloading" | "syncing" | "ready" | "waiting" | "unavailable" | "error";

export interface SmartStatus {
  phase: SmartPhase;
  /** Download progress in bytes, or photo vectors pulled so far. */
  done: number;
  total: number;
  /** What the downloaded model takes on the phone. */
  modelBytes: number;
  vectors: number;
  /** Photos whose background vector is on the phone, counted in the storage line with the vectors. */
  backgrounds: number;
}

export interface SmartDeps {
  db: Db;
  fs: ModelFs;
  api: () => HubApi | null;
  settings: () => Settings;
  metered: () => Promise<boolean>;
  loadEmbedder: () => Promise<TextEmbedder>;
  /** How long the background vectors stay in memory after the last query that used them. */
  behindIdleMs?: number;
}

const BEHIND_IDLE_MS = 120_000;

export class SmartSearch {
  private snapshot: SmartStatus = { phase: "idle", done: 0, total: 0, modelBytes: 0, vectors: 0, backgrounds: 0 };
  private listeners = new Set<() => void>();
  private usable = false;
  private busy = false;
  private stopRequested = false;
  private embedder: Promise<TextEmbedder> | null = null;
  private index: Promise<VectorIndex> | null = null;
  private loaded: VectorIndex | null = null;
  private behind: Promise<VectorIndex> | null = null;
  private behindTimer: ReturnType<typeof setTimeout> | null = null;
  private scorer: ReturnType<typeof phoneScorer> | null = null;
  private embed: ReturnType<typeof cachedEmbedder> | null = null;
  private backgroundScorer: ReturnType<typeof phoneScorer> | null = null;

  constructor(private readonly d: SmartDeps) {}

  getStatus = (): SmartStatus => this.snapshot;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<SmartStatus>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Whether a typed query can be answered on the phone right now. */
  get ready(): boolean {
    return this.usable;
  }

  /** Reads what is already on the phone. */
  async load(): Promise<void> {
    const [model, vectors] = await Promise.all([loadModelState(this.d.db), loadVectorState(this.d.db)]);
    this.usable = !!model?.complete && !!vectors?.complete && this.d.settings().smartSearch;
    this.set({
      phase: !this.d.settings().smartSearch ? "off" : this.usable ? "ready" : "idle",
      modelBytes: await modelBytes(this.d.db, this.d.fs),
      vectors: await vectorCount(this.d.db),
      backgrounds: await vectorCount(this.d.db, "capture_backgrounds"),
    });
  }

  private allowed = () => downloadsAllowed({ settings: this.d.settings, metered: this.d.metered });

  /** Brings the model and the photo vectors up to date. Safe to call often: one run at a time, and a wait for Wi-Fi is just a wait. */
  async refresh(): Promise<void> {
    const api = this.d.api();
    if (!api || this.busy) return;
    if (!this.d.settings().smartSearch) return this.set({ phase: "off" });
    this.busy = true;
    this.stopRequested = false;
    try {
      this.set({ phase: this.usable ? "ready" : "downloading", done: 0, total: 0 });
      const model = await ensureModel({
        db: this.d.db,
        fs: this.d.fs,
        api,
        allowed: this.allowed,
        stopped: () => this.stopRequested,
        onProgress: (done, total) => this.set({ phase: "downloading", done, total }),
      });
      if (model !== "ready") {
        this.usable = false;
        return this.set({ phase: model === "stopped" ? "off" : model });
      }
      const wasUsable = this.usable;
      this.set({
        phase: wasUsable ? "ready" : "syncing",
        done: 0,
        total: 0,
        modelBytes: await modelBytes(this.d.db, this.d.fs),
      });
      const vectors = await syncVectors({
        db: this.d.db,
        api,
        allowed: async () => !this.stopRequested && (await this.allowed()),
        onProgress: (n) => this.set({ done: n }),
      });
      if (vectors.changed > 0) this.dropIndex();
      this.usable = vectors.complete && !this.stopRequested && this.d.settings().smartSearch;
      // Frames and backgrounds only sharpen the answers: a hub without them, or a failed pull, leaves search usable.
      if (vectors.complete)
        try {
          const frames = await syncFrames({
            db: this.d.db,
            api,
            allowed: async () => !this.stopRequested && (await this.allowed()),
            onProgress: (n) => !wasUsable && this.set({ done: vectors.changed + n }),
          });
          if (frames.changed > 0) this.dropIndex();
        } catch {
          // tried again at the next refresh
        }
      this.set({
        phase: this.usable ? "ready" : this.stopRequested ? "off" : "waiting",
        vectors: await vectorCount(this.d.db),
        backgrounds: await vectorCount(this.d.db, "capture_backgrounds"),
      });
    } catch {
      this.set({ phase: this.usable ? "ready" : "error" });
    } finally {
      this.busy = false;
    }
  }

  private dropIndex(): void {
    this.index = null;
    this.loaded = null;
    this.dropBehind();
  }

  private dropBehind(): void {
    if (this.behindTimer) clearTimeout(this.behindTimer);
    this.behindTimer = null;
    this.behind = null;
  }

  /** The background vectors, read only when a query asks for them and let go after a while unused. */
  private async behindIndex(): Promise<VectorIndex> {
    this.behind ??= VectorIndex.load(this.d.db, "capture_backgrounds");
    const index = await this.behind;
    if (this.behindTimer) clearTimeout(this.behindTimer);
    this.behindTimer = setTimeout(() => this.dropBehind(), this.d.behindIdleMs ?? BEHIND_IDLE_MS);
    return index;
  }

  /** Ranked photos for a query, or null when the phone cannot answer it (the caller falls back). */
  async search(text: string): Promise<LocalResult | null> {
    if (!this.usable) return null;
    try {
      this.embedder ??= this.d.loadEmbedder();
      this.index ??= VectorIndex.load(this.d.db);
      const [embedder, index] = await Promise.all([this.embedder, this.index]);
      this.loaded = index;
      // One embedding cache for both scorers: a description is embedded once.
      const embed = (this.embed ??= cachedEmbedder((texts) => embedder.embedTexts(texts)));
      this.scorer ??= phoneScorer(embed, () => this.loaded!);
      this.backgroundScorer ??= phoneScorer(embed, () => this.behindIndex());
      const hasBackgrounds = (await vectorCount(this.d.db, "capture_backgrounds")) > 0;
      return await searchLocal(this.d.db, text, this.scorer, hasBackgrounds ? this.backgroundScorer : undefined);
    } catch {
      this.embedder = null;
      this.scorer = null;
      this.backgroundScorer = null;
      this.embed = null;
      return null;
    }
  }

  /** Drops the model and every stored vector. The caller turns the setting off. */
  async remove(): Promise<void> {
    this.stopRequested = true;
    this.usable = false;
    const embedder = this.embedder;
    this.embedder = null;
    this.scorer = null;
    this.backgroundScorer = null;
    this.embed = null;
    this.dropIndex();
    await embedder?.then((e) => e.release()).catch(() => undefined);
    await removeModel(this.d.db, this.d.fs);
    await clearVectors(this.d.db);
    await clearFrames(this.d.db);
    this.set({ phase: "off", done: 0, total: 0, modelBytes: 0, vectors: 0, backgrounds: 0 });
  }
}

import { readFileSync } from "node:fs";
import { SMART_TAG_VOCAB } from "@lifer/shared";
import { describe, expect, it } from "vitest";
import {
  calibrate,
  clipTerms,
  evaluate,
  fitThreshold,
  formatLabels,
  formatReport,
  type LabelRow,
  parseLabels,
  parseVocabulary,
  scorePhoto,
  splitHalves,
} from "./calibration.js";

const vocab = parseVocabulary(JSON.parse(readFileSync(new URL("./fixtures/vocab.json", import.meta.url), "utf8")));

const row = (photo: string, session: string, taken = "", present: string[] = [], absent: LabelRow["absent"] = "*") => ({
  photo,
  session,
  taken,
  present,
  absent,
});

describe("splitHalves", () => {
  it("never puts one session on both sides and balances photo counts", () => {
    const rows = Array.from({ length: 40 }, (_, s) =>
      Array.from({ length: 1 + (s % 7) }, (_, i) => row(`trip${s}/p${i}.jpg`, `s${s}`)),
    ).flat();
    const halves = splitHalves(rows);
    const sideOf = new Map<string, Set<number>>();
    for (const r of rows) sideOf.set(r.session, (sideOf.get(r.session) ?? new Set()).add(halves.get(r.photo)!));
    for (const sides of sideOf.values()) expect(sides.size).toBe(1);
    const fit = rows.filter((r) => halves.get(r.photo) === 0).length;
    expect(Math.abs(fit - (rows.length - fit))).toBeLessThanOrEqual(7);
  });

  it("keeps a burst together even when its frames carry different session ids", () => {
    const rows = [
      row("a/1.jpg", "x", "2026-05-01T10:00:00Z"),
      row("a/2.jpg", "y", "2026-05-01T10:00:04Z"),
      row("a/3.jpg", "z", "2026-05-01T10:00:09Z"),
      row("b/1.jpg", "w", "2026-05-01T10:00:05Z"),
      ...Array.from({ length: 30 }, (_, i) => row(`c/${i}.jpg`, `other${i}`)),
    ];
    const halves = splitHalves(rows);
    expect(new Set(["a/1.jpg", "a/2.jpg", "a/3.jpg"].map((p) => halves.get(p))).size).toBe(1);
    expect(halves.size).toBe(rows.length);
  });

  it("is deterministic", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`p${i}.jpg`, `s${i % 9}`));
    expect(Object.fromEntries(splitHalves(rows))).toEqual(Object.fromEntries(splitHalves([...rows].reverse())));
  });
});

describe("fitThreshold", () => {
  it("picks the lowest score that keeps precision at the target", () => {
    // 10 positives on top, then a negative, then mixed.
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({ score: 0.9 - i * 0.01, positive: true })),
      { score: 0.7, positive: false },
      { score: 0.69, positive: true },
      { score: 0.68, positive: false },
      { score: 0.67, positive: false },
    ];
    // 11/12 = 91.7% at 0.69 fails 95%; 10/10 at 0.81 passes.
    expect(fitThreshold(points, 0.95)).toBeCloseTo(0.81);
    expect(fitThreshold(points, 0.9)).toBeCloseTo(0.69);
  });

  it("needs a minimum number of hits and returns null when the target is unreachable", () => {
    expect(fitThreshold([{ score: 0.9, positive: true }], 0.95)).toBeNull();
    expect(
      fitThreshold(
        Array.from({ length: 20 }, (_, i) => ({ score: i / 20 + 0.01, positive: i % 2 === 0 })),
        0.95,
      ),
    ).toBeNull();
  });

  it("keeps tied scores on the same side", () => {
    const points = [
      ...Array.from({ length: 6 }, () => ({ score: 0.8, positive: true })),
      { score: 0.5, positive: true },
      { score: 0.5, positive: false },
    ];
    expect(fitThreshold(points, 0.95)).toBe(0.8);
  });

  it("ignores zero scores (a pick-one term that lost)", () => {
    const points = [...Array.from({ length: 5 }, () => ({ score: 0.9, positive: true })), { score: 0, positive: true }];
    expect(fitThreshold(points, 0.95)).toBe(0.9);
    expect(evaluate(points, 0.9)).toMatchObject({ predicted: 5, precision: 1, recall: 5 / 6 });
  });
});

describe("scorePhoto", () => {
  it("gives a pick-one group one winner and a 'none' win scores every member 0", () => {
    const terms = vocab.terms.filter((t) => t.prompts.length);
    const tv = new Map(terms.map((t, i) => [t.id, Array.from({ length: 4 }, (_, j) => (j === i % 4 ? 1 : 0))]));
    const none = new Map([["subject", [0, 0, 0, 1]]]);
    const bird = tv.get("subject.bird")!;
    const s = scorePhoto(bird, terms, tv, none);
    const group = terms.filter((t) => t.pickOne === "subject").map((t) => s.get(t.id)!);
    expect(group.filter((x) => x > 0)).toHaveLength(1);
    expect(s.get("subject.bird")).toBeGreaterThan(0.5);
    const lost = scorePhoto([0, 0, 0, 1], terms, tv, new Map([["subject", [0, 0, 0, 2]]]));
    expect(terms.filter((t) => t.pickOne === "subject").every((t) => lost.get(t.id) === 0)).toBe(true);
  });
});

describe("labels and vocabulary", () => {
  it("round-trips the labels TSV", () => {
    const rows: LabelRow[] = [
      row("a/1.jpg", "2026-05-01 a", "2026-05-01T10:00:00Z", ["habitat.wetland"]),
      row("ref:1", "sp1", "", [], ["x", "y"]),
    ];
    expect(parseLabels(formatLabels(rows))).toEqual(rows);
  });

  it("reads facets, names and pick-one groups from the vocabulary", () => {
    const wet = vocab.terms.find((t) => t.id === "habitat.wetland");
    expect(wet).toMatchObject({ facet: "Habitat", label: "Wetland", pickOne: undefined });
    expect(vocab.terms.find((t) => t.id === "subject.bird")?.pickOne).toBe("subject");
    expect(vocab.none.subject.length).toBeGreaterThan(0);
    expect(vocab.none.time).toEqual([]);
  });

  it("parses the shipped vocabulary, with none prompts for every pick-one group that CLIP scores", () => {
    const real = parseVocabulary(SMART_TAG_VOCAB);
    const groups = new Set(clipTerms(real).flatMap((t) => (t.pickOne ? [t.pickOne] : [])));
    for (const g of groups) expect(real.none[g]?.length, g).toBeGreaterThan(0);
  });
});

describe("calibrate and report", () => {
  it("fits on one half, judges the other, and flags terms that clear the bar", () => {
    const terms = vocab.terms.filter((t) => t.id === "habitat.wetland" || t.id === "context.in-hand");
    const rows: LabelRow[] = [];
    const scores = new Map<string, Map<string, number>>();
    for (let s = 0; s < 60; s++)
      for (let i = 0; i < 4; i++) {
        const photo = `s${s}/${i}.jpg`;
        const wet = i < 2;
        rows.push(row(photo, `s${s}`, "", wet ? ["habitat.wetland"] : []));
        // Wetland separates cleanly; In hand is noise.
        scores.set(
          photo,
          new Map([
            ["habitat.wetland", wet ? 0.3 + (s % 5) * 0.01 : 0.1],
            ["context.in-hand", ((s * 7 + i) % 10) / 10 + 0.01],
          ]),
        );
      }
    const halves = splitHalves(rows);
    const results = calibrate(terms, rows, scores, halves);
    const wet = results.find((r) => r.id === "habitat.wetland")!;
    expect(wet).toMatchObject({ validated: true, status: "passes", precision: 1, recall: 1 });
    expect(wet.threshold).toBeGreaterThan(0.1);
    const hand = results.find((r) => r.id === "context.in-hand")!;
    expect(hand.validated).toBe(false);
    const report = formatReport(results, {
      labelsFile: "labels.tsv",
      vocabVersion: "fixture",
      settings: { fitPrecision: 0.95, bar: 0.9, minPredicted: 50 },
      photos: [120, 120],
      sessions: [30, 30],
    });
    expect(report).toContain("1 of 2 terms pass: Wetland.");
    expect(report).toMatch(/Habitat\s+Wetland\s+passes/);
    expect(report).not.toContain(String.fromCharCode(0x2014));
  });

  it("calls a term with too few held-out hits not measured", () => {
    const terms = vocab.terms.filter((t) => t.id === "habitat.wetland");
    const rows = Array.from({ length: 40 }, (_, i) => row(`p${i}.jpg`, `s${i}`, "", i % 2 ? ["habitat.wetland"] : []));
    const scores = new Map(rows.map((r) => [r.photo, new Map([["habitat.wetland", r.present.length ? 0.4 : 0.1]])]));
    expect(calibrate(terms, rows, scores, splitHalves(rows))[0].status).toBe("not measured");
  });
});

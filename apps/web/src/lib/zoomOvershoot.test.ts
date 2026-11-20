import { describe, expect, it } from "vitest";
import { KEY_LEVELS, NO_OVERSHOOT, overshootStep, pinchLevels, wheelLevels, type Overshoot } from "./zoomOvershoot";

function run(inputs: Array<Parameters<typeof overshootStep>[1]>) {
  let state: Overshoot = NO_OVERSHOOT;
  return inputs.map((input) => {
    const r = overshootStep(state, input);
    state = r.state;
    return r.status;
  });
}

describe("zoom overshoot", () => {
  it("lets go after a trackpad pinch of about 0.6 levels past the framing", () => {
    // A pinch sends many small ctrl wheel events.
    const statuses = run(
      Array.from({ length: 5 }, (_, i) => ({ kind: "out", levels: wheelLevels(13, true), at: i * 16 })),
    );
    expect(statuses.slice(0, 4)).toEqual(["building", "building", "building", "building"]);
    expect(statuses.at(-1)).toBe("released");
  });

  it("takes three mouse wheel notches, or a second burst soon after the first", () => {
    const notch = wheelLevels(100, false);
    expect(run([1, 2, 3].map((i) => ({ kind: "out", levels: notch, at: i * 100 })))).toEqual([
      "building",
      "building",
      "released",
    ]);
  });

  it("lets go on a touch pinch out, and on a second '-' press", () => {
    expect(run([{ kind: "out", levels: pinchLevels(300, 180), at: 0 }])).toEqual(["released"]);
    expect(
      run([
        { kind: "out", levels: KEY_LEVELS, at: 0 },
        { kind: "out", levels: KEY_LEVELS, at: 300 },
      ]),
    ).toEqual(["building", "released"]);
  });

  it("starts over after a pause of half a second", () => {
    expect(
      run([
        { kind: "out", levels: 0.4, at: 0 },
        { kind: "out", levels: 0.4, at: 700 },
      ]),
    ).toEqual(["building", "building"]);
  });

  it("starts over on zooming in, a pan or Reset view", () => {
    expect(
      run([
        { kind: "out", levels: 0.4, at: 0 },
        { kind: "reset", at: 100 },
        { kind: "out", levels: 0.4, at: 200 },
      ]),
    ).toEqual(["building", "held", "building"]);
  });

  it("lets go again from the country to the world, once per overshoot", () => {
    expect(
      run([
        { kind: "out", levels: 0.7, at: 0 },
        { kind: "out", levels: 0.3, at: 100 },
        { kind: "out", levels: 0.3, at: 200 },
      ]),
    ).toEqual(["released", "building", "released"]);
  });
});

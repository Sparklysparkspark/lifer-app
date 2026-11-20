import { describe, expect, it } from "vitest";
import { taskbarStateFor } from "./useTaskbarProgress";

describe("taskbarStateFor", () => {
  it("hides the bar when nothing runs", () => {
    expect(taskbarStateFor({ running: 0, progress: null })).toEqual({ status: "none" });
  });
  it("shows a busy bar when running jobs can't say how far along they are", () => {
    expect(taskbarStateFor({ running: 2, progress: null })).toEqual({ status: "indeterminate" });
  });
  it("shows a percentage, kept between 0 and 100", () => {
    expect(taskbarStateFor({ running: 1, progress: 0.426 })).toEqual({ status: "normal", progress: 43 });
    expect(taskbarStateFor({ running: 1, progress: 4 })).toEqual({ status: "normal", progress: 100 });
  });
});

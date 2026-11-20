import { describe, expect, it } from "vitest";
import { EBIRD_ONLY_MAX_RECORDS, judgeEbirdOnly } from "./check-ebird-only.js";

describe("judgeEbirdOnly", () => {
  it("drops a thin eBird-only listing no open list names", () => {
    expect(judgeEbirdOnly({ records: 2 }, false, false)).toBe("unsupported");
  });
  it("keeps one an open list names, or with enough records", () => {
    expect(judgeEbirdOnly({ records: 2 }, true, false)).toBe("keep");
    expect(judgeEbirdOnly({ records: EBIRD_ONLY_MAX_RECORDS }, false, false)).toBe("keep");
  });
  it("drops a split whose accepted species is already listed", () => {
    expect(judgeEbirdOnly({ records: 40 }, true, true)).toBe("duplicate");
  });
});

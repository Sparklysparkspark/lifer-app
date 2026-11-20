import { describe, expect, it } from "vitest";
import { parseLuaTable } from "./luaTable.js";
import { mapSmartRules } from "./smartRules.js";

const rules = (body: string) => mapSmartRules(parseLuaTable(`s = { combine = "intersect", rules = { ${body} } }`));

describe("parseLuaTable", () => {
  it("reads nested tables, strings with escapes, numbers, booleans and comments", () => {
    expect(
      parseLuaTable(`s = {
        -- a comment
        name = "Great \\"Blue\\"", n = -1.5e1, ok = true, none = nil,
        list = { 1, 2, 3 },
        [ "odd key" ] = 'x',
      }`),
    ).toEqual({ name: 'Great "Blue"', n: -15, ok: true, none: null, list: [1, 2, 3], "odd key": "x" });
  });

  it("refuses anything that isn't plain data", () => {
    expect(() => parseLuaTable("s = { a = os.execute('x') }")).toThrow(/Unreadable/);
    expect(() => parseLuaTable("s = { a = 1 } trailing")).toThrow(/Unreadable/);
    expect(() => parseLuaTable('s = { a = "open')).toThrow(/Unreadable/);
  });
});

describe("mapSmartRules", () => {
  it("maps rating, date and keyword rules to Gallery filters", () => {
    expect(
      rules(`{ criteria = "rating", operation = ">=", value = 4 },
             { criteria = "captureTime", operation = "in", value = "2024-05-01", value2 = "2024-05-31" },
             { criteria = "keywords", operation = "any", value = "heron" }`),
    ).toEqual({
      rules: {
        version: 2,
        query: { ratingMin: "4", dateFrom: "2024-05-01", dateTo: "2024-05-31", tag: ["heron"] },
      },
    });
    expect(rules(`{ criteria = "rating", operation = ">", value = 2 }`)).toEqual({
      rules: { version: 2, query: { ratingMin: "3" } },
    });
  });

  it("reports what has no match instead of guessing", () => {
    expect(
      mapSmartRules(
        parseLuaTable(`s = { combine = "union", rules = { { criteria = "rating", operation = ">=", value = 4 } } }`),
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/any one rule/),
    });
    expect(rules(`{ criteria = "camera", operation = "any", value = "R5" }`)).toMatchObject({
      reason: expect.stringMatching(/camera/),
    });
    expect(
      rules(
        `{ criteria = "keywords", operation = "any", value = "a" }, { criteria = "keywords", operation = "any", value = "b" }`,
      ),
    ).toMatchObject({ reason: expect.stringMatching(/several keywords/) });
  });
});

import { describe, expect, it } from "vitest";
import { formatCoordinates, parseCoordinates } from "./coordinates";

const ok = (lat: number, lon: number) => ({ ok: true, lat, lon });
const near = (input: string, lat: number, lon: number) => {
  const r = parseCoordinates(input);
  expect(r.ok, input).toBe(true);
  if (!r.ok) return;
  expect(r.lat).toBeCloseTo(lat, 4);
  expect(r.lon).toBeCloseTo(lon, 4);
};

describe("parseCoordinates", () => {
  it("reads decimal degrees with a comma, a semicolon or a space", () => {
    expect(parseCoordinates("49.2827, -123.1207")).toEqual(ok(49.2827, -123.1207));
    expect(parseCoordinates("49.2827,-123.1207")).toEqual(ok(49.2827, -123.1207));
    expect(parseCoordinates("49.2827 -123.1207")).toEqual(ok(49.2827, -123.1207));
    expect(parseCoordinates("  -33.8568;151.2153 ")).toEqual(ok(-33.8568, 151.2153));
    expect(parseCoordinates("(-33.8568, 151.2153)")).toEqual(ok(-33.8568, 151.2153));
    expect(parseCoordinates("10 20")).toEqual(ok(10, 20));
    expect(parseCoordinates("+10.5, +20.25")).toEqual(ok(10.5, 20.25));
    expect(parseCoordinates("−33.5, 151")).toEqual(ok(-33.5, 151));
  });

  it("reads Google Maps' degrees, minutes and seconds", () => {
    near(`49°16'57.7"N 123°07'14.5"W`, 49.282694, -123.120694);
    near(`33°51'24.5"S 151°12'55.1"E`, -33.856806, 151.215306);
    near(`49°16′57.7″N 123°07′14.5″W`, 49.282694, -123.120694);
    near(`49° 16' 57.7" N, 123° 7' 14.5" W`, 49.282694, -123.120694);
    near(`N 49° 16' 57.7", W 123° 7' 14.5"`, 49.282694, -123.120694);
    near(`N 49 16 57.7 W 123 7 14.5`, 49.282694, -123.120694);
  });

  it("reads Apple Maps' degrees with hemisphere letters", () => {
    expect(parseCoordinates("49.2827° N, 123.1207° W")).toEqual(ok(49.2827, -123.1207));
    expect(parseCoordinates("33.8568° S, 151.2153° E")).toEqual(ok(-33.8568, 151.2153));
    expect(parseCoordinates("49.2827°N 123.1207°W")).toEqual(ok(49.2827, -123.1207));
    expect(parseCoordinates("49.2827 n, 123.1207 w")).toEqual(ok(49.2827, -123.1207));
  });

  it("reads degrees and decimal minutes", () => {
    near("49 16.962 N, 123 7.242 W", 49.2827, -123.1207);
    near("49°16.962'N 123°07.242'W", 49.2827, -123.1207);
  });

  it("takes longitude first when the letters say so", () => {
    expect(parseCoordinates("123.1207 W, 49.2827 N")).toEqual(ok(49.2827, -123.1207));
  });

  it("explains what it can't use", () => {
    expect(parseCoordinates("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCoordinates("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseCoordinates("Vancouver")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("49.2827")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("1, 2, 3")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("49.28.1, 12")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates(`49°75'00"N 123°07'14"W`)).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("49.5° 30' N, 12 E")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("-49 N, 12 E")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCoordinates("91, 0")).toEqual({ ok: false, reason: "latRange" });
    expect(parseCoordinates("-90.5, 0")).toEqual({ ok: false, reason: "latRange" });
    expect(parseCoordinates("0, 180.1")).toEqual({ ok: false, reason: "lonRange" });
    expect(parseCoordinates("49 N, 12 S")).toEqual({ ok: false, reason: "hemisphere" });
    expect(parseCoordinates("49 E, 12 W")).toEqual({ ok: false, reason: "hemisphere" });
  });

  it("accepts the edges of the range", () => {
    expect(parseCoordinates("90, 180")).toEqual(ok(90, 180));
    expect(parseCoordinates("-90, -180")).toEqual(ok(-90, -180));
    expect(parseCoordinates("0, 0")).toEqual(ok(0, 0));
  });
});

describe("formatCoordinates", () => {
  it("shows five decimals", () => {
    expect(formatCoordinates(49.2827, -123.1207)).toBe("49.28270, -123.12070");
  });
});

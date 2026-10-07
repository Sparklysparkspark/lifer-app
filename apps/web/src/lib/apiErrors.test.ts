import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { ApiError } from "../api/client";
import { API_ERROR_MESSAGE_KEYS, apiErrorMessage } from "./apiErrors";
import { errorMessage } from "./errorMessage";

// A stand-in translation, so the mapping is tested without shipping a real locale.
const TEST_LOCALE = "de";
i18n.addResourceBundle(TEST_LOCALE, "translation", {
  errors: { api: { desktop_only: "Nur in der Desktop-App verfügbar" } },
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("apiErrorMessage", () => {
  it("shows the server's English text in English, even for a known code", () => {
    expect(apiErrorMessage("no_checklist", "Africa has no checklist of its own.")).toBe("Africa has no checklist of its own.");
  });

  it("shows the active language's translation of a known code", async () => {
    await i18n.changeLanguage(TEST_LOCALE);
    expect(apiErrorMessage("desktop_only", "Only available in the desktop app")).toBe("Nur in der Desktop-App verfügbar");
  });

  it("keeps the server's text when the language has no translation of the code", async () => {
    await i18n.changeLanguage(TEST_LOCALE);
    expect(apiErrorMessage("not_added", "You haven't added that species")).toBe("You haven't added that species");
  });

  it("keeps the server's text for an unknown or missing code", async () => {
    await i18n.changeLanguage(TEST_LOCALE);
    expect(apiErrorMessage("brand_new_code", "Something new")).toBe("Something new");
    expect(apiErrorMessage(undefined, "No code")).toBe("No code");
  });

  it("falls back to the English message for a known code with no server text", () => {
    expect(apiErrorMessage("storage_move_failed", "")).toBe("Couldn't move this library");
  });

  it("can be asked for a specific language", () => {
    expect(apiErrorMessage("desktop_only", "server text", TEST_LOCALE)).toBe("Nur in der Desktop-App verfügbar");
  });
});

describe("ApiError and errorMessage", () => {
  it("translates by code, keeping the server's text and the code", async () => {
    await i18n.changeLanguage(TEST_LOCALE);
    const err = new ApiError(404, "Only available in the desktop app", "desktop_only");
    expect([err.message, err.serverMessage, err.code, err.status]).toEqual([
      "Nur in der Desktop-App verfügbar",
      "Only available in the desktop app",
      "desktop_only",
      404,
    ]);
    expect(errorMessage({ error: "Only available in the desktop app", code: "desktop_only" }, "fallback")).toBe(
      "Nur in der Desktop-App verfügbar",
    );
  });

  it("is unchanged in English", () => {
    expect(new ApiError(400, "Invalid body: rating must be <= 5", "invalid_request").message).toBe(
      "Invalid body: rating must be <= 5",
    );
    expect(errorMessage({ error: "Invalid body: x", code: "invalid_request" }, "fallback")).toBe("Invalid body: x");
  });
});

describe("the API error code audit", () => {
  // Every `code: "..."` literal the API and core send has a message key, and nothing stale is mapped.
  function codesIn(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return codesIn(full);
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
      return [...readFileSync(full, "utf8").matchAll(/\bcode: ?"([a-z0-9_]+)"/g)].map((m) => m[1]);
    });
  }

  it("covers exactly the codes apps/api and packages/core send", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const codes = new Set([...codesIn(join(root, "apps/api/src")), ...codesIn(join(root, "packages/core/src"))]);
    expect([...codes].sort()).toEqual(Object.keys(API_ERROR_MESSAGE_KEYS).sort());
  });

  it("has an English message for every code", () => {
    for (const key of Object.values(API_ERROR_MESSAGE_KEYS)) expect(i18n.exists(key, { lng: "en" })).toBe(true);
  });
});

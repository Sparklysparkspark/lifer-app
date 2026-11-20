// The desktop app has no Immich: every route answers 404 before sign-in or input is looked at.
import Fastify from "fastify";
import { afterAll, expect, it, vi } from "vitest";

process.env.SINGLE_USER_MODE = "1";
process.env.LIFER_LAUNCH_TOKEN = "immich-desktop-test";
const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);
const { immichRoutes } = await import("./routes.js");
const app = Fastify();
await app.register(immichRoutes, { prefix: "/api" });
afterAll(() => app.close());

it.each([
  ["GET", "/api/immich/status"],
  ["GET", "/api/immich/albums"],
  ["POST", "/api/immich/link"],
  ["POST", "/api/immich/sync"],
  ["PUT", "/api/immich/settings"],
] as const)("%s %s is refused in desktop mode", async (method, url) => {
  const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
  expect(res.statusCode).toBe(404);
  expect(res.json().code).toBe("server_only");
  expect(fetchSpy).not.toHaveBeenCalled();
});

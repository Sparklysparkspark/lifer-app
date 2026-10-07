import Fastify, { type FastifyInstance } from "fastify";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdParams, Nullable, Uuid, notFoundOnInvalidId, routeCatalog, withSchemas } from "./schema.js";

const ID = "eeeeeeee-0000-4000-8000-000000000001";

async function plugin(fastify: FastifyInstance) {
  const app = withSchemas(fastify);
  const scoped = Object.assign(async () => {}, { scope: "photos.read" });
  app.patch(
    "/things/:id",
    {
      config: notFoundOnInvalidId("Thing not found"),
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            rating: Nullable(Type.Integer({ minimum: 1, maximum: 5 })),
            mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])),
            sort: Type.Optional(Type.Enum(["newest", "oldest"])),
            name: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => ({ id: request.params.id, rating: request.body.rating }),
  );
  app.get(
    "/things",
    {
      preValidation: scoped,
      schema: {
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1 })),
          regionId: Type.Optional(Uuid()),
        }),
      },
    },
    async (request) => ({ query: request.query }),
  );
  app.get("/fails", { schema: {} }, async () => {
    throw Object.assign(new Error("Nope"), { statusCode: 409 });
  });
}

describe("schema validation", () => {
  let app: FastifyInstance;
  const patch = (payload: unknown, id = ID) =>
    app.inject({ method: "PATCH", url: `/things/${id}`, payload: payload as object });

  beforeAll(async () => {
    app = Fastify();
    // The parent's own handler, like the server's in index.ts: it must still get every other error.
    app.setErrorHandler((err, _request, reply) => {
      reply
        .code((err as { statusCode?: number }).statusCode ?? 500)
        .send({ error: `parent: ${(err as Error).message}` });
    });
    await app.register(plugin);
    await app.ready();
  });
  afterAll(() => app.close());

  it("lets valid input through, typed by the schema", async () => {
    const res = await patch({ rating: 4, mode: "b" });
    expect([res.statusCode, res.json()]).toEqual([200, { id: ID, rating: 4 }]);
    expect((await patch({ rating: null })).statusCode).toBe(200);
  });

  it("answers invalid bodies with a 400 saying what was wrong", async () => {
    const cases: Array<[unknown, string]> = [
      [{}, "rating is required"],
      [{ rating: "3" }, "rating must be integer"],
      [{ rating: 6 }, "rating must be <= 5"],
      [{ rating: 3, extra: true }, "unexpected field extra"],
      [{ rating: 3, mode: "c" }, "mode must be one of a, b"],
      [{ rating: 3, sort: "best" }, "sort must be one of newest, oldest"],
      [{ rating: 3, name: "" }, "name must not be empty"],
    ];
    for (const [body, message] of cases) {
      const res = await patch(body);
      expect([body, res.statusCode, res.json()]).toEqual([
        body,
        400,
        { error: `Invalid body: ${message}`, code: "invalid_request" },
      ]);
    }
  });

  it("uses the route's own answer for a malformed id", async () => {
    const res = await patch({ rating: 3 }, "not-a-uuid");
    expect([res.statusCode, res.json()]).toEqual([404, { error: "Thing not found" }]);
  });

  it("converts query strings, and treats an empty parameter as not given", async () => {
    const res = await app.inject({ method: "GET", url: "/things?limit=5&regionId=" });
    expect([res.statusCode, res.json()]).toEqual([200, { query: { limit: 5 } }]);
    for (const limit of ["2.5", "1e3", "0x10", "5abc"]) {
      const res = await app.inject({ method: "GET", url: `/things?limit=${limit}` });
      expect([limit, res.statusCode, res.json().error]).toEqual([limit, 400, "Invalid query: limit must be integer"]);
    }
    const bad = await app.inject({ method: "GET", url: "/things?limit=0" });
    expect([bad.statusCode, bad.json().error]).toEqual([400, "Invalid query: limit must be >= 1"]);
    const badId = await app.inject({ method: "GET", url: "/things?regionId=x" });
    expect(badId.json().error).toBe("Invalid query: regionId must be an id (a UUID)");
  });

  it("hands every other error to the parent's handler", async () => {
    const res = await app.inject({ method: "GET", url: "/fails" });
    expect([res.statusCode, res.json()]).toEqual([409, { error: "parent: Nope" }]);
  });

  it("catalogs routes with their schemas and API key scope", () => {
    expect(routeCatalog.get("GET /things")).toMatchObject({ scope: "photos.read", url: "/things" });
    expect(routeCatalog.get("PATCH /things/:id")?.schema?.params).toBe(IdParams);
    expect(routeCatalog.has("HEAD /things")).toBe(false);
  });
});

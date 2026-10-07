// Runtime request validation for every route: TypeBox schemas checked by TypeBox's own compiler,
// with handler types inferred from the same schemas. Rejections answer in the app's usual
// { error, code } shape (see integrations/openapi.ts).
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifySchemaCompiler,
  FastifySchemaValidationError,
  RouteOptions,
} from "fastify";
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type, type TSchema } from "typebox";

type HttpPart = "body" | "querystring" | "params" | "headers";

/** A route's own answer to invalid input in one part of the request, kept where clients rely on it
 *  (for example a malformed id answering 404 like an unknown one). */
export interface InvalidInputReply {
  status: number;
  error: string;
  code?: string;
}

declare module "fastify" {
  interface FastifyContextConfig {
    invalidInput?: Partial<Record<HttpPart, InvalidInputReply>>;
  }
}

/** Route config: a malformed path parameter answers 404 with `error`, as an unknown id does. */
export function notFoundOnInvalidId(error: string): { invalidInput: { params: InvalidInputReply } } {
  return { invalidInput: { params: { status: 404, error } } };
}

// --- Shared schema pieces ---

/** A UUID, any version, case-insensitive (the same rule as lib/validate.ts isUuid). */
export const Uuid = (options: { description?: string } = {}) => Type.String({ format: "uuid", ...options });

/** `{ id }` path parameters. */
export const IdParams = Type.Object({ id: Uuid() });

/** A value, or null to clear it. */
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** A query flag that is on when it's "1" (and off when left out). */
export const Flag = (description?: string) => Type.Optional(Type.Literal("1", description ? { description } : {}));

/** `{ ok: true }`, the answer of most write routes. */
export const Ok = Type.Object({ ok: Type.Boolean() });

/** Every error answer: `error` for a person, `code` for scripts. Extra fields some routes add
 *  (like a conflict's details) are passed through. */
export const ErrorBody = Type.Object(
  { error: Type.String(), code: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

/** Response schemas for a route answering `schema` with `status`, and errors otherwise. */
export function replies<T extends TSchema, S extends number = 200>(schema: T, status: S = 200 as S) {
  return { [status]: schema, "4xx": ErrorBody, "5xx": ErrorBody } as { [K in S]: T } & {
    "4xx": typeof ErrorBody;
    "5xx": typeof ErrorBody;
  };
}

// --- Validation and its errors ---

const MARK = "liferSchemas";

// Empty query parameters (`?regionId=`) mean "not given" to every handler, and the web app sends
// them, so they're dropped before validation instead of failing a uuid or number check.
function withoutEmptyValues(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== ""));
}

// TypeBox's conversion reads "2024.5" as the integer 2024 and "0x10" as 16. In a URL, a number
// has to be written plainly, so anything else fails before conversion can bend it.
const PLAIN = { integer: /^-?\d+$/, number: /^-?(\d+\.?\d*|\.\d+)$/ };

function numericKind(schema: unknown): "integer" | "number" | undefined {
  const s = schema as { type?: unknown; anyOf?: unknown[] } | undefined;
  if (s?.type === "integer" || s?.type === "number") return s.type;
  for (const branch of s?.anyOf ?? []) {
    const kind = numericKind(branch);
    if (kind) return kind;
  }
  return undefined;
}

function unplainNumbers(schema: TSchema, value: unknown): FastifySchemaValidationError[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties || !value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, raw]) => {
    const kind = numericKind(properties[name]);
    if (!kind || typeof raw !== "string" || PLAIN[kind].test(raw)) return [];
    return [
      {
        keyword: "type",
        instancePath: `/${name}`,
        schemaPath: `#/properties/${name}`,
        params: { type: kind },
        message: `must be ${kind}`,
      },
    ];
  });
}

const validatorCompiler: FastifySchemaCompiler<TSchema> = (route) => {
  const validate = TypeBoxValidatorCompiler(route);
  // Bodies are JSON with real numbers, and aren't converted.
  if (route.httpPart === "body") return validate;
  const strip = route.httpPart === "querystring";
  return (value: unknown) => {
    const input = strip ? withoutEmptyValues(value) : value;
    const errors = unplainNumbers(route.schema, input);
    return errors.length ? { error: errors } : validate(input);
  };
};

const PART_LABEL: Record<HttpPart, string> = { body: "body", querystring: "query", params: "path", headers: "header" };

const FORMAT_TEXT: Record<string, string> = {
  uuid: "must be an id (a UUID)",
  "date-time": "must be an ISO 8601 date-time",
  date: "must be a date (YYYY-MM-DD)",
};

function fieldName(instancePath: string): string {
  return instancePath.replace(/^\//, "").replaceAll("/", ".");
}

/** One plain sentence for the first problem TypeBox found, e.g. `rating must be <= 5`. */
export function describeValidationErrors(errors: FastifySchemaValidationError[]): string {
  // anyOf reports each branch and then itself; the branches say what was wrong.
  const first = errors.find((e) => e.keyword !== "anyOf" && e.keyword !== "boolean") ?? errors[0];
  if (!first) return "invalid value";
  const field = fieldName(first.instancePath);
  const subject = field || "value";
  const params = first.params as Record<string, unknown>;
  switch (first.keyword) {
    case "required": {
      const missing = (params.requiredProperties as string[] | undefined) ?? [];
      const names = missing.map((m) => (field ? `${field}.${m}` : m));
      return `${names.join(", ") || subject} ${names.length > 1 ? "are" : "is"} required`;
    }
    case "additionalProperties": {
      const extra = errors.find((e) => e.keyword === "additionalProperties")?.params as {
        additionalProperties?: string[];
      };
      const names = (extra?.additionalProperties ?? []).map((m) => (field ? `${field}.${m}` : m));
      return `unexpected field${names.length > 1 ? "s" : ""} ${names.join(", ")}`;
    }
    case "format":
      return `${subject} ${FORMAT_TEXT[String(params.format)] ?? `must be a ${String(params.format)}`}`;
    case "minLength":
    case "minItems":
      if (params.limit === 1) return `${subject} must not be empty`;
      return `${subject} ${first.message ?? "is too short"}`;
    case "enum":
      return `${subject} must be one of ${(params.allowedValues as unknown[]).join(", ")}`;
    case "const": {
      // A union of literals: list every allowed value at this path.
      const allowed = errors
        .filter((e) => e.keyword === "const" && e.instancePath === first.instancePath)
        .map((e) => String((e.params as { allowedValue?: unknown }).allowedValue));
      return `${subject} must be ${allowed.length > 1 ? `one of ${allowed.join(", ")}` : allowed[0]}`;
    }
    default:
      return `${subject} ${first.message ?? "is invalid"}`;
  }
}

/** Answers a schema validation error, honouring the route's `invalidInput` config. Returns false
 *  for any other error. */
export function replyToValidationError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): boolean {
  if (!error.validation) return false;
  const part = (error.validationContext ?? "body") as HttpPart;
  const custom = request.routeOptions.config.invalidInput?.[part];
  if (custom) {
    reply.code(custom.status).send({ error: custom.error, ...(custom.code && { code: custom.code }) });
    return true;
  }
  const detail = describeValidationErrors(error.validation as FastifySchemaValidationError[]);
  reply.code(400).send({ error: `Invalid ${PART_LABEL[part] ?? part}: ${detail}`, code: "invalid_request" });
  return true;
}

// --- Route catalog, for the OpenAPI document and the schema coverage test ---

export interface CatalogRoute {
  method: string;
  url: string;
  schema: RouteOptions["schema"];
  /** The API key scope from requireScope, when a key can reach the route. */
  scope?: string;
  /** The sign-in hook guarding the route ("session" for requireAuth, "scope" for requireScope),
   *  or null for a public one. Read by apiRoutes.test.ts's auth coverage test. */
  auth: AuthHookKind | null;
  /** The route's handler, for apiRoutes.test.ts's read-only GET check. */
  handler: RouteOptions["handler"];
}

/** Sign-in hooks carry their kind as a property (auth/session.ts marks them), so the catalog can
 *  tell a guarded route from a public one without importing the session module. */
export type AuthHookKind = "session" | "scope";

/** Every route registered through withSchemas, by "METHOD /url". */
export const routeCatalog = new Map<string, CatalogRoute>();

function hookList(route: RouteOptions): unknown[] {
  return [route.onRequest, route.preValidation, route.preHandler].flatMap((h) => (Array.isArray(h) ? h : [h]));
}

function scopeOf(hooks: unknown[]): string | undefined {
  for (const hook of hooks) {
    const scope = (hook as { scope?: unknown } | undefined)?.scope;
    if (typeof scope === "string") return scope;
  }
  return undefined;
}

function authOf(hooks: unknown[]): AuthHookKind | null {
  for (const hook of hooks) {
    const kind = (hook as { authKind?: unknown } | undefined)?.authKind;
    if (kind === "session" || kind === "scope") return kind;
  }
  return null;
}

function recordRoute(route: RouteOptions): void {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const hooks = hookList(route);
  for (const method of methods) {
    // Fastify adds a HEAD for every GET; it isn't a route of its own.
    if (method === "HEAD" && route.exposeHeadRoute === undefined && routeCatalog.has(`GET ${route.url}`)) continue;
    routeCatalog.set(`${method} ${route.url}`, {
      method,
      url: route.url,
      schema: route.schema,
      scope: scopeOf(hooks),
      auth: authOf(hooks),
      handler: route.handler,
    });
  }
}

/** Sets up schema validation and the route catalog on `app` and its children. The server calls it
 *  once at the root; route plugins call withSchemas, which does it too when registered on their
 *  own (as tests do). */
export function installSchemas(app: FastifyInstance): void {
  if (app.hasDecorator(MARK)) return;
  app.decorate(MARK, true);
  app.setValidatorCompiler(validatorCompiler);
  app.addHook("onRoute", recordRoute);
}

/** The TypeBox-typed view of a route plugin's instance. Registered on its own (in a test), it also
 *  answers validation errors itself and hands every other error to the parent's handler. */
export function withSchemas(app: FastifyInstance) {
  if (!app.hasDecorator(MARK)) {
    installSchemas(app);
    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (!replyToValidationError(error, request, reply)) throw error;
    });
  }
  return app.withTypeProvider<TypeBoxTypeProvider>();
}

export type TypedApp = ReturnType<typeof withSchemas>;

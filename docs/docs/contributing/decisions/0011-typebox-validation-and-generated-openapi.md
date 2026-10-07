---
id: 0011-typebox-validation-and-generated-openapi
title: "ADR 0011: TypeBox validation and generated OpenAPI"
description: Every API route declares a TypeBox schema, which validates requests, types handlers, and generates the OpenAPI document.
---

# ADR 0011: Request validation with TypeBox, and an OpenAPI document generated from it

**Status:** Accepted, in the next release (listed under Unreleased in `CHANGELOG.md`).

## Context

Before this change, routes checked their input with small hand-written helpers (`apps/api/src/lib/validate.ts`, added "so malformed ids and dates get a 400 instead of reaching a Postgres cast and surfacing as a 500"), and the OpenAPI document for integrations was written by hand and kept in step by a test (`ba22c7d`).

## Decision

Every `/api` route declares a schema for its params, query, body and responses with TypeBox, compiled by TypeBox's own validator through `@fastify/type-provider-typebox`, "with handler types inferred from the same schemas" (`apps/api/src/lib/schema.ts`). Invalid input gets a 400 with `code: invalid_request` naming the field, unless a route declares its own answer (for example a malformed id answering 404 like an unknown one). `/api/openapi.json` is generated from the registered routes and their schemas. A test registers every route and fails if one has no schema or its path parameters don't match (`apps/api/src/apiRoutes.test.ts`).

From the changelog: "`/api/openapi.json` is generated from the routes, so it always matches what the server accepts."

TypeBox was chosen because one schema is at once the runtime validator, the TypeScript type and the OpenAPI document, so each route has one definition. TypeBox schemas are JSON Schema, which is what Fastify validates natively and what OpenAPI uses, so nothing is converted between the three.

## Alternatives considered

- **Hand-written checks and a hand-written OpenAPI document:** the previous approach; the document could drift from the code.
- **Zod or `@fastify/swagger`:** never used in the repository.

## Consequences

Positive:

- Nothing reaches a handler unchecked, enforced by a test.
- Handler types and the API description come from the same source as validation.
- Clients get a consistent error shape.

Negative:

- Multipart uploads, tus and file downloads can't be fully described by these schemas and are documented by hand (`apps/api/src/integrations/openapi.ts`).
- More declaration code per route.
- Validation guarantees the shape of input, not that a route is authorised: the schema test doesn't check that routes have an auth hook ([Security model](../../security-model.md#internet-exposed-behind-a-reverse-proxy)).

# Lifer desktop

The desktop app: the web app (`apps/web`) inside a Tauri window, with the API (`apps/api`) as a
sidecar process and an embedded Postgres, so it runs with no Docker or separate database.

```bash
npm start -w desktop     # development, with hot reload
npm run dist -w desktop  # build an installer for this platform
```

How it fits together, each build step, and the helper scripts are documented on the
[Desktop app](https://sparklysparkspark.github.io/lifer-app/contributing/desktop-app) page of
the contributor docs (source: [`docs/docs/contributing/desktop-app.md`](../../docs/docs/contributing/desktop-app.md)).
For the full local setup, see [Development setup](https://sparklysparkspark.github.io/lifer-app/contributing/development).

// Values shared by the Playwright config, the server launcher and the specs.

// Off the dev ports (4000 API, 5173 Vite), so an e2e run and a dev server can coexist.
export const API_PORT = Number(process.env.E2E_PORT ?? 4517);
export const MIRROR_PORT = Number(process.env.E2E_MIRROR_PORT ?? 4518);
export const BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const MIRROR_URL = `http://127.0.0.1:${MIRROR_PORT}`;

// Used when E2E_DATABASE_URL isn't set: the launcher starts this throwaway container itself.
export const LOCAL_PG_CONTAINER = "lifer-e2e-postgres";
export const LOCAL_PG_PORT = 55450;
export const LOCAL_DATABASE_URL = `postgres://lifer:lifer@127.0.0.1:${LOCAL_PG_PORT}/lifer_e2e`;

// The one account the first-run spec creates. Other specs sign in with it.
export const ACCOUNT = { email: "e2e@lifer.test", password: "correct horse battery staple" };

// Signed-in browser state saved by the first-run spec, reused by the specs that depend on it.
export const AUTH_STATE_PATH = "test-results/.auth/user.json";

// @vitest-environment jsdom
// Sightings held back because they may already be on iNaturalist: never a dead end.
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };
vi.mock("./useToast", () => ({ useToast: () => toast }));
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));
vi.mock("../lib/openExternal", () => ({ openExternal: vi.fn() }));

const { useSendToInat, MAYBE_ON_INAT_PATH } = await import("./useSendToInat");

const done = (result: object) => ({
  running: false,
  error: null,
  result: {
    sent: 0,
    linked: 0,
    incomplete: 0,
    skipped: 0,
    failed: 0,
    maybeOnInat: [],
    editUrl: null,
    error: null,
    ...result,
  },
});
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  get.mockReset();
  post.mockReset().mockResolvedValue({ ok: true });
  navigate.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

async function run(send: () => Promise<boolean>) {
  let out = false;
  await act(async () => {
    const p = send();
    await vi.advanceTimersByTimeAsync(1500);
    out = await p;
  });
  return out;
}

describe("useSendToInat", () => {
  it("offers Check Maybe on iNaturalist and Send anyway for held sightings, and only Send anyway skips the check", async () => {
    get.mockResolvedValue(done({ maybeOnInat: [["a", "b"]] }));
    const { result } = renderHook(() => useSendToInat(), { wrapper });
    await run(() => result.current(["a", "b"]));
    expect(post).toHaveBeenCalledWith("/inaturalist/observations/batch", { captureIds: ["a", "b"] });
    const [message, opts] = toast.show.mock.calls.at(-1)!;
    expect(message).toBe("This looks like it may already be on iNaturalist.");
    expect(toast.error).not.toHaveBeenCalled();
    const [check, anyway] = opts.actions;
    expect([check.label, anyway.label]).toEqual(["Check Maybe on iNaturalist", "Send anyway"]);
    check.onClick();
    expect(navigate).toHaveBeenCalledWith(MAYBE_ON_INAT_PATH);
    get.mockResolvedValue(done({ sent: 1 }));
    await act(async () => {
      anyway.onClick();
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(post).toHaveBeenLastCalledWith("/inaturalist/observations/batch", {
      groups: [["a", "b"]],
      ignoreExistingGuard: true,
    });
  });

  it("hands held sightings to the page when it shows them in place", async () => {
    get.mockResolvedValue(done({ maybeOnInat: [["a"]] }));
    const onMaybeOnInat = vi.fn();
    const { result } = renderHook(() => useSendToInat(), { wrapper });
    await run(() => result.current({ groups: [["a"]] }, { onMaybeOnInat }));
    expect(onMaybeOnInat).toHaveBeenCalledWith([["a"]]);
    expect(toast.show).not.toHaveBeenCalledWith("This looks like it may already be on iNaturalist.", expect.anything());
  });
});

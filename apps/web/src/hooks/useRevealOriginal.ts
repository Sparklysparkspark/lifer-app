import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { tauriInvoke, type TauriInvoke } from "../lib/tauri";
import { useDeploymentMode } from "./useDeploymentMode";
import { useToast } from "./useToast";
import { revealPlace } from "../lib/platform";
import { fileNameOf, photoFilePaths } from "../lib/photoFilePaths";

/** A server folder that holds originals, with one file known to be in it. */
export interface ServerRoot {
  root: string;
  relativePath: string;
  size: number;
  /** Also mounted on this Mac. */
  here?: boolean;
}

export interface RevealAction {
  kind: "reveal" | "copy";
  label: string;
  run: () => void;
}

/** The most specific root holding `ref`, and the path inside it. */
export function locateInRoots(ref: string, roots: ServerRoot[]): { root: ServerRoot; relativePath: string } | null {
  let best: ServerRoot | null = null;
  for (const root of roots) {
    const prefix = root.root.endsWith("/") ? root.root : `${root.root}/`;
    if (ref.startsWith(prefix) && (!best || root.root.length > best.root.length)) best = root;
  }
  if (!best) return null;
  return { root: best, relativePath: ref.slice(best.root.length).replace(/^\/+/, "") };
}

// Asked once and kept until something suggests the mounts changed: the server's folders, and
// which are also mounted on this Mac. The Mac checks each folder against the server's own sample
// file, so only the folder is sent.
let mountedRoots: Promise<ServerRoot[]> | null = null;

export function resetMountedRoots(): void {
  mountedRoots = null;
}

function loadMountedRoots(invoke: TauriInvoke): Promise<ServerRoot[]> {
  mountedRoots ??= api
    .get("/originals/reveal-samples")
    .then(async ({ roots }) => {
      const here = await Promise.all(
        roots.map((r) => invoke("server_root_on_this_mac", { serverRoot: r.root }).then(Boolean, () => false)),
      );
      return roots.map((r, i) => ({ ...r, here: here[i] }));
    })
    .catch(() => []);
  return mountedRoots;
}

/** How a photo's original is shown on this computer: Show in Finder when the file is here (the
 *  desktop app's own library, or a server's share mounted on this Mac), otherwise Copy path. */
export function useRevealOriginal(): (ref: string | null | undefined) => RevealAction | null {
  const { t } = useTranslation();
  const toast = useToast();
  const mode = useDeploymentMode();
  const invoke = tauriInvoke();
  const remote = invoke !== null && mode === "server";
  const [roots, setRoots] = useState<ServerRoot[]>([]);

  // Looks again for the shares, e.g. after one was mounted or unmounted while Lifer was in the
  // background, or a reveal missed. Resolves with what it found.
  const redetect = useCallback(async () => {
    const call = tauriInvoke();
    if (!remote || !call) return [];
    resetMountedRoots();
    const found = await loadMountedRoots(call);
    setRoots(found);
    return found;
  }, [remote]);

  useEffect(() => {
    const call = tauriInvoke();
    if (!remote || !call) return;
    let live = true;
    void loadMountedRoots(call).then((r) => live && setRoots(r));
    const onFocus = () => void redetect();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [remote, redetect]);

  return useCallback(
    (ref) => {
      if (!ref || mode === null) return null;
      const reveal = (act: () => Promise<unknown>): RevealAction => ({
        kind: "reveal",
        label: t("photoMenu.revealInFinder", { place: revealPlace() }),
        run: () =>
          void act().catch((err: unknown) =>
            toast.error(
              t(
                err instanceof ApiError && err.status === 409
                  ? "species.edits.revealDisconnected"
                  : "species.edits.revealFailed",
              ),
            ),
          ),
      });
      if (invoke && mode === "desktop") return reveal(() => api.post("/originals/reveal", { path: ref }));
      // Judged by the most specific folder: a nested one may be a separate mount.
      const here = invoke ? locateInRoots(ref, roots) : null;
      if (invoke && here?.root.here) {
        const args = { serverRoot: here.root.root, relativePath: here.relativePath };
        // A miss may mean the share moved or was unmounted: look again, and retry once if it's
        // still mounted somewhere.
        return reveal(() =>
          invoke("reveal_server_file", args).catch(async (err: unknown) => {
            const found = await redetect();
            if (!found.some((r) => r.root === args.serverRoot && r.here)) throw err;
            return invoke("reveal_server_file", args);
          }),
        );
      }
      return {
        kind: "copy",
        label: t("photoMenu.copyPath"),
        run: () =>
          // navigator.clipboard is missing on plain-http origins, e.g. a server reached over the LAN.
          void (navigator.clipboard?.writeText(ref) ?? Promise.reject()).then(
            () => toast.success(t("species.edits.pathCopied")),
            () => toast.error(t("species.edits.copyPathFailed")),
          ),
      };
    },
    [invoke, mode, roots, t, toast, redetect],
  );
}

/** One action per stored file (an edit and its RAW each), named by file when there are several. */
export function useRevealFiles(refs: ReadonlyArray<string | null | undefined>): RevealAction[] {
  const { t } = useTranslation();
  const revealFor = useRevealOriginal();
  const files = photoFilePaths(...refs);
  return files.flatMap((ref) => {
    const action = revealFor(ref);
    if (!action) return [];
    if (files.length === 1) return [action];
    return [{ ...action, label: t("photoMenu.fileAction", { action: action.label, file: fileNameOf(ref) }) }];
  });
}

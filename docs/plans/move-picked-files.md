# Moving picked files into the library

Status: built (2026-11-25).

## The bug

With **Move photos into my library** on, a single photo picked with **Choose files** (or dragged in) stayed where it was, and the Import page said nothing about why. A picked or dropped file reaches the page as a browser `File`, which has no path on this computer. The page only sends `moveSourcePath` for files it read through the local API from a remembered folder (**Choose a folder** or a recent folder), so the server never tried to move the file. The summary then read "Moved 0 photos into your library." with no reason.

Even with a path, the server would have refused it: `sourceTrash.ts` only moves files inside `import_source_folders`, which only a folder scan writes (`not_in_source_folder`).

## What changed

- On the desktop's local library, **Choose files** opens the shell's own file dialog (`pick_import_files` in `apps/desktop/src-tauri/src/commands.rs`). The shell reports the picked paths to the local API (`POST /api/uploads/picked-files`), signed with `LIFER_SHELL_TOKEN`. The API keeps them in memory (`apps/api/src/uploads/pickedFiles.ts`) for the rest of the launch, at most a day.
- A picked path counts like a file in a remembered folder: the page may read it (`GET /uploads/source-folders/file`) and, with Move on, send it as `moveSourcePath`. Every other rule in `trashBlock` and `planGroup` still applies.
- Files that can't be moved say so: a dragged-in file gets "Lifer can only move files picked with Choose files or Choose a folder, not dragged in." When only one original stays, the summary gives its reason instead of a count, and "Moved 0 photos" is gone.
- `partner_stays` stays a refusal, with plainer words. A prompt to move the JPG alone was considered and left out: `6F9A9774.xmp` may belong to the RAW, and picking both files is a clear way to move both.

## Threat model

What the move can never do, whoever asks:

- Run on a server. `moveSourceAway` returns early unless `SINGLE_USER_MODE`, and `/uploads/picked-files` answers 404 there. Server installs keep `LIFER_LIBRARY_ROOTS` and `assertAllowedPath` exactly as before; nothing here reads them.
- Touch a file inside the library (`in_library`: `DATA_DIR`, `ORIGINALS_DIR`, trip folders, any file an original points at).
- Move a file before its capture is saved and a library copy with the same bytes (or the same image data) is read back (`libraryCopyOk`), or a file whose bytes changed since upload (`expect` hash).

Who could claim a path:

- **A page script in the app window.** It holds the launch token (it trades it for the session cookie), so the launch token can't vouch for a pick. `LIFER_SHELL_TOKEN` is a second per-launch secret that only the shell and the API process see: it's passed in the API's environment and never returned by a Tauri command. A page can call `pick_import_files`, but that only opens the dialog; the user still chooses.
- **A connected server's pages.** `pick_import_files` is in the local-only permission set and also checks the window is on the local API's origin.
- **Another program on this computer.** It can't read the API's environment or the shell's memory without already having the user's account, which is outside what Lifer can defend.

Already true before this change, and unchanged: the page can register any folder with `/uploads/source-folders/scan`, so on the desktop the remembered-folder rule is a check on intent, not a security boundary. Picked files don't widen that.

## Not done

Dragged-in files still can't be moved. Getting their paths needs Tauri's native drag-drop handler, which empties `dataTransfer.files` for every drop target in the app (`lib.rs` disables it for that reason). Doing it would mean routing every drop through the shell. Left for later if dragging turns out to be the common way in.

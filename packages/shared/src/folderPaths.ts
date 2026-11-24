// Folder arithmetic on stored paths, for the server and the web app alike (no node:path here).

const SEP = /[\\/]+/;

/** The deepest folder holding every one of `files`, or null when they share nothing narrower than
 *  a drive or a top-level folder (too broad to be worth suggesting). */
export function commonFolder(files: string[]): string | null {
  if (files.length === 0) return null;
  const sep = files[0].includes("\\") && !files[0].includes("/") ? "\\" : "/";
  let common = files[0].split(SEP).slice(0, -1);
  for (const file of files.slice(1)) {
    const parts = file.split(SEP).slice(0, -1);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  // At least two named levels: /Users/ana or C:\Photos, never / or /Volumes.
  if (common.filter(Boolean).length < 2) return null;
  return common.join(sep) || sep;
}

/** The folder above `folder`, or the folder itself at the top of a drive. */
export function parentFolder(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut <= 0) return cut === 0 ? trimmed.slice(0, 1) : folder;
  return trimmed.slice(0, cut);
}

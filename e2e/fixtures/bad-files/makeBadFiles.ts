// Files an import must survive. Made on the fly like support/photo.ts, so the repo holds no binary
// fixture. Each name says what is wrong with it.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeCameraJpeg } from "../../support/photo.js";

export interface BadFile {
  file: string;
  /** A truncated JPEG may still decode; importing it is fine as long as nothing breaks. */
  mayImport: boolean;
}

/** Writes the bad files into `folder` next to whatever is there. `tint` makes the source photo
 *  unique (see makeCameraJpeg). Returns the files written. */
export async function writeBadFiles(folder: string, tint: number): Promise<BadFile[]> {
  const source = path.join(folder, ".source.jpg");
  await makeCameraJpeg(source, { tint });
  const good = readFileSync(source);
  const files: BadFile[] = [];
  const write = (file: string, bytes: Buffer | string, mayImport = false) => {
    writeFileSync(path.join(folder, file), bytes);
    files.push({ file, mayImport });
  };

  write("zero-bytes.jpg", Buffer.alloc(0));
  write("not-a-photo.jpg", "This is a text file with a photo's name.\n");
  // A JPEG start marker, then noise: looks like a JPEG, decodes as nothing.
  const corrupt = Buffer.from(good);
  for (let i = 64; i < corrupt.length; i++) corrupt[i] = (i * 7919) & 0xff;
  write("corrupt.jpg", corrupt);
  write("truncated.jpg", good.subarray(0, Math.floor(good.length * 0.4)), true);
  // Windows has no permission bit that stops the owner reading a file.
  if (process.platform !== "win32") {
    write("unreadable.jpg", good);
    chmodSync(path.join(folder, "unreadable.jpg"), 0o000);
  }
  return files;
}

// Where the vagrant-flag scripts read and write their JSONL hand-off logs: data/reports/vagrant
// at the repo root (gitignored), or VAGRANT_REPORTS_DIR when set.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPORTS_DIR =
  process.env.VAGRANT_REPORTS_DIR ?? fileURLToPath(new URL("../../../../data/reports/vagrant/", import.meta.url));

export function vagrantReportPath(fileName: string): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  return path.join(REPORTS_DIR, fileName);
}

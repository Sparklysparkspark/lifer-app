// The packaged app copies packages/data-pipeline and packages/shared to their own
// Resources/packages/* folders (see package.json's extraResources) rather than including them
// in the node_modules copy, since they're real workspace source folders, not registry
// packages. In a normal dev checkout, npm's workspace hoisting makes "data-pipeline" and
// "@lifer/shared" resolvable via node_modules symlinks pointing at those same folders — but
// nothing recreates that symlink inside the packaged app, so apps/api/src/regions/routes.ts's
// `import ... from "data-pipeline/..."` (a live, request-path import, not a maintainer script)
// would 404 at runtime with MODULE_NOT_FOUND. This hook recreates exactly those two symlinks
// after packaging, so module resolution works the same way it does in development.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");

  const nodeModulesDir = path.join(resourcesDir, "node_modules");
  fs.mkdirSync(path.join(nodeModulesDir, "@lifer"), { recursive: true });

  fs.symlinkSync(path.join(resourcesDir, "packages", "data-pipeline"), path.join(nodeModulesDir, "data-pipeline"), "dir");
  fs.symlinkSync(path.join(resourcesDir, "packages", "shared"), path.join(nodeModulesDir, "@lifer", "shared"), "dir");
};

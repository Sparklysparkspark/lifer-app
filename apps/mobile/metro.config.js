/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this as CommonJS */
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// packages/shared imports its own TypeScript as "./x.js"; retry those as .ts.
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (context.originModulePath.includes("packages/shared") && /^\.\.?\/.*\.js$/.test(name)) {
    try {
      return resolve(context, name.replace(/\.js$/, ".ts"), platform);
    } catch {
      // fall through to the normal lookup
    }
  }
  return resolve(context, name, platform);
};

module.exports = config;

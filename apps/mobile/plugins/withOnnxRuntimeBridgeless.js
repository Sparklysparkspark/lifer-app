// onnxruntime-react-native 1.24.3 finds the JS runtime through RCTCxxBridge, which React Native 0.88's
// bridgeless mode no longer has: the bridge is an RCTBridgeProxy that answers `runtime` itself.
// This rewrites those lines in the package's iOS module before the build. It does nothing once the
// package fixes this, and it can be dropped then.
/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");

const OLD = `    RCTCxxBridge* cxxBridge = (RCTCxxBridge*)_bridge;
    if (cxxBridge == nil) {
      return @false;
    }

    auto jsiRuntime = (facebook::jsi::Runtime*)cxxBridge.runtime;`;
const NEW = `    if (_bridge == nil) {
      return @false;
    }

    auto jsiRuntime = ((facebook::jsi::Runtime * (*)(id, SEL))objc_msgSend)(_bridge, @selector(runtime));`;

module.exports = (config) =>
  withDangerousMod(config, [
    "ios",
    (c) => {
      const file = require.resolve("onnxruntime-react-native/ios/OnnxruntimeModule.mm", {
        paths: [c.modRequest.projectRoot],
      });
      let text = fs.readFileSync(file, "utf8");
      if (text.includes(OLD)) {
        text = text.replace(OLD, NEW);
        if (!text.includes("<objc/message.h>"))
          text = text.replace(
            "#import <Foundation/Foundation.h>",
            "#import <Foundation/Foundation.h>\n#import <objc/message.h>",
          );
        fs.writeFileSync(file, text);
      }
      return c;
    },
  ]);

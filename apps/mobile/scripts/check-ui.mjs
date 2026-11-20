#!/usr/bin/env node
// House-component rule for the phone: raw colours only in src/theme, raw touchables only in src/ui,
// and nothing scrolls sideways except photos (src/photos and the viewer).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !n.includes(".test.") ? [p] : [];
  });

const errors = [];
for (const f of files(src)) {
  const rel = relative(src, f);
  const text = readFileSync(f, "utf8");
  if (!rel.startsWith("theme/") && /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(text))
    errors.push(`${rel}: raw colour, use the theme`);
  if (!rel.startsWith("photos/") && rel !== "screens/ViewerScreen.tsx" && /<(ScrollView|FlatList|FlashList)\b[^>]*\bhorizontal\b/.test(text))
    errors.push(`${rel}: horizontal list outside photos/ and the viewer`);
  if (
    !rel.startsWith("ui/") &&
    /<(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/.test(text)
  ) {
    errors.push(`${rel}: raw touchable, use a component from ui/`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("check:ui ok");

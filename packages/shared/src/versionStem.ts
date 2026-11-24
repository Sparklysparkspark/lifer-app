// What editors and exporters append to a name: "-2", "-Edit", "-Enhanced-NR", "-Pano", "-HDR",
// black and white ("-BW", "_bw", "1234bw"), or a print size such as "_10x27" or " 16x20".
// Underscore digits are left alone: "DSC_0001" is a camera name.
const SUFFIX =
  /(?:-(?:\d{1,3}|edit(?:ed)?|enhanced(?:-nr|-sr)?|nr|pano(?:rama)?|hdr|copy)|[-_ ](?:bw|b&w|mono)|(?<=\d)bw|[-_ ]\d{1,3}x\d{1,3})$/i;

/** The name a file's versions share: no folder, extension or editor suffixes, lower case. */
export function baseStem(fileName: string): string {
  const name = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  let stem = (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
  for (let next = stem.replace(SUFFIX, ""); next !== stem && next.length > 0; next = stem.replace(SUFFIX, "")) {
    stem = next;
  }
  return stem;
}

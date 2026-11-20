// Reads the Lua table literal Lightroom stores a smart collection's rules in, e.g.
// `s = { combine = "intersect", rules = { { criteria = "rating", value = 4 } } }`.
// Only data is understood (tables, strings, numbers, booleans, nil); anything else throws.
export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

export function parseLuaTable(source: string): LuaValue {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`Unreadable Lightroom rules: ${what} at ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source.startsWith("--", i)) while (i < source.length && source[i] !== "\n") i++;
      else return;
    }
  };

  function string(): string {
    const quote = source[i++];
    let out = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        i++;
        const c = source[i++];
        out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
      } else out += source[i++];
    }
    if (source[i++] !== quote) fail("unterminated string");
    return out;
  }

  function value(): LuaValue {
    skip();
    const c = source[i];
    if (c === "{") return table();
    if (c === '"' || c === "'") return string();
    const num = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(source.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_]\w*/.exec(source.slice(i))?.[0];
    if (word === "true" || word === "false") return ((i += word.length), word === "true");
    if (word === "nil") return ((i += 3), null);
    return fail("unexpected value");
  }

  function table(): LuaValue {
    i++; // {
    const list: LuaValue[] = [];
    const map: { [key: string]: LuaValue } = {};
    let keyed = false;
    for (;;) {
      skip();
      if (source[i] === "}") break;
      const key = /^(?:([A-Za-z_]\w*)|\[\s*(?:"([^"]*)"|(\d+))\s*\])\s*=(?!=)/.exec(source.slice(i));
      if (key) {
        i += key[0].length;
        map[key[1] ?? key[2] ?? key[3]] = value();
        keyed = true;
      } else list.push(value());
      skip();
      if (source[i] === "," || source[i] === ";") i++;
      else if (source[i] !== "}") fail("expected , or }");
    }
    i++; // }
    return keyed ? { ...map, ...Object.fromEntries(list.map((v, n) => [String(n + 1), v])) } : list;
  }

  skip();
  // The stored text is an assignment: `s = { ... }`.
  const assignment = /^[A-Za-z_]\w*\s*=(?!=)/.exec(source.slice(i));
  if (assignment) i += assignment[0].length;
  const result = value();
  skip();
  if (i < source.length) fail("trailing text");
  return result;
}

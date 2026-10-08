// The Markdown a release's changelog section uses (CHANGELOG.md), parsed into blocks for the
// update notes: headings, bullet lists (wrapped lines indented under their bullet) and paragraphs,
// with **bold**, `code` and [links](https://...) inline. Anything else stays as plain text.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "heading"; level: number; content: Inline[] }
  | { type: "list"; items: Inline[][] }
  | { type: "paragraph"; content: Inline[] };

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] != null) out.push({ type: "bold", text: m[1] });
    else if (m[2] != null) out.push({ type: "code", text: m[2] });
    else out.push({ type: "link", text: m[3], href: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function parseReleaseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  let items: string[] | null = null;
  let paragraph: string[] | null = null;
  const flush = () => {
    if (items) blocks.push({ type: "list", items: items.map(parseInline) });
    if (paragraph) blocks.push({ type: "paragraph", content: parseInline(paragraph.join(" ")) });
    items = null;
    paragraph = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (line.trim() === "") {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, content: parseInline(heading[2]) });
    } else if (bullet) {
      if (paragraph) flush();
      items ??= [];
      items.push(bullet[1]);
    } else if (items && /^\s/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      if (items) flush();
      paragraph ??= [];
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

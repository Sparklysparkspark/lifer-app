import { parseReleaseNotes, type Inline } from "../lib/releaseNotes";
import { openExternal } from "../lib/openExternal";

function InlineText({ parts }: { parts: Inline[] }) {
  return parts.map((p, i) => {
    if (p.type === "bold")
      return (
        <strong key={i} className="font-semibold text-ink">
          {p.text}
        </strong>
      );
    if (p.type === "code")
      return (
        <code key={i} className="rounded bg-surface px-1 text-xs">
          {p.text}
        </code>
      );
    if (p.type === "link")
      return (
        <a
          key={i}
          href={p.href}
          onClick={(e) => {
            e.preventDefault();
            openExternal(p.href);
          }}
          className="text-accent underline"
        >
          {p.text}
        </a>
      );
    return <span key={i}>{p.text}</span>;
  });
}

/** A release's changelog section, rendered from its Markdown. */
export default function ReleaseNotes({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={className}>
      {parseReleaseNotes(markdown).map((block, i) => {
        if (block.type === "heading")
          return (
            <p key={i} className="mt-3 font-medium text-ink first:mt-0">
              <InlineText parts={block.content} />
            </p>
          );
        if (block.type === "list")
          return (
            <ul key={i} className="mt-1 list-disc space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>
                  <InlineText parts={item} />
                </li>
              ))}
            </ul>
          );
        return (
          <p key={i} className="mt-2">
            <InlineText parts={block.content} />
          </p>
        );
      })}
    </div>
  );
}

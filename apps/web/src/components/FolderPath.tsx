// A folder's location as Finder shows one: the folder's own name first, the folders above it after
// in muted text, in the interface font rather than a code font. The full path is on hover.
export default function FolderPath({ path, className = "" }: { path: string; className?: string }) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  const parent = cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? trimmed.slice(0, 1) : "";
  return (
    <span className={`flex min-w-0 items-baseline gap-1.5 ${className}`} title={path}>
      {/* The parent gives way first; the name truncates only once it alone overflows. */}
      <span className="max-w-full shrink-0 truncate font-medium text-ink">{name || trimmed}</span>
      {parent && <span className="min-w-0 truncate text-muted">{parent}</span>}
    </span>
  );
}

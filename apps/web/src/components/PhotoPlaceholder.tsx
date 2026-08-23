// Shown wherever a species has no photo to display — no capture yet, no reference photo
// found, or (via ProgressiveImg's onError) a reference photo whose file has since moved or
// been deleted. One shared look for all three cases, so a broken file reads the same as
// "nothing here yet" instead of looking like an error.
export default function PhotoPlaceholder({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-surface-muted text-accent ${className ?? ""}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-1/3 w-1/3 max-h-10 max-w-10">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="12" cy="12" r="3.5" />
        <path d="M8 5l1.5-2h5L16 5" />
      </svg>
    </div>
  );
}

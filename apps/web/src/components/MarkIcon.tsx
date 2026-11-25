// The seen and target marks: house line icons (an eye, a target), the same on cards and in the tree.
function MarkIcon({ d, className }: { d: string; className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const SEEN = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const TARGET = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 11.5v1";

export function SeenIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <MarkIcon className={className} d={SEEN} />;
}

export function TargetIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <MarkIcon className={className} d={TARGET} />;
}

// The picture-frame icon on the photo grids' empty states.
export default function PhotosIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="m21 16-4.5-4.5L9 19" />
    </svg>
  );
}

import { useTranslation } from "react-i18next";

// Marks a smart album (one whose rules choose its photos) wherever albums are listed or shown:
// a sparkle beside the name, named for screen readers and on hover.
export default function SmartAlbumLabel({
  className = "",
  iconClassName = "h-4 w-4",
}: {
  className?: string;
  /** Sized to the text it marks. */
  iconClassName?: string;
}) {
  const { t } = useTranslation();
  const label = t("albums.smart.label");
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 text-muted ${className}`}>
      <svg
        viewBox="0 0 24 24"
        className={iconClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z" />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
      </svg>
    </span>
  );
}

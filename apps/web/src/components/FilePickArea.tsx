import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "./Button";

/** The one way to add files: a drop area with Choose files / Choose a folder. `onFiles` gets
 *  whether the files came from a folder pick, for callers that treat the two differently.
 *  `compact` is a single row for a secondary drop target, so it doesn't read as a second copy of
 *  the page's main one. */
export default function FilePickArea({
  prompt,
  hint,
  accept,
  onFiles,
  compact = false,
}: {
  prompt: string;
  hint?: string;
  accept?: string;
  onFiles: (files: FileList, fromFolder: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  // Highlighted while files are dragged over, so it reads as a place to drop them.
  const [dragging, setDragging] = useState(false);

  function take(input: HTMLInputElement, fromFolder: boolean) {
    if (input.files?.length) onFiles(input.files, fromFolder);
    // Cleared so picking the same files again still fires a change.
    input.value = "";
  }

  return (
    <>
      {/* Outside the drop area: a click on either input would bubble to the area's own click and
          open the files picker on top of the folder picker. */}
      <input
        ref={filesRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => take(e.target, false)}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        // @ts-expect-error non-standard but supported in every browser Lifer targets
        webkitdirectory=""
        className="hidden"
        onChange={(e) => take(e.target, true)}
      />
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        // Moving onto a child fires dragleave on this element too; only leaving it entirely counts.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files, false);
        }}
        onClick={compact ? undefined : () => filesRef.current?.click()}
        className={
          compact
            ? `flex flex-wrap items-center justify-between gap-x-section gap-y-3 rounded-panel border px-4 py-3 transition-colors ${
                dragging ? "border-accent bg-accent/10" : "border-line bg-surface"
              }`
            : `cursor-pointer rounded-panel border-2 border-dashed p-8 text-center transition-colors ${
                dragging ? "border-accent bg-accent/10" : "border-line"
              }`
        }
      >
        {compact ? (
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">{prompt}</p>
            {hint && <p className="mt-0.5 max-w-prose text-xs text-muted">{hint}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">{prompt}</p>
        )}
        <div className={compact ? "flex shrink-0 gap-2" : "mt-3 flex justify-center gap-2"}>
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              filesRef.current?.click();
            }}
          >
            {t("upload.pick.chooseFiles")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              folderRef.current?.click();
            }}
          >
            {t("upload.pick.chooseFolder")}
          </Button>
        </div>
        {!compact && hint && <p className="mx-auto mt-3 max-w-prose text-xs text-muted">{hint}</p>}
      </div>
    </>
  );
}

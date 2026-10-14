import { useState } from "react";
import AddToAlbumModal from "./AddToAlbumModal";
import Button from "./Button";

// "Add to album" for multi-select toolbars: picks or creates the album in a dialog.
export default function AddToAlbumButton({ captureIds, onAdded }: { captureIds: string[]; onAdded?: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={captureIds.length === 0}
        className="shrink-0"
      >
        Add to album
      </Button>
      {open && <AddToAlbumModal captureIds={captureIds} onClose={() => setOpen(false)} onAdded={onAdded} />}
    </>
  );
}

// Every photo behind a chart mark (a scatter dot, an EXIF bar) as a scrollable grid. A photo opens
// the viewer with arrows through the whole set in grid order; Esc in the viewer returns here.
import { useMemo, useState, type ReactNode } from "react";
import Modal from "../../components/Modal";
import PhotoGrid, { type PhotoGridSelection, type PhotoGridTileData } from "../../components/PhotoGrid";
import Lightbox from "../../components/Lightbox";
import { slidesFor, type PhotoSetPhoto } from "./photoSet";

const NO_SELECT: PhotoGridSelection = { selectMode: false, selectedIds: new Set(), toggle: () => {} };
const idFor = (p: PhotoSetPhoto) => p.photoId;
const tileFor = (p: PhotoSetPhoto): PhotoGridTileData => ({ photoId: p.photoId, alt: p.caption ?? "" });

export default function PhotoSetModal({
  title,
  photos,
  onClose,
  footer,
  description,
}: {
  title: string;
  photos: PhotoSetPhoto[];
  onClose: () => void;
  footer?: ReactNode;
  description?: ReactNode;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const slides = useMemo(() => slidesFor(photos), [photos]);
  return (
    <>
      <Modal open size="lg" title={title} description={description} onClose={onClose} footer={footer}>
        <PhotoGrid
          items={photos}
          idFor={idFor}
          tileFor={tileFor}
          columnWidth={150}
          select={NO_SELECT}
          onOpen={setIndex}
        />
      </Modal>
      {index !== null && slides[index] && (
        <Lightbox slides={slides} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)} />
      )}
    </>
  );
}

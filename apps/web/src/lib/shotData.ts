import i18n from "../i18n";

// Camera, lens, focal length, aperture, shutter and ISO as one compact line, skipping missing fields.
export function shotDataLine(c: {
  camera_model?: string | null;
  lens?: string | null;
  focal_length_mm?: string | number | null;
  aperture?: string | number | null;
  shutter?: string | null;
  iso?: number | null;
}): string | null {
  const parts = [
    c.camera_model,
    c.lens,
    c.focal_length_mm
      ? i18n.t("species.shotData.focalLength", { mm: String(Math.round(Number(c.focal_length_mm))) })
      : null,
    c.aperture ? i18n.t("species.shotData.aperture", { aperture: String(c.aperture) }) : null,
    c.shutter,
    c.iso ? i18n.t("species.shotData.iso", { iso: String(c.iso) }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

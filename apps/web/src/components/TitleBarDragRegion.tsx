// The frameless mac window (title_bar_style: Overlay — see lib.rs) has no native title bar to
// drag by, so this strip stands in for one. Ported over from the Electron build, this used to
// rely on `-webkit-app-region: drag` (index.css) — a Chromium-only CSS property with no effect
// at all in Tauri's WKWebView. Tauri's real equivalent is the `data-tauri-drag-region` HTML
// attribute, read by Tauri's own injected pointerdown listener; a CSS pseudo-element (the old
// approach) can't carry it since it isn't a real DOM node, so this needs an actual element.
// Matches index.css's [data-mac-app] header.page-header padding-top (56px) exactly, so every
// page's own header sits right below this strip rather than overlapping or leaving a gap.
export default function TitleBarDragRegion() {
  if (!document.documentElement.hasAttribute("data-mac-app")) return null;

  return (
    <div
      data-tauri-drag-region
      className="fixed left-0 right-0 top-0 bg-surface"
      style={{ height: 56, zIndex: 2147483646 }}
    />
  );
}

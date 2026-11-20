// The title-bar row of a full-window layer (Lightbox, compare views) on the mac desktop, where the
// traffic lights float over the top-left: a window drag region as tall as the app's toolbar, with
// the title centred as macOS does. index.css shows it only there, so a browser or Windows and Linux
// (whose window controls sit in their own title bar) get no extra row; the layer's toolbar then
// shows the title itself, marked `window-title-elsewhere`.
export default function WindowTitleBar({
  title,
  dark = false,
  className = "",
}: {
  title?: string;
  /** Over the Lightbox's dark surround: no fill of its own. */
  dark?: boolean;
  className?: string;
}) {
  return (
    <div
      data-tauri-drag-region=""
      data-window-title-bar
      // design-token: the Lightbox's caption text on its dark surround.
      className={`window-title-bar ${dark ? "text-white/70" : "bg-surface text-ink"} ${className}`}
    >
      {title && (
        <p data-tauri-drag-region="" className="truncate text-callout font-semibold">
          {title}
        </p>
      )}
    </div>
  );
}

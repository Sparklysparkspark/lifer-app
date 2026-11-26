import { useRef } from "react";
import type { PluginEndpoint, PluginSummary } from "@lifer/shared";
import { usePluginHost } from "../lib/pluginHost";

// The sandboxed frame that shows a companion app's own page, talking the host protocol
// (lib/pluginHost.ts) with `endpoint.origin` as the only origin it trusts. allow-same-origin is
// needed because a fully sandboxed frame gets the origin "null", which the app's own server
// refuses; it still never shares Lifer's origin (another port).
// The page token never goes in the URL; the host sends it as `credential` once the page is ready.
export default function PluginFrame({
  plugin,
  endpoint,
  title,
  visible,
  onLoad,
}: {
  plugin: PluginSummary;
  endpoint: PluginEndpoint;
  title: string;
  /** Whether its page is the one on screen; the host adds the window's own visibility. */
  visible: boolean;
  onLoad?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  usePluginHost({
    pluginId: plugin.id,
    name: plugin.page.label || plugin.name,
    menuTitle: plugin.name,
    origin: endpoint.origin,
    token: endpoint.pageToken,
    capabilities: plugin.capabilities,
    frameRef,
    visible,
  });
  return (
    <iframe
      ref={frameRef}
      src={endpoint.pageUrl}
      title={title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className="absolute inset-0 h-full w-full border-0"
    />
  );
}

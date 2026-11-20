import * as Sharing from "expo-sharing";
import type { App } from "./AppContext";

/** Always the display copy, which carries no location. The full-size render is never what gets shared. */
export async function shareDisplayCopy(app: Pick<App, "media">, photoId: string): Promise<void> {
  const uri = await app.media.display(photoId);
  if (uri && (await Sharing.isAvailableAsync()))
    await Sharing.shareAsync(uri, { mimeType: "image/webp", UTI: "public.image" });
}

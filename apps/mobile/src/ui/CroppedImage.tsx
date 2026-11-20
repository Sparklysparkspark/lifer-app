import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { cropFrame, type Crop } from "../photos/crop";

/**
 * Fills its square (or any) parent with a photo, framed on the user's crop when there is one and
 * centred otherwise. The crop needs the photo's shape, learned when it loads.
 */
export function CroppedImage({ uri, crop }: { uri: string; crop?: Crop | null }) {
  const [seen, setSeen] = useState<{ uri: string; aspect: number } | null>(null);
  const aspect = seen?.uri === uri ? seen.aspect : null;
  const frame = cropFrame(crop, aspect);
  if (!crop) {
    return (
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        recyclingKey={uri}
        transition={0}
        testID="cropped-image"
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
      <Image
        source={{ uri }}
        style={frame ? { position: "absolute", ...frame } : [StyleSheet.absoluteFill, { opacity: aspect ? 1 : 0 }]}
        contentFit={frame ? "fill" : "cover"}
        recyclingKey={uri}
        transition={0}
        testID="cropped-image"
        onLoad={(e) => e.source.width && e.source.height && setSeen({ uri, aspect: e.source.width / e.source.height })}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

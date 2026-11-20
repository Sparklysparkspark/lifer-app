import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { PanResponder, Text, View } from "react-native";
import { radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

export interface ScrubberHandle {
  /** Moves the handle to follow the list (0 top, 1 bottom). */
  follow(fraction: number): void;
}

interface Props {
  label: string;
  /** The text shown beside the handle while dragging. */
  bubble: (fraction: number) => string;
  onScrub: (fraction: number) => void;
  /** Steps the list a month at a time for assistive technology. */
  onStep: (direction: 1 | -1) => void;
  /** Width of the touch strip; narrow, so the tiles beside it stay tappable. */
  width?: number;
}

/** The scrubber down the right edge: drag to jump through months. A drag has a button-free alternative: swipe up or down with VoiceOver. */
export const Scrubber = forwardRef<ScrubberHandle, Props>(function Scrubber(
  { label, bubble, onScrub, onStep, width = 28 },
  ref,
) {
  const { colors } = useTheme();
  const [fraction, setFraction] = useState(0);
  const [dragging, setDragging] = useState(false);
  const height = useRef(1);
  const dragFraction = useRef(0);
  useImperativeHandle(ref, () => ({ follow: (f) => !dragging && setFraction(f) }), [dragging]);

  const at = (y: number) => Math.max(0, Math.min(1, y / height.current));
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        setDragging(true);
        dragFraction.current = at(e.nativeEvent.locationY);
        setFraction(dragFraction.current);
        onScrub(dragFraction.current);
      },
      onPanResponderMove: (e) => {
        dragFraction.current = at(e.nativeEvent.locationY);
        setFraction(dragFraction.current);
        onScrub(dragFraction.current);
      },
      onPanResponderRelease: () => setDragging(false),
      onPanResponderTerminate: () => setDragging(false),
    }),
  ).current;

  return (
    <View
      {...pan.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => onStep(e.nativeEvent.actionName === "increment" ? 1 : -1)}
      onLayout={(e) => (height.current = Math.max(1, e.nativeEvent.layout.height))}
      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width }}
    >
      <View
        style={{
          position: "absolute",
          right: 4,
          top: `${fraction * 94}%`,
          width: 8,
          height: 40,
          borderRadius: 4,
          backgroundColor: dragging ? colors.accent : colors["control-line"],
        }}
      />
      {dragging ? (
        <View
          style={{
            position: "absolute",
            right: 20,
            top: `${fraction * 94}%`,
            paddingHorizontal: spacing.item,
            paddingVertical: 8,
            borderRadius: radius.control,
            backgroundColor: colors.accent,
          }}
        >
          <Text style={{ color: colors["accent-fg"], fontSize: type.subheadline.size, fontWeight: "700" }}>
            {bubble(fraction)}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

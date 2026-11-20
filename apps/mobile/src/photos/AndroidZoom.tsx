// Pinch and drag zoom for Android, where there is no platform zoom view. Loaded only there.
import { useRef, useState, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

export function ZoomView({ children, width, height, onTap, onZoom }: { children: ReactNode; width: number; height: number; onTap: () => void; onZoom?: (zoomed: boolean) => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const [zoomed, setZoomed] = useState(false);
  const base = useRef({ s: 1, x: 0, y: 0 });
  const reset = () => {
    base.current = { s: 1, x: 0, y: 0 };
    Animated.parallel([scale, x, y].map((v, i) => Animated.timing(v, { toValue: i ? 0 : 1, duration: 150, useNativeDriver: true }))).start();
    setZoomed(false);
    onZoom?.(false);
  };
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onUpdate((e) => scale.setValue(Math.max(1, Math.min(5, base.current.s * e.scale))))
    .onEnd((e) => {
      base.current.s = Math.max(1, Math.min(5, base.current.s * e.scale));
      if (base.current.s <= 1.02) reset();
      else {
        setZoomed(true);
        onZoom?.(true);
      }
    });
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(zoomed)
    .onUpdate((e) => {
      x.setValue(base.current.x + e.translationX);
      y.setValue(base.current.y + e.translationY);
    })
    .onEnd((e) => {
      base.current.x += e.translationX;
      base.current.y += e.translationY;
    });
  const double = Gesture.Tap().runOnJS(true).numberOfTaps(2).onEnd(() => (zoomed ? reset() : void 0));
  const single = Gesture.Tap().runOnJS(true).requireExternalGestureToFail(double).onEnd(onTap);
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(double, single))}>
      <View style={{ width, height, overflow: "hidden" }}>
        <Animated.View style={{ width, height, transform: [{ translateX: x }, { translateY: y }, { scale }] }}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, FlatList, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { useIsFocused } from "@react-navigation/native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../app/AppContext";
import { shareDisplayCopy } from "../app/share";
import { dateText, timeText } from "../format/dates";
import { useNav, type RootParams } from "../navigation/types";
import { CachedTile } from "../photos/CachedTile";
import { INFO_DISTANCE, MIN_SCALE, shouldDismiss } from "../photos/dismiss";
import { captureByPhoto } from "../store/library";
import { getSpecies } from "../store/marks";
import { BACKDROP, ON_BACKDROP, type } from "../theme/theme";
import { Button, RoundButton, Tap, showActions } from "../ui";

type FullState = "idle" | "loading" | "offline" | "unavailable" | "done";

function ViewerPage({
  id,
  width,
  height,
  fullUri,
  label,
  onTap,
  onZoom,
}: {
  id: string;
  width: number;
  height: number;
  fullUri: string | undefined;
  label: string;
  onTap: () => void;
  onZoom: (id: string, zoomed: boolean) => void;
}) {
  const { media } = useApp();
  const { t } = useTranslation();
  const [uri, setUri] = useState<string | null>(null);
  const [thumb, setThumb] = useState(() => media.thumb(id));
  const [failed, setFailed] = useState(false);
  // A purged or undrawable saved copy is dropped and fetched once on its own; after that the person decides.
  const [tries, setTries] = useState(0);
  useEffect(() => media.watch(id, setThumb), [media, id]);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    void media.display(id, tries > 0).then((u) => {
      if (!alive) return;
      setUri(u);
      setFailed(!u);
    });
    return () => {
      alive = false;
    };
  }, [media, id, tries]);
  // The thumbnail, blurred, holds the frame until the display copy arrives, so the frame never jumps (L9).
  const shown = fullUri ?? uri ?? thumb;
  const drawFailed = () => {
    if (fullUri) return;
    setUri(null);
    if (tries === 0) setTries(1);
    else setFailed(true);
  };
  const image = shown ? (
    <Image
      accessibilityLabel={label}
      source={{ uri: shown }}
      contentFit="contain"
      style={{ width, height }}
      transition={0}
      blurRadius={fullUri || uri ? 0 : 12}
      onError={drawFailed}
      accessibilityIgnoresInvertColors
    />
  ) : null;
  return (
    <View style={{ width, height, justifyContent: "center" }}>
      {Platform.OS === "ios" ? (
        // Pinch and double tap to zoom are the platform scroll view's on iPhone.
        <ScrollView
          maximumZoomScale={5}
          minimumZoomScale={1}
          bouncesZoom
          centerContent
          // Unzoomed it must not bounce, or it swallows the drag down that closes the viewer.
          alwaysBounceVertical={false}
          alwaysBounceHorizontal={false}
          scrollEventThrottle={16}
          onScroll={(e) => onZoom(id, (e.nativeEvent.zoomScale ?? 1) > 1.01)}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ width, height, justifyContent: "center" }}
        >
          <Tap label={label} role="imagebutton" onPress={onTap}>
            {image}
          </Tap>
        </ScrollView>
      ) : (
        // Android has no platform zoom view: pinch and drag come from gesture-handler.
        <AndroidZoom width={width} height={height} onTap={onTap} onZoom={(z) => onZoom(id, z)}>
          {image}
        </AndroidZoom>
      )}
      {failed && !fullUri ? (
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: 24, right: 24, bottom: 150, alignItems: "center", gap: 6 }}
        >
          <Text style={{ color: ON_BACKDROP, fontSize: type.footnote.size, textAlign: "center" }}>
            {t(shown ? "viewer.previewFailed" : "viewer.notSaved")}
          </Text>
          <Button label={t("viewer.retry")} variant="secondary" compact onPress={() => setTries((n) => n + 1)} />
        </View>
      ) : null}
    </View>
  );
}

function AndroidZoom({
  children,
  width,
  height,
  onTap,
  onZoom,
}: {
  children: React.ReactNode;
  width: number;
  height: number;
  onTap: () => void;
  onZoom: (zoomed: boolean) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only on Android, so iPhone never pulls it in
  const { ZoomView } = require("../photos/AndroidZoom") as typeof import("../photos/AndroidZoom");
  return (
    <ZoomView width={width} height={height} onTap={onTap} onZoom={onZoom}>
      {children}
    </ZoomView>
  );
}

const FILMSTRIP = 3;

/** Full screen, black in every appearance: swipe between photos, pinch to zoom, glass controls, a filmstrip, the toolbar. */
export function ViewerScreen({ route }: { route: { params: RootParams["Viewer"] } }) {
  const { ids, index: start } = route.params;
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const focused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(Math.min(start, ids.length - 1));
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState<{
    name: string;
    scientificName: string;
    date: string | null;
    sensitive: boolean;
  } | null>(null);
  const [full, setFull] = useState<Record<string, FullState>>({});
  const [fullUris, setFullUris] = useState<Record<string, string>>({});
  const list = useRef<FlatList<string>>(null);
  const id = ids[index] ?? ids[0];
  // While the Info sheet is up the photo moves above it.
  const lift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(lift, { toValue: focused ? 0 : -height * 0.2, duration: 250, useNativeDriver: true }).start();
  }, [focused, height, lift]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cap = await captureByPhoto(app.db, id);
      const sp = cap ? await getSpecies(app.db, cap.scientificName) : null;
      if (!alive || !cap) return setInfo(null);
      const when = cap.takenAt ? [dateText(t, cap.takenAt), timeText(cap.takenAt)].filter(Boolean).join(", ") : null;
      setInfo({
        name: sp?.commonName ?? cap.scientificName,
        scientificName: cap.scientificName,
        date: when,
        sensitive: app.isSensitive(cap.scientificName, !!sp?.sensitive),
      });
    })();
    return () => {
      alive = false;
    };
  }, [app, id, t]);

  const onViewable = useRef(({ viewableItems }: { viewableItems: { index?: number | null }[] }) => {
    const first = viewableItems[0];
    if (first?.index != null) setIndex(first.index);
  }).current;

  const viewFull = useCallback(async () => {
    setFull((s) => ({ ...s, [id]: "loading" }));
    const res = await app.media.full(id);
    if (res.ok) {
      setFullUris((u) => ({ ...u, [id]: res.path }));
      setFull((s) => ({ ...s, [id]: "done" }));
    } else setFull((s) => ({ ...s, [id]: res.reason }));
  }, [app.media, id]);

  const share = () =>
    info?.sensitive ? nav.navigate("ShareSensitive", { photoId: id }) : void shareDisplayCopy(app, id);
  const state = full[id] ?? "idle";
  const more = () =>
    showActions(info?.name ?? t("viewer.photoLabel"), t("common.cancel"), [
      ...(state === "done" || !app.api
        ? []
        : [
            {
              label: t(state === "loading" ? "viewer.gettingFull" : "viewer.fullSize"),
              onPress: () => void viewFull(),
            },
          ]),
      ...(info
        ? [
            {
              label: t("viewer.openSpecies"),
              onPress: () => nav.navigate("Species", { scientificName: info.scientificName }),
            },
          ]
        : []),
    ]);

  // Drag down to close, as in Photos: the photo follows the finger and shrinks while the backdrop fades.
  // Zoomed in, the drag pans the photo instead; two fingers are always a pinch.
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const onZoom = useCallback((p: string, z: boolean) => setZoomedId((cur) => (z ? p : cur === p ? null : cur)), []);
  const drag = useRef(new Animated.ValueXY()).current;
  const fade = drag.y.interpolate({ inputRange: [0, height / 2], outputRange: [1, 0], extrapolate: "clamp" });
  const shrink = drag.y.interpolate({ inputRange: [0, height / 2], outputRange: [1, MIN_SCALE], extrapolate: "clamp" });
  const close = () => nav.goBack();
  const pan = Gesture.Pan()
    .runOnJS(true)
    .enabled(zoomedId !== id)
    .maxPointers(1)
    .activeOffsetY([-24, 24])
    .failOffsetX([-16, 16])
    // Upward drags only nudge the photo, with resistance.
    .onUpdate((e) => drag.setValue({ x: e.translationX, y: e.translationY > 0 ? e.translationY : e.translationY / 3 }))
    .onEnd((e) => {
      if (shouldDismiss(e.translationY, e.velocityY, height)) {
        Animated.timing(drag, {
          toValue: { x: e.translationX, y: height },
          duration: 180,
          useNativeDriver: true,
        }).start(close);
        return;
      }
      Animated.spring(drag, { toValue: { x: 0, y: 0 }, useNativeDriver: true, bounciness: 4 }).start();
      if (e.translationY < -INFO_DISTANCE) nav.navigate("PhotoInfo", { photoId: id });
    });

  const near = ids
    .slice(Math.max(0, index - FILMSTRIP), index + FILMSTRIP + 1)
    .map((p, k) => ({ id: p, at: Math.max(0, index - FILMSTRIP) + k }));
  const label = (n: string | null) =>
    [info?.name, info?.date, t("viewer.position", { n: index + 1, total: ids.length })].filter(Boolean).join(". ") ||
    (n ?? t("viewer.photoLabel"));

  return (
    // A transparent modal, so the page underneath shows through as the backdrop fades.
    <View style={{ flex: 1 }} accessibilityViewIsModal onAccessibilityEscape={close}>
      <StatusBar style="light" />
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: BACKDROP, opacity: fade }]}
      />
      <GestureDetector gesture={pan}>
        <Animated.View style={{ flex: 1, transform: [{ translateY: lift }] }}>
          <Animated.View
            style={{ flex: 1, transform: [{ translateX: drag.x }, { translateY: drag.y }, { scale: shrink }] }}
          >
            <FlatList
              ref={list}
              data={ids}
              horizontal
              pagingEnabled
              initialScrollIndex={Math.min(start, ids.length - 1)}
              keyExtractor={(p) => p}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              onViewableItemsChanged={onViewable}
              viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
              windowSize={3}
              initialNumToRender={1}
              maxToRenderPerBatch={2}
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => (
                <ViewerPage
                  id={item}
                  width={width}
                  height={height}
                  fullUri={fullUris[item]}
                  label={label(null)}
                  onTap={() => setChrome((c) => !c)}
                  onZoom={onZoom}
                />
              )}
            />
          </Animated.View>
        </Animated.View>
      </GestureDetector>

      {chrome && focused ? (
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity: fade }]}>
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              top: insets.top + 6,
              left: 16,
              right: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <RoundButton icon="close" label={t("common.close")} onPress={close} onPhoto />
            <View style={{ flex: 1, alignItems: "center" }} accessible accessibilityRole="header">
              {info ? (
                <>
                  <Text
                    numberOfLines={1}
                    style={{ color: ON_BACKDROP, fontSize: type.callout.size, fontWeight: "700" }}
                  >
                    {info.name}
                  </Text>
                  {info.date ? (
                    <Text numberOfLines={1} style={{ color: ON_BACKDROP, opacity: 0.75, fontSize: type.footnote.size }}>
                      {info.date}
                    </Text>
                  ) : null}
                </>
              ) : null}
            </View>
            <RoundButton icon="more" label={t("common.more")} onPress={more} onPhoto />
          </View>

          <View
            pointerEvents="box-none"
            style={{ position: "absolute", left: 0, right: 0, bottom: Math.max(insets.bottom, 12) + 70 }}
          >
            {state === "offline" ? <Text style={noteStyle}>{t("viewer.fullOffline")}</Text> : null}
            {state === "unavailable" ? <Text style={noteStyle}>{t("viewer.fullUnavailable")}</Text> : null}
            <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 2 }}>
              {near.map((n) => (
                <View
                  key={n.id}
                  style={{
                    width: n.at === index ? 40 : 28,
                    height: 40,
                    marginHorizontal: n.at === index ? 4 : 0,
                    borderRadius: n.at === index ? 6 : 3,
                    overflow: "hidden",
                    borderWidth: n.at === index ? 2 : 0,
                    borderColor: ON_BACKDROP,
                    opacity: n.at === index ? 1 : 0.85,
                  }}
                >
                  <CachedTile
                    photoId={n.id}
                    size={40}
                    width={n.at === index ? 40 : 28}
                    label={t("viewer.goTo", { n: n.at + 1 })}
                    onPress={() => list.current?.scrollToIndex({ index: n.at, animated: true })}
                  />
                </View>
              ))}
            </View>
          </View>

          <View
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: Math.max(insets.bottom, 12),
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <RoundButton icon="share" label={t("viewer.share")} size={52} onPress={share} onPhoto />
            <RoundButton
              icon="info"
              label={t("viewer.info")}
              size={52}
              onPress={() => nav.navigate("PhotoInfo", { photoId: id })}
              onPhoto
            />
            <RoundButton icon="more" label={t("common.more")} size={52} onPress={more} onPhoto />
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const noteStyle = {
  color: ON_BACKDROP,
  fontSize: type.footnote.size,
  textAlign: "center",
  paddingBottom: 10,
  paddingHorizontal: 20,
} as const;

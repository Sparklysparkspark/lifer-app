import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { AccessibilityInfo, Animated, Text, View, useWindowDimensions } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTranslation } from "react-i18next";
import { MONTH_KEYS } from "../labels";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { CachedTile } from "./CachedTile";
import { haptics } from "../ui/haptics";
import { buildGrid, monthAt, rowOfPhoto, type Grid, type Shaped } from "./layout";
import { DENSE_FROM, pinchGate } from "./pinch";
import { Scrubber, type ScrubberHandle } from "./Scrubber";
import { usePullRefresh } from "../ui/usePullRefresh";


/** Day and month in words for a tile's spoken label, "12 May 2026". */
function dateLabel(t: (k: string) => string, takenAt: string | null): string | null {
  const m = takenAt && /^(\d{4})-(\d{2})-(\d{2})/.exec(takenAt);
  return m ? `${Number(m[3])} ${t(MONTH_KEYS[Number(m[2]) - 1])} ${m[1]}` : null;
}

interface Props {
  photos: Shaped[];
  /** Month headings (with the place) and a scrubber: the whole library. */
  byMonth?: boolean;
  /** With `byMonth`: one seamless grid, no headings, the scrubber still names the month. */
  continuous?: boolean;
  /** Squares this many across (see COLUMN_STEPS), or photos kept in their shape. */
  columns?: number;
  aspect?: boolean;
  places?: Record<string, string>;
  onOpen: (index: number) => void;
  /** Pinch out for bigger tiles (fewer columns), pinch in for smaller: called with the steps committed so far (positive: bigger). */
  onPinch?: (steps: number) => void;
  header?: ReactElement;
  /** Below the last row (clearance for a floating toolbar). */
  footer?: ReactElement;
  /** The first block runs under a transparent navigation bar (a photo hero), so no automatic inset. */
  underBar?: boolean;
  empty?: ReactElement;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** A virtualized grid with fixed row heights, so 60,000 photos scroll without measuring. */
export function PhotoGrid({ photos, byMonth, continuous, columns = 3, aspect, places, onOpen, onPinch, header, footer, underBar, empty, onRefresh, refreshing }: Props) {
  const { width, fontScale: scale } = useWindowDimensions();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const pull = usePullRefresh(onRefresh, refreshing ?? false);
  // The heading grows with Dynamic Type and wraps to two lines; its row height is fixed so the list can skip measuring.
  const lines = scale > 1.3 ? 3 : 1;
  const headingHeight = Math.round(18 + 26 * Math.min(scale, 3.2) * lines);
  const grid = useMemo<Grid>(
    () => buildGrid(photos, { width, headingHeight, withHeadings: !!byMonth && !continuous }, aspect ? { aspect: width >= 700 ? 200 : 130 } : { columns }),
    [photos, width, headingHeight, byMonth, continuous, aspect, columns],
  );
  const dense = !aspect && columns >= DENSE_FROM;
  const list = useRef<FlashListRef<Grid["rows"][number]>>(null);
  const scrubber = useRef<ScrubberHandle>(null);
  const total = grid.offsets.length ? grid.offsets[grid.offsets.length - 1] + grid.heights[grid.heights.length - 1] : 0;
  const viewport = useRef(1);
  const offsetY = useRef(0);

  const monthLabel = (monthKey: string) =>
    monthKey === "undated" ? t("photos.undated") : `${t(MONTH_KEYS[Number(monthKey.slice(5, 7)) - 1])} ${monthKey.slice(0, 4)}`;
  const scrubTo = (f: number) => list.current?.scrollToOffset({ offset: f * Math.max(0, total - viewport.current), animated: false });

  // The photo under the fingers stays there: remember it when a step commits, then scroll it back once the new grid is laid out.
  const headerHeight = useRef(0);
  const anchor = useRef<{ index: number; y: number } | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const reduceMotion = useRef(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduceMotion.current = v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => (reduceMotion.current = v));
    return () => sub.remove();
  }, []);
  const latest = useRef({ grid, columns, width });
  latest.current = { grid, columns, width };

  const pinch = useMemo(() => {
    const gate = pinchGate();
    return Gesture.Pinch()
      .runOnJS(true)
      .onBegin(() => {
        gate.begin();
        anchor.current = null;
      })
      .onUpdate((e) => {
        const steps = gate.update(e.scale);
        if (!steps) return;
        const { grid: g, columns: c, width: w } = latest.current;
        const y = offsetY.current + e.focalY - headerHeight.current;
        let row = 0;
        while (row + 1 < g.offsets.length && g.offsets[row + 1] <= y) row++;
        const r = g.rows[row];
        if (r?.type === "photos") {
          const at = Math.min(r.ids.length - 1, Math.floor(e.focalX / (w / c)));
          anchor.current = { index: g.firstIndex[row] + at, y: e.focalY };
        }
        haptics.step();
        if (!reduceMotion.current) Animated.sequence([Animated.timing(fade, { toValue: 0.6, duration: 60, useNativeDriver: true }), Animated.timing(fade, { toValue: 1, duration: 140, useNativeDriver: true })]).start();
        onPinch?.(steps);
      });
  }, [onPinch, fade]);

  useEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const row = rowOfPhoto(grid, a.index);
    if (row < 0) return;
    list.current?.scrollToOffset({ offset: Math.max(0, headerHeight.current + grid.offsets[row] + grid.heights[row] / 2 - a.y), animated: false });
  }, [grid]);

  const body = (
    <FlashList
      ref={list}
      data={grid.rows}
      keyExtractor={(r) => r.key}
      getItemType={(r) => r.type}
      contentInsetAdjustmentBehavior={underBar ? "never" : "automatic"}
      keyboardDismissMode="on-drag"
      ListFooterComponent={footer}
      ListHeaderComponent={header ? <View onLayout={(e) => (headerHeight.current = e.nativeEvent.layout.height)}>{header}</View> : undefined}
      ListEmptyComponent={empty}
      stickyHeaderIndices={grid.headings}
      drawDistance={dense ? 600 : 400}
      onRefresh={pull.onRefresh}
      refreshing={pull.refreshing}
      onLayout={(e) => (viewport.current = e.nativeEvent.layout.height)}
      onScroll={(e) => {
        offsetY.current = e.nativeEvent.contentOffset.y;
        scrubber.current?.follow(offsetY.current / Math.max(1, total - viewport.current));
      }}
      scrollEventThrottle={32}
      renderItem={({ item, index }) =>
        item.type === "heading" ? (
          <View
            accessible
            accessibilityRole="header"
            style={{ height: headingHeight, justifyContent: "flex-end", paddingHorizontal: spacing.page, paddingBottom: 6, backgroundColor: colors.canvas }}
          >
            <Text numberOfLines={lines} style={{ color: colors.ink, fontSize: type["title-3"].size, fontWeight: "700" }}>
              {monthLabel(item.monthKey)}
              {places?.[item.monthKey] ? (
                <Text style={{ color: colors.muted, fontSize: type.subheadline.size, fontWeight: "400" }}>{`  ${places[item.monthKey]}`}</Text>
              ) : null}
            </Text>
          </View>
        ) : (
          <View style={{ flexDirection: "row", height: grid.heights[index] }}>
            {item.ids.map((id, k) => {
              const p = photos[grid.firstIndex[index] + k];
              const label = [p?.name, dateLabel(t, p?.takenAt ?? null)].filter(Boolean).join(", ") || t("photos.tile");
              return (
                <CachedTile
                  key={id}
                  photoId={id}
                  size={grid.heights[index]}
                  width={item.widths[k]}
                  dense={dense}
                  label={label}
                  onPress={() => onOpen(grid.firstIndex[index] + k)}
                />
              );
            })}
          </View>
        )
      }
    />
  );

  return (
    <View style={{ flex: 1 }}>
      {onPinch ? (
        <GestureDetector gesture={pinch}>
          <Animated.View style={{ flex: 1, opacity: fade }}>{body}</Animated.View>
        </GestureDetector>
      ) : (
        body
      )}
      {byMonth && grid.months.length > 1 ? (
        <Scrubber
          ref={scrubber}
          label={t("photos.scrubber")}
          bubble={(f) => monthLabel(monthAt(grid, f)?.monthKey ?? "undated")}
          onScrub={scrubTo}
          onStep={(dir) => {
            let cur = 0;
            grid.months.forEach((m, i) => (grid.offsets[m.row] <= offsetY.current + 1 ? (cur = i) : 0));
            const next = grid.months[Math.max(0, Math.min(grid.months.length - 1, cur + dir))];
            list.current?.scrollToIndex({ index: next.row, animated: true });
          }}
        />
      ) : null}
    </View>
  );
}

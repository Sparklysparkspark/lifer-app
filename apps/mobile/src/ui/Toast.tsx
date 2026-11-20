import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Glass } from "./Glass";
import { Tap } from "./Tap";

interface ToastItem {
  id: number;
  message: string;
  undo?: () => void;
}
interface Toasts {
  /** A short confirmation. With `undo`, the person can take it back (F3). */
  show(message: string, undo?: () => void): void;
}

const Ctx = createContext<Toasts>({ show: () => undefined });
export const useToast = (): Toasts => useContext(Ctx);

const SHOWN_MS = 5000;

/** Confirmations with Undo, floating above the tab bar. Announced politely; never blocks a tap behind it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const next = useRef(1);
  const show = useCallback((message: string, undo?: () => void) => {
    clearTimeout(timer.current);
    setItem({ id: next.current++, message, undo });
    timer.current = setTimeout(() => setItem(null), SHOWN_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {item ? <ToastView item={item} onDone={() => setItem(null)} /> : null}
    </Ctx.Provider>
  );
}

function ToastView({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: spacing.gutter, right: spacing.gutter, bottom: insets.bottom + 96 }}>
      <Glass style={{ borderRadius: 26, overflow: "hidden" }}>
        <View
          accessibilityLiveRegion="polite"
          accessible
          accessibilityLabel={item.message}
          style={{ flexDirection: "row", alignItems: "center", paddingLeft: 18, paddingRight: 6, minHeight: 52, gap: 8 }}
        >
          <Text style={{ flex: 1, color: colors.ink, fontSize: type.subheadline.size, paddingVertical: 10 }}>{item.message}</Text>
          {item.undo ? (
            <Tap
              label={t("common.undo")}
              onPress={() => {
                item.undo?.();
                onDone();
              }}
            >
              <View style={{ minHeight: 44, minWidth: 56, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 }}>
                <Text style={{ color: colors.link, fontSize: type.subheadline.size, fontWeight: "700" }}>{t("common.undo")}</Text>
              </View>
            </Tap>
          ) : null}
        </View>
      </Glass>
    </View>
  );
}

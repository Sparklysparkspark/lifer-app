// Fills the native navigation bar from a screen: title, search field, bar buttons and menus, and the
// round account button last on every tab. The bar is the platform's own (UINavigationBar, iOS 26 glass).
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Platform, View } from "react-native";
import type { NativeStackHeaderItem, NativeStackNavigationOptions } from "@react-navigation/native-stack";
import type { SearchBarCommands } from "react-native-screens";
import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import { useTheme } from "../theme/useTheme";
import { Icon, ICONS, type IconName } from "../ui/Icon";
import { showActions } from "../ui/actionMenu";
import { Tap } from "../ui/Tap";
import { useNav } from "./types";

export type MenuEntry =
  | {
      type: "action";
      label: string;
      onPress: () => void;
      checked?: boolean;
      icon?: IconName;
      destructive?: boolean;
      disabled?: boolean;
    }
  | { type: "submenu"; label: string; description?: string; icon?: IconName; inline?: boolean; items: MenuEntry[] };

export type BarItem =
  | {
      type: "button";
      key: string;
      label: string;
      icon?: IconName;
      onPress: () => void;
      badge?: string;
      separate?: boolean;
      prominent?: boolean;
      tint?: string;
    }
  | {
      type: "menu";
      key: string;
      label: string;
      icon: IconName;
      title?: string;
      items: MenuEntry[];
      separate?: boolean;
    };

export interface HeaderOpts {
  title?: string;
  /** Bar buttons before the account button. */
  items?: BarItem[];
  /** Leave the account button off (sheets and pushed pages that have their own buttons). */
  noAccount?: boolean;
  search?: {
    placeholder: string;
    onChange: (text: string) => void;
    hideWhenScrolling?: boolean;
    /** Lets the screen put text in the field (a removed search token takes its words out). */
    ref?: RefObject<SearchBarCommands | null>;
  };
  /** Anything else the native stack takes (back button text, large title off, and so on). */
  options?: NativeStackNavigationOptions;
}

const sf = (icon?: IconName) => (icon ? ({ type: "sfSymbol", name: ICONS[icon].ios } as const) : undefined);

/** Account button state in words: one place to read how the phone stands with the Lifer. */
export function useAccountState(): { label: string; badge: string | undefined } {
  const { t } = useTranslation();
  const { sync, mode } = useApp();
  if (mode === "standalone") return { label: t("account.labelAlone"), badge: undefined };
  if (sync.keyRefused) return { label: t("account.labelRefused"), badge: "!" };
  const stale = sync.lastSyncAt ? Date.now() - new Date(sync.lastSyncAt).getTime() > 24 * 3600_000 : false;
  if (!sync.reachable && stale) return { label: t("account.labelStale"), badge: "!" };
  if (sync.waiting > 0) return { label: t("account.labelWaiting", { n: sync.waiting }), badge: undefined };
  return { label: t("account.labelUpToDate"), badge: undefined };
}

const flatten = (items: MenuEntry[]): MenuEntry[] =>
  items.flatMap((i) => (i.type === "submenu" ? flatten(i.items) : [i]));

export function useHeader(opts: HeaderOpts): void {
  const nav = useNav();
  const { colors } = useTheme();
  const account = useAccountState();
  const latest = useRef(opts);
  latest.current = opts;
  // Callbacks are looked up by path at press time, so the bar need not be rebuilt when a closure changes.
  const calls = useRef(new Map<string, () => void>());

  const items: BarItem[] = [
    ...(opts.items ?? []),
    ...(opts.noAccount
      ? []
      : [
          {
            type: "button",
            key: "account",
            label: account.label,
            icon: "account",
            onPress: () => nav.navigate("YourLifer"),
            badge: account.badge,
          } as BarItem,
        ]),
  ];

  const table = new Map<string, () => void>();
  const collect = (es: MenuEntry[], path: string) =>
    es.forEach((e, k) =>
      e.type === "submenu" ? collect(e.items, `${path}.${k}`) : table.set(`${path}.${k}`, e.onPress),
    );
  items.forEach((i, n) => (i.type === "button" ? table.set(`${n}`, i.onPress) : collect(i.items, `${n}`)));
  calls.current = table;
  const register = (path: string) => () => calls.current.get(path)?.();

  const native = (list: BarItem[]): NativeStackHeaderItem[] =>
    list.map((i, n) => {
      const share = i.separate ? { sharesBackground: false } : {};
      if (i.type === "button")
        return {
          type: "button",
          label: i.label,
          icon: sf(i.icon),
          onPress: register(`${n}`),
          variant: i.prominent ? "prominent" : "plain",
          tintColor: i.tint,
          badge: i.badge ? { value: i.badge } : undefined,
          accessibilityLabel: i.label,
          ...share,
        };
      const entries = (es: MenuEntry[], path: string): never[] =>
        es.map((e, k) =>
          e.type === "submenu"
            ? {
                type: "submenu",
                label: e.label,
                description: e.description,
                icon: sf(e.icon),
                inline: e.inline,
                items: entries(e.items, `${path}.${k}`),
              }
            : {
                type: "action",
                label: e.label,
                icon: sf(e.icon),
                state: e.checked ? "on" : undefined,
                destructive: e.destructive,
                disabled: e.disabled,
                onPress: register(`${path}.${k}`),
              },
        ) as never[];
      return {
        type: "menu",
        label: i.label,
        icon: sf(i.icon),
        menu: { title: i.title, items: entries(i.items, `${n}`) },
        accessibilityLabel: i.label,
        ...share,
      } as NativeStackHeaderItem;
    });

  const androidRight = (): ReactNode => (
    <View style={{ flexDirection: "row" }}>
      {items.map((i) => (
        <Tap
          key={i.key}
          label={i.label}
          onPress={() =>
            i.type === "button"
              ? i.onPress()
              : showActions(
                  i.title ?? i.label,
                  "Cancel",
                  flatten(i.items).flatMap((e) =>
                    e.type === "action" ? [{ label: e.label, onPress: e.onPress }] : [],
                  ),
                )
          }
        >
          <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
            {i.icon ? <Icon name={i.icon} color={colors.ink} /> : null}
          </View>
        </Tap>
      ))}
    </View>
  );

  // Rebuild the bar only when something visible changed.
  const signature = JSON.stringify(
    [opts.title, opts.search?.placeholder, opts.search?.hideWhenScrolling, colors.ink, items, opts.options],
    (_k, v) => (typeof v === "function" ? undefined : v),
  );
  useLayoutEffect(() => {
    const o = latest.current;
    nav.setOptions({
      ...(o.title !== undefined ? { title: o.title } : {}),
      unstable_headerRightItems: Platform.OS === "ios" ? () => native(items) : undefined,
      headerRight: Platform.OS === "ios" ? undefined : androidRight,
      headerSearchBarOptions: o.search
        ? {
            placeholder: o.search.placeholder,
            ref: o.search.ref,
            placement: "stacked",
            hideWhenScrolling: o.search.hideWhenScrolling ?? false,
            autoCapitalize: "none",
            tintColor: colors.link,
            onChangeText: (e) => latest.current.search?.onChange(e.nativeEvent.text),
            onCancelButtonPress: () => latest.current.search?.onChange(""),
          }
        : undefined,
      ...o.options,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, signature]);
}

/** A sheet's own bar: its title (from the route) and a Done button that closes it. */
export function useSheetHeader(extra: BarItem[] = [], search?: HeaderOpts["search"]): void {
  const { t } = useTranslation();
  const nav = useNav();
  const { colors } = useTheme();
  useHeader({
    noAccount: true,
    search,
    items: [
      ...extra,
      {
        type: "button",
        key: "done",
        label: t("common.done"),
        onPress: () => nav.goBack(),
        prominent: true,
        tint: colors.accent,
      },
    ],
  });
}

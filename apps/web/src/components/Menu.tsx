import { useTranslation } from "react-i18next";
import { matches } from "../lib/keymap";
import { Link, type LinkProps } from "react-router-dom";
import {
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { OVERLAY_REVEAL, buttonClasses, iconButtonClasses } from "../lib/buttonClasses";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../lib/menuClasses";
import { useExclusiveOpen } from "../lib/exclusivePopover";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import DotsIcon from "./DotsIcon";
import { Tooltip } from "./Tooltip";

// Closes the menu an item sits in.
const MenuClose = createContext<(() => void) | null>(null);

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: (e: MouseEvent) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
}

/** The one menu: a trigger and a MenuPanel of MenuItems. The caller owns the open state
 *  (usually useDropdownMenu, so one menu is open at a time); Escape and outside clicks close it,
 *  and focus goes back to the trigger. */
export default function Menu({
  open,
  onToggle,
  menuRef,
  children,
  className,
  anchorPoint,
  trigger = "dots",
}: {
  open: boolean;
  onToggle: () => void;
  /** Attached only while open, matching useDropdownMenu's contract. */
  menuRef?: RefObject<HTMLDivElement | null>;
  /** A MenuPanel (or a component rendering one), which takes the measured position. */
  children: ReactNode;
  /** Positions the trigger; defaults to the top-right corner. */
  className?: string;
  /** Right-click mode: no trigger; the panel is portaled to body at this viewport point and
   *  clamped to the window edges. */
  anchorPoint?: { x: number; y: number } | null;
  /** "dots" over a photo (a dark pill shown on hover), "plain" on a card or row, "toolbar" beside a
   *  toolbar's other buttons, or a custom trigger given these props. */
  trigger?: "dots" | "plain" | "toolbar" | ((props: MenuTriggerProps) => ReactNode);
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Back to the trigger once closed, unless the menu's action moved focus somewhere (a dialog).
  // Opening this menu closes any other menu or popover that's open.
  useExclusiveOpen(open, () => {
    if (open) onToggle();
  });
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const frame = requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body)
          triggerRef.current?.focus({ preventScroll: true });
      });
      wasOpen.current = open;
      return () => cancelAnimationFrame(frame);
    }
    wasOpen.current = open;
  }, [open]);
  // The panel mounts in the same commit `open` turns on, so it's attached before the layout
  // effects below measure it.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [fixedPosition, setFixedPosition] = useState<{ top: number; left: number } | null>(null);
  // A trigger menu sits on the top layer against its trigger, so a dialog body or card never clips it.
  const align = isValidElement(children) ? (children.props as { align?: "left" | "right" }).align : undefined;
  const anchored = useAnchoredPosition(triggerRef, panelRef, open && !anchorPoint, { align: align ?? "right" });

  const anchorX = anchorPoint?.x;
  const anchorY = anchorPoint?.y;
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (anchorX == null || anchorY == null || !open || !el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let top = anchorY;
    let left = anchorX;
    if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
    top = Math.max(margin, top);
    left = Math.max(margin, left);
    setFixedPosition({ top, left });
  }, [open, anchorX, anchorY]);

  const panel =
    open &&
    isValidElement(children) &&
    // eslint-disable-next-line react-hooks/refs -- cloneElement only attaches the ref, as ref={panelRef} would in JSX; nothing reads it during render
    cloneElement(children as ReactElement<{ ref?: RefObject<HTMLDivElement | null>; style?: CSSProperties }>, {
      ref: panelRef,
      style: !anchorPoint
        ? anchored
        : fixedPosition
          ? {
              position: "fixed",
              top: fixedPosition.top,
              left: fixedPosition.left,
              right: "auto",
              // Caps the size in case it grows after the measurement.
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "calc(100vh - 16px)",
            }
          : // First paint, before measuring: hidden at the click point so it never flashes at (0,0).
            { position: "fixed", top: anchorPoint.y, left: anchorPoint.x, right: "auto", visibility: "hidden" },
    });

  const close = () => {
    if (open) onToggle();
  };

  if (anchorPoint) {
    // Portaled so overflow-hidden tiles don't clip it; on the dialog layer so it opens inside one too.
    return open
      ? createPortal(
          <MenuClose.Provider value={close}>
            <div ref={menuRef} data-menu-layer className="relative z-50">
              {panel}
            </div>
          </MenuClose.Provider>,
          document.body,
        )
      : null;
  }

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
  };
  return (
    <div className={className ?? "absolute right-2 top-1.5"} ref={open ? menuRef : undefined}>
      {typeof trigger === "function" ? (
        // eslint-disable-next-line react-hooks/refs -- the trigger only attaches the ref, as ref={triggerRef} would in JSX
        trigger(triggerProps)
      ) : (
        <Tooltip content={trigger === "toolbar" ? { label: t("ui.moreOptions") } : undefined}>
          {(tip) => (
            <button
              type="button"
              {...tip}
              {...triggerProps}
              ref={(el) => {
                tip.ref?.(el);
                triggerRef.current = el;
              }}
              aria-label={t("ui.moreOptions")}
              className={
                trigger === "toolbar"
                  ? buttonClasses("secondary", "sm", "w-8 px-0! text-body")
                  : trigger === "plain"
                    ? "rounded-control px-2 py-0.5 text-title-3 leading-none text-muted hover:bg-surface-muted hover:text-ink"
                    : iconButtonClasses("overlay", false, open ? "" : OVERLAY_REVEAL)
              }
            >
              {/* Over a photo the dots are drawn, to match the Preview pill beside them exactly. */}
              {trigger === "dots" ? <DotsIcon /> : "⋯"}
            </button>
          )}
        </Tooltip>
      )}
      {panel &&
        createPortal(
          <MenuClose.Provider value={close}>
            <div data-menu-layer className="relative z-50">
              {panel}
            </div>
          </MenuClose.Provider>,
          document.body,
        )}
    </div>
  );
}

const ITEMS = '[role="menuitem"]:not([disabled])';

/** The menu's panel. Arrow keys, Home and End move between items, a letter jumps to the next item
 *  starting with it, and Tab closes the menu. */
export function MenuPanel({
  ref,
  style,
  className = "w-48",
  align = "right",
  children,
}: {
  /** From Menu, which measures the panel and moves it to stay on the page. */
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  /** Width, and anything else particular to this menu. */
  className?: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  children: ReactNode;
}) {
  const close = useContext(MenuClose);
  const own = useRef<HTMLDivElement | null>(null);
  // Opening a menu puts focus on its first item, as a native menu does.
  useEffect(() => {
    own.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (matches(e, "listNext")) next = (at + 1) % items.length;
    else if (matches(e, "listPrevious")) next = (at - 1 + items.length) % items.length;
    else if (matches(e, "listFirst")) next = 0;
    else if (matches(e, "listLast")) next = items.length - 1;
    else if (matches(e, "focusCycle")) {
      // Back to the trigger, as a native menu does, not on to whatever follows the portal.
      e.preventDefault();
      close?.();
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const key = e.key.toLowerCase();
      for (let i = 1; i <= items.length; i++) {
        const j = (at + i) % items.length;
        if (items[j].textContent?.trim().toLowerCase().startsWith(key)) {
          next = j;
          break;
        }
      }
    }
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    }
  }

  // Mouse and keys share one highlight (focus). Only real movement takes it, so a mouse resting on
  // an item doesn't hold a second highlight while arrow keys move on.
  function onMouseMove(e: MouseEvent<HTMLDivElement>) {
    const item = (e.target as Element).closest<HTMLElement>(ITEMS);
    if (item && item !== document.activeElement) item.focus({ preventScroll: true });
  }

  return (
    <div
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      style={style}
      role="menu"
      onKeyDown={onKeyDown}
      onMouseMove={onMouseMove}
      className={`absolute top-full z-30 mt-1 ${align === "right" ? "right-0" : "left-0"} ${MENU_PANEL} ${className}`}
    >
      {children}
    </div>
  );
}

/** One action. Closes the menu first unless `keepOpen` (a rating nudged in place). */
export function MenuItem({
  onSelect,
  danger = false,
  disabled,
  keepOpen = false,
  title,
  children,
}: {
  onSelect: (e: MouseEvent) => void;
  /** Destructive: red, and listed last after a separator. */
  danger?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!keepOpen) close?.();
        onSelect(e);
      }}
      className={danger ? MENU_ITEM_DANGER : MENU_ITEM}
    >
      {children}
    </button>
  );
}

/** An item that goes to another page (`to`) or opens a site in the browser (`href`). */
export function MenuLink({
  children,
  ...props
}: ({ to: LinkProps["to"]; state?: unknown; href?: never } | { href: string; to?: never; state?: never }) & {
  children: ReactNode;
}) {
  const close = useContext(MenuClose);
  const shared = {
    role: "menuitem",
    tabIndex: -1,
    className: MENU_ITEM,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      close?.();
    },
  };
  // target=_blank links open in the system browser inside the desktop app (see main.tsx).
  return props.href !== undefined ? (
    // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
    <a href={props.href} target="_blank" rel="noreferrer" {...shared}>
      {children}
    </a>
  ) : (
    <Link to={props.to} state={props.state} {...shared}>
      {children}
    </Link>
  );
}

export function MenuSeparator() {
  return <div role="separator" className={MENU_SEPARATOR} />;
}

/** A run of related items. Sections are divided by a line, never at the top or bottom, and one
 *  whose items all render nothing disappears with its line (see index.css). */
export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <div role="none" data-menu-section>
      {children}
    </div>
  );
}

/** Text in a menu that isn't an action (who's signed in, why an action is missing). */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <p role="none" className="truncate px-3 py-1.5 text-muted">
      {children}
    </p>
  );
}

/** Controls in a menu that aren't items, e.g. a star rating; named for screen readers. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5"
    >
      <span className="text-muted">{label}</span>
      {children}
    </div>
  );
}

export interface MenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Items from a list, destructive ones moved last after a separator. */
export function MenuItems({ items }: { items: readonly MenuAction[] }) {
  const ordered = [...items.filter((i) => !i.danger), ...items.filter((i) => i.danger)];
  const firstDanger = ordered.findIndex((i) => i.danger);
  return ordered.map((item, i) => (
    <Fragment key={item.label}>
      {i === firstDanger && i > 0 && <MenuSeparator />}
      <MenuItem onSelect={item.onSelect} danger={item.danger} disabled={item.disabled}>
        {item.label}
      </MenuItem>
    </Fragment>
  ));
}

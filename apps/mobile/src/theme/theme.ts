// Colours come from the shared tokens (generated from the web theme). Sunlight is phone-only:
// pure ink on white for direct sun, 7:1 for text and 4.5:1 for controls (MR6).
import { designTokens } from "@lifer/shared";

export type Appearance = "light" | "dark" | "sunlight";

/** Phone-only tokens the glass bars, cards and sheets need beyond the shared palette. */
interface Extras {
  /** Quiet fill for search fields, secondary buttons and progress tracks. */
  fill: string;
  /** Separator inside inset groups. */
  sep: string;
  /** Selected tab and soft status panels. */
  accentTint: string;
  /** Translucent surface for floating pieces where the glass material is not available. */
  glass: string;
  /** Hairline round glass and cards. */
  hairline: string;
  scrim: string;
  /** Destructive actions. */
  danger: string;
  /** Cards, tiles and covers not yet cached. */
  placeholder: string;
}
export type Palette = { [K in keyof typeof designTokens.light]: string } & Extras;

const extras: Record<Appearance, Extras> = {
  light: {
    fill: "rgba(120,100,60,0.11)",
    sep: "rgba(60,50,30,0.11)",
    accentTint: "rgba(104,116,94,0.14)",
    glass: "rgba(253,250,243,0.86)",
    hairline: "rgba(60,50,30,0.12)",
    scrim: "rgba(40,35,25,0.18)",
    danger: "#b3261e",
    placeholder: designTokens.light["surface-muted"],
  },
  dark: {
    fill: "rgba(120,124,128,0.22)",
    sep: "rgba(255,255,255,0.1)",
    accentTint: "rgba(179,192,165,0.14)",
    glass: "rgba(42,45,47,0.86)",
    hairline: "rgba(255,255,255,0.14)",
    scrim: "rgba(0,0,0,0.4)",
    danger: "#ff8a80",
    placeholder: designTokens.dark["surface-muted"],
  },
  // Sunlight is solid: no translucency, heavier separators (plan: Sunlight).
  sunlight: {
    fill: "#e4e4e4",
    sep: "#6b6b6b",
    accentTint: "#e1e6dc",
    glass: "#ffffff",
    hairline: "#6b6b6b",
    scrim: "rgba(0,0,0,0.45)",
    danger: "#8c0000",
    placeholder: "#ececec",
  },
};

const sunlight = {
  ...designTokens.light,
  canvas: "#ffffff",
  surface: "#ffffff",
  "surface-muted": "#ececec",
  line: "#6b6b6b",
  ink: "#000000",
  muted: "#3a3a3a",
  accent: "#2b3524",
  "accent-fg": "#ffffff",
  control: "#ffffff",
  "control-line": "#6b6b6b",
  link: "#1f2a19",
};

export const palettes: Record<Appearance, Palette> = {
  light: { ...designTokens.light, ...extras.light },
  dark: { ...designTokens.dark, ...extras.dark },
  sunlight: { ...sunlight, ...extras.sunlight },
};

/** Side margins: 16 pt for grids and inset groups, 20 pt for titles and text; 24 pt between sections. */
export const spacing = { page: 20, gutter: 16, item: 16, section: 24, card: 12 } as const;

/** Concentric with the device: cards 16, inset groups 22, sheets 38, album covers 14, buttons are capsules. */
export const radius = { card: 16, group: 22, sheet: 38, cover: 14, control: 25, panel: 20, badge: 14 } as const;

/** iOS text styles at their default size; every one scales with Dynamic Type (the plan's table). */
export const type = {
  "large-title": { size: 34 },
  "title-1": { size: 28 },
  "title-2": { size: 22 },
  "title-3": { size: 20 },
  headline: { size: 17 },
  body: { size: 17 },
  callout: { size: 16 },
  subheadline: { size: 15 },
  footnote: { size: 13 },
  caption: { size: 12 },
  micro: { size: 11 },
} as const;

/** Minimum touch target (MR1): 44 pt on iOS, 48 dp on Android. */
export const MIN_TOUCH = { ios: 44, android: 48 } as const;

/** The full-screen photo viewer is black in every appearance, so a photo is judged on black. */
export const BACKDROP = "#000000";
export const ON_BACKDROP = "#ffffff";
/** Round glass buttons over a photo. */
export const BACKDROP_GLASS = "rgba(40,40,40,0.72)";
/** A dark wash under text laid over a photo. */
export const PHOTO_WASH = "rgba(0,0,0,0.38)";

import type { ComponentPropsWithoutRef } from "react";

export type SliderProps = Omit<ComponentPropsWithoutRef<"input">, "type" | "onChange" | "value" | "min" | "max"> & {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Read out instead of the bare number, e.g. "Large". */
  valueText?: string;
};

// The one slider: a native range input in the accent colour, so keyboard, touch and screen
// readers work everywhere and the track and thumb follow the theme in light and dark.
export default function Slider({ value, onChange, min, max, valueText, className = "", ...rest }: SliderProps) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-valuetext={valueText}
      className={`h-6 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50 ${className}`.trim()}
      {...rest}
    />
  );
}

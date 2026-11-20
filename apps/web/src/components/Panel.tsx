import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** The app's panel: content grouped on the page background. `grouped` is a list of rows split by
 *  hairlines, with no padding of its own (each row pads itself). Card adds a title. */
export default function Panel({
  as: Tag = "div",
  grouped = false,
  className = "",
  children,
  ...rest
}: ComponentPropsWithoutRef<"div"> & {
  as?: "div" | "section" | "ul" | "ol" | "form";
  grouped?: boolean;
  children?: ReactNode;
}) {
  const look = grouped
    ? "divide-y divide-line rounded-panel border border-line bg-surface"
    : "rounded-panel border border-line bg-surface p-panel";
  // The props are a div's; the few tags allowed here share them.
  const Element = Tag as "div";
  return (
    <Element className={`${look} ${className}`.trim()} {...rest}>
      {children}
    </Element>
  );
}

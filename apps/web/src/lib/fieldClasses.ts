// The text field look as class strings, shared by TextField, SearchInput and Select. The focus ring
// comes from the base rule in index.css; the border is set here, as a utility outranks that rule.
export const FIELD =
  "w-full min-w-0 rounded-control border border-control-line bg-control px-3 text-callout text-ink placeholder:text-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50";

// md is the form height, matching a md Button; sm matches toolbar controls (h-8).
export const FIELD_HEIGHT = { md: "h-9.5", sm: "h-8" } as const;

import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Remounts the app when the interface language changes, so every string re-renders in the new
// language, including ones computed once in a memo or outside a useTranslation component.
// Changing language is rare and deliberate, so losing in-page state then is fine.
export default function LocaleBoundary({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <Fragment key={i18n.resolvedLanguage ?? i18n.language}>{children}</Fragment>;
}

import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { NAME_COUNTDOWN_FROM, NAME_MAX_LENGTH } from "@lifer/shared";
import { FIELD, FIELD_HEIGHT } from "../lib/fieldClasses";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  ref?: Ref<HTMLInputElement>;
  size?: keyof typeof FIELD_HEIGHT;
};

// A text, number, email, date or password field in the app's one control style.
export default function TextField({ size = "md", className, type = "text", ...props }: Props) {
  return <input type={type} {...props} className={`${FIELD} ${FIELD_HEIGHT[size]} ${className ?? ""}`} />;
}

/** The field for an album or trip name: capped, with a countdown near the cap. */
export function NameField(props: Props) {
  const { t } = useTranslation();
  const left = NAME_MAX_LENGTH - String(props.value ?? "").length;
  return (
    <>
      <TextField {...props} maxLength={NAME_MAX_LENGTH} />
      {left <= NAME_MAX_LENGTH - NAME_COUNTDOWN_FROM && (
        <p aria-live="polite" className="mt-1 text-footnote text-muted">
          {t("ui.charactersLeft", { count: left })}
        </p>
      )}
    </>
  );
}

export function TextArea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...props} className={`${FIELD} py-2 ${className ?? ""}`} />;
}

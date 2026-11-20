import { useTranslation } from "react-i18next";
import { NAME_COUNTDOWN_FROM } from "@lifer/shared";
import { Platform, Text, TextInput, View, type TextInputProps } from "react-native";
import { MIN_TOUCH, radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

interface Props extends Pick<
  TextInputProps,
  "autoCapitalize" | "keyboardType" | "maxLength" | "returnKeyType" | "onSubmitEditing" | "autoComplete" | "autoFocus"
> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  hint?: string;
  placeholder?: string;
}

/** A labelled single-line field. The label is always visible, never only a placeholder. */
export function TextField({ label, value, onChangeText, hint, placeholder, ...input }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const left = input.maxLength === undefined ? null : input.maxLength - value.length;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.ink, fontSize: type.subheadline.size, fontWeight: "600" }}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCorrect={false}
        spellCheck={false}
        style={{
          minHeight: MIN_TOUCH[Platform.OS === "ios" ? "ios" : "android"],
          paddingHorizontal: spacing.item,
          borderRadius: radius.cover,
          borderWidth: 1,
          borderColor: colors["control-line"],
          backgroundColor: colors.control,
          color: colors.ink,
          fontSize: type.body.size,
        }}
      />
      {left !== null && left <= input.maxLength! - NAME_COUNTDOWN_FROM ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, fontSize: type.footnote.size }}>
          {t("common.charactersLeft", { n: left })}
        </Text>
      ) : null}
      {hint ? <Text style={{ color: colors.muted, fontSize: type.footnote.size }}>{hint}</Text> : null}
    </View>
  );
}

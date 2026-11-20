import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import { shareDisplayCopy } from "../app/share";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { Body, Button, Heading, Screen } from "../ui";

/** Asked once before sharing a photo of a sensitive species. The photo never carries where it was taken. */
export function ShareSensitiveSheet({ route }: { route: { params: RootParams["ShareSensitive"] } }) {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  useSheetHeader();
  return (
    <Screen>
      <Heading level="section" text={t("viewer.shareSensitiveTitle")} />
      <Body text={t("viewer.shareSensitiveBody")} />
      <Button
        label={t("viewer.share")}
        icon="share"
        onPress={() => {
          nav.goBack();
          setTimeout(() => void shareDisplayCopy(app, route.params.photoId), 350);
        }}
      />
      <Button variant="plain" label={t("common.cancel")} onPress={() => nav.goBack()} />
    </Screen>
  );
}

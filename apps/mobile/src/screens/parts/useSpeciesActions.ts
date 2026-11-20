import { Share } from "react-native";
import { useTranslation } from "react-i18next";
import { changeMark } from "../../app/actions";
import { useApp } from "../../app/AppContext";
import type { TapAction } from "../../ui/Tap";
import { haptics } from "../../ui/haptics";
import { showActions } from "../../ui/actionMenu";
import { useToast } from "../../ui/Toast";

interface Target {
  scientificName: string;
  commonName: string | null;
  status: "photographed" | "seen" | "none";
  isTarget: boolean;
}

/** The choices on a species (Mark as seen, Targets, Share): one set for the long press, VoiceOver and the page. */
export function useSpeciesActions() {
  const { t } = useTranslation();
  const app = useApp();
  const toast = useToast();
  const name = (s: Target) => s.commonName ?? s.scientificName;

  const toggleSeen = async (s: Target) => {
    const was = s.status === "seen";
    await changeMark(app, s.scientificName, { state: was ? null : "seen" });
    haptics.selection();
    toast.show(
      t(was ? "toast.seenRemoved" : "toast.seen", { name: name(s) }),
      () => void changeMark(app, s.scientificName, { state: was ? "seen" : null }),
    );
  };
  const toggleTarget = async (s: Target) => {
    await changeMark(app, s.scientificName, { isTarget: !s.isTarget });
    haptics.selection();
    toast.show(
      t(s.isTarget ? "toast.targetRemoved" : "toast.target", { name: name(s) }),
      () => void changeMark(app, s.scientificName, { isTarget: s.isTarget }),
    );
  };
  const share = (s: Target) => void Share.share({ message: name(s) });

  const actions = (s: Target): TapAction[] => [
    ...(s.status === "photographed"
      ? []
      : [
          {
            name: "seen",
            label: t(s.status === "seen" ? "species.unmarkSeen" : "species.markSeen"),
            onPress: () => void toggleSeen(s),
          },
        ]),
    {
      name: "target",
      label: t(s.isTarget ? "species.unmarkTarget" : "species.markTarget"),
      onPress: () => void toggleTarget(s),
    },
    { name: "share", label: t("common.share"), onPress: () => share(s) },
  ];
  const menu = (s: Target) =>
    showActions(
      name(s),
      t("common.cancel"),
      actions(s).map((a) => ({ label: a.label, onPress: a.onPress })),
    );
  return { toggleSeen, toggleTarget, share, actions, menu };
}

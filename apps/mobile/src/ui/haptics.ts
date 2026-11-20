// The only haptics Lifer makes (MR9): confirm a choice, confirm a queued photo. Nothing on scroll or navigation.
import * as Haptics from "expo-haptics";

const ignore = () => undefined;

export const haptics = {
  /** A status or target switched. */
  selection: () => void Haptics.selectionAsync().catch(ignore),
  /** One step of the Gallery grid size changed under a pinch. */
  step: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore),
  /** A photo was queued. */
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore),
};

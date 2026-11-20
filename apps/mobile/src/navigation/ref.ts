import { createNavigationContainerRef } from "@react-navigation/native";

/** For code outside the screens (the dev driver) that needs to move the app. */
export const navigationRef = createNavigationContainerRef();

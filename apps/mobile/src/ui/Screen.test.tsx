import { describe, expect, it } from "@jest/globals";
import { Platform, Text } from "react-native";
import { screen } from "@testing-library/react-native";
import { harness, renderApp } from "../testing/harness";
import { Screen } from "./Screen";

// react-native-screens only sizes a form sheet's scroll view when it is the screen's own root, so no wrapper may sit above it on iOS.
describe("Screen", () => {
  it("has no wrapper above its scroll view on iOS so form sheets keep their content while scrolling", async () => {
    const was = Platform.OS;
    Platform.OS = "ios";
    await renderApp(<Screen><Text>hello</Text></Screen>, await harness());
    Platform.OS = was;
    expect(screen.getByText("hello")).toBeOnTheScreen();
    const provider = screen.toJSON() as { children: { type: string }[] };
    expect(provider.children[0]).toMatchObject({ type: "RCTScrollView" });
  });
});

import { describe, expect, it } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { CroppedImage } from "./CroppedImage";

const image = () => screen.getByTestId("cropped-image");

describe("CroppedImage", () => {
  it("centres a photo that has no crop", async () => {
    await render(<CroppedImage uri="file:///a.jpg" crop={null} />);
    expect(image().props.contentFit).toBe("cover");
  });

  it("frames the saved crop once the photo's shape is known, hiding it until then", async () => {
    await render(<CroppedImage uri="file:///a.jpg" crop={{ x: 25, y: 10, size: 50 }} />);
    expect(StyleSheet.flatten(image().props.style).opacity).toBe(0);
    await fireEvent(image(), "load", { source: { width: 300, height: 200 } });
    expect(image().props.contentFit).toBe("fill");
    expect(StyleSheet.flatten(image().props.style)).toMatchObject({ position: "absolute", width: "200%", left: "-50%", top: "-20%" });
  });

  it("shows the photo's full height when the crop is taller than the photo, as the hub's square does", async () => {
    await render(<CroppedImage uri="file:///a.jpg" crop={{ x: 0, y: 0, size: 90 }} />);
    await fireEvent(image(), "load", { source: { width: 400, height: 100 } });
    expect(image().props.contentFit).toBe("fill");
    expect(StyleSheet.flatten(image().props.style)).toMatchObject({ width: "400%", height: "100%", left: "0%", top: "0%" });
  });
});

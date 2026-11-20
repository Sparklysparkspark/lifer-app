import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { fireEvent, screen } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { getMark } from "../store/marks";
import { harness, nav, renderApp, typeInSearch } from "../testing/harness";
import { seedLife } from "../testing/seed";
import { IdentifyScreen, verdictKey } from "./IdentifyScreen";
import { IdentifyResultSheet } from "./IdentifyResultSheet";

describe("IdentifyScreen", () => {
  it("explains the check, says plainly photo matching is not here yet, and offers a photo and a name", async () => {
    const h = await harness({ mode: "standalone" });
    await renderApp(<IdentifyScreen />, h);
    expect(await screen.findByText(/Is this a lifer\?/)).toBeOnTheScreen();
    expect(screen.getByText(/Photo matching on the phone is coming/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Choose photo" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Take photo" })).toBeOnTheScreen();
  });

  it("a typed name lists matches with their verdict, and opens the result", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<IdentifyScreen />, h);
    await screen.findByText(/Is this a lifer\?/);
    await typeInSearch("tundra");
    await fireEvent.press(await screen.findByRole("button", { name: /Tundra Swan, New for your life list/ }));
    expect(nav().navigate).toHaveBeenCalledWith("IdentifyResult", {
      photoUri: null,
      scientificName: "Cygnus columbianus",
    });
    expect(verdictKey({ status: "seen", photos: 0 })).toBe("identify.verdictSeen");
  });

  it("a name nothing matches", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<IdentifyScreen />, h);
    await screen.findByText(/Is this a lifer\?/);
    await typeInSearch("dragon");
    expect(await screen.findByText(/Nothing on this phone matches that name/)).toBeOnTheScreen();
  });

  it("shows the chosen photo and carries it into the result", async () => {
    jest
      .mocked(ImagePicker.launchImageLibraryAsync)
      .mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///x.jpg" }] } as never);
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(<IdentifyScreen />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Choose photo" }));
    expect(await screen.findByLabelText("The photo you chose")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Choose another photo" })).toBeOnTheScreen();
    await typeInSearch("mute");
    await fireEvent.press(await screen.findByRole("button", { name: /Mute Swan/ }));
    expect(nav().navigate).toHaveBeenCalledWith("IdentifyResult", {
      photoUri: "file:///x.jpg",
      scientificName: "Cygnus olor",
    });
  });

  it("a camera that cannot open says so calmly", async () => {
    jest.mocked(ImagePicker.launchCameraAsync).mockRejectedValueOnce(new Error("denied"));
    const h = await harness({ mode: "standalone" });
    await renderApp(<IdentifyScreen />, h);
    await fireEvent.press(await screen.findByRole("button", { name: "Take photo" }));
    expect(await screen.findByText(/camera isn't available/)).toBeOnTheScreen();
  });
});

describe("IdentifyResultSheet", () => {
  const sheet = (scientificName: string) => (
    <IdentifyResultSheet route={{ params: { photoUri: null, scientificName } }} />
  );

  it("a new species: says so in plain words, marks it seen only on a tap, and offers Undo", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("Cygnus columbianus"), h);
    expect(await screen.findByText("Tundra Swan")).toBeOnTheScreen();
    expect(screen.getByText("New for your life list")).toBeOnTheScreen();
    expect(await getMark(h.db, "Cygnus columbianus")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Mark as seen" }));
    expect(await screen.findByText("Tundra Swan marked as seen")).toBeOnTheScreen();
    expect((await getMark(h.db, "Cygnus columbianus"))?.state).toBe("seen");
    await fireEvent.press(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Tundra Swan marked as seen").catch(() => undefined);
    expect((await getMark(h.db, "Cygnus columbianus"))?.state).toBeNull();
  });

  it("a species you have photographed says how many photos, and has no Mark as seen", async () => {
    const h = await harness({ mode: "standalone", seed: seedLife });
    await renderApp(sheet("Cygnus olor"), h);
    expect(await screen.findByText("Already photographed")).toBeOnTheScreen();
    expect(screen.getByText("2 photos of it in your Gallery.")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Mark as seen" })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open species page" }));
  });
});

import { describe, expect, it, jest } from "@jest/globals";
import "@testing-library/react-native/matchers";
import { Alert } from "react-native";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCameraPermissions } from "expo-camera";
import type { CompanionPairingPayload } from "@lifer/shared";
import "../i18n";
import { PairError, type PairedHub } from "../connection/pair";
import { ConnectedScreen } from "./ConnectedScreen";
import { PairScreen, type Connect, type ConnectByCode } from "./PairScreen";

const render = (ui: ReactElement) =>
  rtlRender(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      {ui}
    </SafeAreaProvider>,
  );

jest.mock("expo-camera", () => ({ useCameraPermissions: jest.fn() }));
jest.mock("../pairing/QrScanner", () => {
  const { Pressable, Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    QrScanner: ({ onScan }: { onScan: (t: string) => void }) => (
      <>
        <Pressable testID="scan-good" onPress={() => onScan(mockGood)}>
          <Text>good</Text>
        </Pressable>
        <Pressable testID="scan-bad" onPress={() => onScan("https://example.com")}>
          <Text>bad</Text>
        </Pressable>
      </>
    ),
  };
});

const mockGood = JSON.stringify({
  v: 1,
  kind: "desktop",
  instanceId: "inst-1",
  addresses: ["192.168.1.5:7443"],
  certSha256: "a".repeat(64),
  code: "482913",
});
const perm = (p: object | null) => jest.mocked(useCameraPermissions).mockReturnValue([p, jest.fn()] as never);
const granted = { granted: true, canAskAgain: true };

describe("PairScreen", () => {
  it("asks for the camera with a reason before scanning", async () => {
    perm({ granted: false, canAskAgain: true });
    await render(<PairScreen connect={jest.fn<Connect>()} connectByCode={jest.fn<ConnectByCode>()} />);
    expect(screen.getByText(/uses the camera only to read the pairing code/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Allow camera" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Type the code instead" })).toBeOnTheScreen();
  });

  it("points to Settings when the camera is refused, and typing still works", async () => {
    perm({ granted: false, canAskAgain: false });
    await render(<PairScreen connect={jest.fn<Connect>()} connectByCode={jest.fn<ConnectByCode>()} />);
    expect(screen.getByText(/Camera access is off/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Type the code instead" }));
    expect(screen.getByLabelText("Code")).toBeOnTheScreen();
  });

  it("connects with the scanned payload", async () => {
    perm(granted);
    const connect = jest.fn<Connect>().mockResolvedValue(undefined);
    await render(<PairScreen connect={connect} connectByCode={jest.fn<ConnectByCode>()} />);
    await fireEvent.press(screen.getByTestId("scan-good"));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect((connect.mock.calls[0][0] as CompanionPairingPayload).code).toBe("482913");
  });

  it("shows a progress state while connecting", async () => {
    perm(granted);
    await render(<PairScreen connect={() => new Promise(() => {})} connectByCode={jest.fn<ConnectByCode>()} />);
    await fireEvent.press(screen.getByTestId("scan-good"));
    await waitFor(() => expect(screen.getAllByText("Connecting").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("scan-good")).toBeNull();
  });

  it.each([
    ["unreachable", /same Wi-Fi/],
    ["code_invalid", /code didn't work/],
    ["not_found", /Couldn't find Lifer on this Wi-Fi/],
    ["wrong_hub", /isn't the Lifer you scanned/],
    ["cert_mismatch", /certificate changed/],
    ["rate_limited", /Too many tries/],
  ] as const)("says plainly what went wrong: %s", async (code, text) => {
    perm(granted);
    const connect = jest.fn<Connect>().mockRejectedValue(new PairError(code));
    await render(<PairScreen connect={connect} connectByCode={jest.fn<ConnectByCode>()} />);
    await fireEvent.press(screen.getByTestId("scan-good"));
    expect(await screen.findByText(text)).toBeOnTheScreen();
    // The camera is off until the person chooses to try again, so one QR is not retried in a loop.
    expect(screen.queryByTestId("scan-good")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByTestId("scan-good")).toBeOnTheScreen();
  });

  it("explains an unknown failure and a QR code that is not Lifer's", async () => {
    perm(granted);
    const connect = jest.fn<Connect>().mockRejectedValue(new Error("boom"));
    await render(<PairScreen connect={connect} connectByCode={jest.fn<ConnectByCode>()} />);
    await fireEvent.press(screen.getByTestId("scan-bad"));
    expect(await screen.findByText("That isn't a Lifer code.")).toBeOnTheScreen();
    expect(connect).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await fireEvent.press(screen.getByTestId("scan-good"));
    expect(await screen.findByText(/Something went wrong/)).toBeOnTheScreen();
  });

  it("pairs with a computer from the 6 digits alone", async () => {
    perm(granted);
    const connect = jest.fn<Connect>();
    const connectByCode = jest.fn<ConnectByCode>().mockResolvedValue(undefined);
    await render(<PairScreen connect={connect} connectByCode={connectByCode} />);
    await fireEvent.press(screen.getByRole("button", { name: "Type the code instead" }));
    // Only the code: no address, key or fingerprint to type.
    expect(screen.queryByLabelText("Server address")).toBeNull();
    expect(screen.queryByLabelText("Fingerprint")).toBeNull();
    expect(screen.getByLabelText("Code").props.keyboardType).toBe("number-pad");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Enter the 6 digits shown under the code on your computer.")).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText("Code"), "482 913");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connectByCode).toHaveBeenCalledWith("482913"));
    expect(connect).not.toHaveBeenCalled();
  });

  it("a server takes one address field with the digits", async () => {
    perm(granted);
    const connect = jest.fn<Connect>().mockResolvedValue(undefined);
    const connectByCode = jest.fn<ConnectByCode>();
    await render(<PairScreen connect={connect} connectByCode={connectByCode} />);
    await fireEvent.press(screen.getByRole("button", { name: "Type the code instead" }));
    await fireEvent.press(screen.getByRole("button", { name: "Connecting to a Lifer server instead?" }));
    await fireEvent.changeText(screen.getByLabelText("Server address"), "lifer.example.com");
    await fireEvent.changeText(screen.getByLabelText("Code"), "482913");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0][0]).toMatchObject({
      kind: "server",
      code: "482913",
      addresses: ["https://lifer.example.com"],
    });
    expect(connectByCode).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Connect to my computer instead" }));
    expect(screen.queryByLabelText("Server address")).toBeNull();
  });

  it("keeps a way forward and back after a failure", async () => {
    perm(granted);
    const connectByCode = jest.fn<ConnectByCode>().mockRejectedValue(new PairError("not_found"));
    await render(<PairScreen connect={jest.fn<Connect>()} connectByCode={connectByCode} />);
    await fireEvent.press(screen.getByRole("button", { name: "Type the code instead" }));
    await fireEvent.changeText(screen.getByLabelText("Code"), "482913");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Couldn't find Lifer/)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Connect" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Scan the code instead" })).toBeOnTheScreen();
  });
});

describe("ConnectedScreen", () => {
  const paired: PairedHub = {
    token: "t",
    hub: {
      kind: "desktop",
      instanceId: "i",
      baseUrl: "https://192.168.1.5:7443",
      fallbackUrls: [],
      deviceId: "d",
      scopes: [],
    },
  };
  it("names the hub and asks before disconnecting", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const onForget = jest.fn();
    await render(<ConnectedScreen paired={paired} onForget={onForget} />);
    expect(screen.getByText("Connected to your computer")).toBeOnTheScreen();
    expect(screen.getByText("Reached at 192.168.1.5:7443")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Disconnect this phone" }));
    const buttons = alert.mock.calls[0][2]!;
    expect(onForget).not.toHaveBeenCalled();
    buttons.find((b) => b.style === "destructive")!.onPress!();
    expect(onForget).toHaveBeenCalled();
  });
});

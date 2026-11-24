import { describe, expect, it, jest } from "@jest/globals";
import { act, waitFor } from "@testing-library/react-native";
import { harness, renderApp } from "../testing/harness";
import { useApp, type App } from "./AppContext";

describe("AppProvider", () => {
  it("lets a running sync finish before disconnecting from its hub", async () => {
    const h = await harness({ paired: true, mode: "paired" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hubCalls = 0;
    h.boot.transport = async () => {
      if (hubCalls++ === 0) await gate;
      throw new Error("unreachable");
    };
    const forgetHub = jest.fn(async () => undefined);
    h.boot.forgetHub = forgetHub;
    let app!: App;
    const Probe = () => {
      app = useApp();
      return null;
    };
    await renderApp(<Probe />, h);
    let syncing!: Promise<void>;
    let leaving!: Promise<void>;
    await act(async () => {
      syncing = app.sync.run();
      leaving = app.disconnect();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(forgetHub).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await syncing;
      await leaving;
    });
    expect(forgetHub).toHaveBeenCalled();
    await waitFor(() => expect(app.mode).toBe("standalone"));
  });
});

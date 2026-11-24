// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import ImportSpaceNotice from "./ImportSpaceNotice";

afterEach(cleanup);

const GB = 1e9;
const none = async () => {};

describe("ImportSpaceNotice", () => {
  it("says nothing with room, or before the first check", () => {
    const { container, rerender } = render(<ImportSpaceNotice space={null} paused={null} onContinue={none} />);
    expect(container.textContent).toBe("");
    rerender(<ImportSpaceNotice space={{ tier: "ok", free: 400 * GB, toFree: 0 }} paused={null} onContinue={none} />);
    expect(container.textContent).toBe("");
  });

  it("a calm line while the disk is tight, with no button", () => {
    render(<ImportSpaceNotice space={{ tier: "tight", free: 20 * GB, toFree: 0 }} paused={null} onContinue={none} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Your disk is nearly full, so Lifer will match photos in smaller batches and keep fewer temporary files. Free some space to speed this up.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a paused import says how far it got and how much to free", () => {
    render(
      <ImportSpaceNotice
        space={{ tier: "critical", free: 2.1 * GB, toFree: 6 * GB }}
        paused={{ imported: 31, total: 50 }}
        onContinue={none}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Lifer paused the import with 2.1 GB free so your library isn't harmed. 31 of 50 photos were imported; the rest are still where they were. Free at least 6 GB and press Continue.",
    );
  });

  it("too full to start says so without counts", () => {
    render(
      <ImportSpaceNotice
        space={{ tier: "critical", free: 2.1 * GB, toFree: 0.9 * GB }}
        paused={null}
        onContinue={none}
      />,
    );
    // Never asks to free less than 1 GB.
    expect(screen.getByRole("alert").textContent).toContain(
      "Your disk is too full to import with 2.1 GB free. Free at least 1 GB and press Continue.",
    );
  });

  it("Continue checks again, busy until it answers", async () => {
    let finish!: () => void;
    const onContinue = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(
      <ImportSpaceNotice
        space={{ tier: "critical", free: 2 * GB, toFree: 2 * GB }}
        paused={{ imported: 1, total: 2 }}
        onContinue={onContinue}
      />,
    );
    const button = screen.getByRole("button", { name: /Continue/ });
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    expect(screen.getByRole("button", { name: /Continue/ }).hasAttribute("disabled")).toBe(false);
  });
});

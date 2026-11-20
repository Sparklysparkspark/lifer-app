// @vitest-environment jsdom
// Every toast lines up its mark, text, actions and close X on one centre line.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToastViewport } from "./Toast";

afterEach(cleanup);

describe("ToastViewport", () => {
  it("centres the mark, a long message, its actions and the close button on one line", () => {
    render(
      <ToastViewport
        toasts={[
          {
            id: 1,
            tone: "success",
            message: "Sent 1 observation to iNaturalist. A second line of text so the message wraps.",
            actions: [{ label: "Undo", onClick: () => {} }],
          },
        ]}
        onDismiss={() => {}}
      />,
    );
    const message = screen.getByText(/Sent 1 observation/);
    const row = message.closest("[role=status]")!.parentElement!;
    expect(row.className).toContain("items-center");
    expect(message.closest("[role=status]")!.className).toContain("items-center");
    // The mark and the action share the close button's 24px box, so their centres match.
    expect(screen.getByText("✓").className).toContain("h-6");
    expect(screen.getByRole("button", { name: "Undo" }).className).toContain("h-6");
    expect(screen.getByRole("button", { name: "Dismiss" }).className).toContain("h-6");
  });
});

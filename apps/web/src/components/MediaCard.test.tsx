// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MediaCard, { CARD_SELECTED, PhotoMosaic, SelectedRing, Thumb } from "./MediaCard";

afterEach(cleanup);

function renderCard(props: Partial<React.ComponentProps<typeof MediaCard>> = {}) {
  return render(
    <MediaCard
      media={<img alt="Flicker" />}
      title="Northern Flicker"
      lines={["Oct 12", null, "", "Burnaby"]}
      renderBody={(p) => <a href="/x" {...p} />}
      actions={<button type="button">More</button>}
      {...props}
    />,
  );
}

describe("MediaCard", () => {
  it("shows the title and only the non-empty lines inside the body", () => {
    renderCard();
    const link = screen.getByRole("link");
    expect(link.textContent).toBe("Northern FlickerOct 12Burnaby");
  });

  it("keeps overlay actions outside the body, so a button is never nested in a link", () => {
    renderCard();
    expect(screen.getByRole("link").contains(screen.getByRole("button", { name: "More" }))).toBe(false);
  });

  it("draws the accent ring and the select tick only when asked", () => {
    const { rerender } = renderCard();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("link").className).not.toContain(CARD_SELECTED);
    rerender(
      <MediaCard media={null} title="x" selected markLabel="Select" renderBody={(p) => <a href="/x" {...p} />} />,
    );
    expect(screen.getByRole("link").className).toContain(CARD_SELECTED);
    expect((screen.getByRole("checkbox", { name: "Select" }) as HTMLInputElement).checked).toBe(true);
  });

  it("rounds every corner of the media when there is no text", () => {
    renderCard({ title: undefined });
    const media = screen.getByRole("img").parentElement!;
    expect(media.className).toContain("rounded-[calc(var(--radius-panel)-1px)]");
    expect(screen.getByRole("link").querySelectorAll("p")).toHaveLength(0);
  });
});

describe("MediaCard slots", () => {
  it("pins the footer to the bottom of the text block, after the lines", () => {
    renderCard({ footer: <span>Ready to send</span> });
    const footer = screen.getByText("Ready to send").parentElement!;
    expect(footer.className).toContain("mt-auto");
    expect(footer.previousElementSibling?.textContent).toBe("Burnaby");
  });

  it("reserves two title lines only when asked", () => {
    const { rerender } = renderCard();
    expect(screen.getByText("Northern Flicker").className).not.toContain("min-h-[2lh]");
    rerender(<MediaCard media={null} title="Northern Flicker" titleLines={2} renderBody={(p) => <a {...p} />} />);
    expect(screen.getByText("Northern Flicker").className).toContain("min-h-[2lh]");
  });
});

describe("Thumb", () => {
  it("shows a picture from elsewhere when there's no library photo, and the library photo first", () => {
    const { container, rerender } = render(<Thumb photoId={null} src="https://example.org/p.jpg" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.org/p.jpg");
    rerender(<Thumb photoId="p1" src="https://example.org/p.jpg" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/photos/p1/thumb");
  });
});

describe("PhotoMosaic", () => {
  it("shows three photos and counts the rest", () => {
    const photos = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, photoId: null }));
    const { container } = render(<PhotoMosaic photos={photos} />);
    expect(container.firstElementChild!.children).toHaveLength(3);
    expect(container.textContent).toContain("2");
  });
});

describe("SelectedRing", () => {
  it("follows a tile's own corner radius", () => {
    const { container } = render(<SelectedRing radiusPx={0} />);
    expect((container.firstElementChild as HTMLElement).style.borderRadius).toBe("0px");
  });
});

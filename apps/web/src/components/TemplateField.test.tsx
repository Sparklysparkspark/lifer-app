// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TemplateField from "./TemplateField";

const groups = [
  { label: "Taxonomy", tokens: ["species", "scientific"] },
  { label: "Capture", tokens: ["longdate"] },
];
const names: Record<string, string> = { species: "Common name", scientific: "Scientific name", longdate: "Long date" };
const onChange = vi.fn();

function Harness({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return (
    <TemplateField
      value={value}
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
      groups={groups}
      tokenLabel={(t) => names[t] ?? t}
      label="Caption"
    />
  );
}

const boxes = () => screen.getAllByRole("textbox", { name: "Caption" }) as HTMLTextAreaElement[];
const last = () => onChange.mock.calls.at(-1)?.[0];

afterEach(() => {
  cleanup();
  onChange.mockClear();
});

describe("TemplateField", () => {
  it("draws known tokens as chips and leaves unknown ones as text", () => {
    render(<Harness start="An {species} [[ on {longdate}]] {bogus}" />);
    expect(screen.getByRole("button", { name: /^Common name/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Long date/ })).toBeTruthy();
    expect(boxes().map((b) => b.value)).toEqual(["An ", " [[ on ", "]] {bogus}"]);
  });

  it("turns a token typed out in full into a chip", () => {
    render(<Harness start="" />);
    fireEvent.change(boxes()[0], { target: { value: "Seen: {species}" } });
    expect(last()).toBe("Seen: {species}");
    expect(screen.getByRole("button", { name: /^Common name/ })).toBeTruthy();
  });

  it("inserts from the Insert menu at the caret, and a typed { opens the same menu", () => {
    render(<Harness start="ab" />);
    const box = boxes()[0];
    box.focus();
    box.setSelectionRange(1, 1);
    fireEvent.select(box);
    fireEvent.keyDown(box, { key: "{" });
    expect(screen.getByRole("group", { name: "Taxonomy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Scientific name" }));
    expect(last()).toBe("a{scientific}b");
  });

  it("removes a chip with Backspace from the text after it, Delete from the text before it, and on the chip", () => {
    const { unmount } = render(<Harness start="a{species}b" />);
    const after = boxes()[1];
    after.setSelectionRange(0, 0);
    fireEvent.keyDown(after, { key: "Backspace" });
    expect(last()).toBe("ab");
    unmount();

    render(<Harness start="a{species}b" />);
    const before = boxes()[0];
    before.setSelectionRange(1, 1);
    fireEvent.keyDown(before, { key: "Delete" });
    expect(last()).toBe("ab");
    cleanup();

    render(<Harness start="a{species}b" />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Common name/ }), { key: "Delete" });
    expect(last()).toBe("ab");
  });

  it("moves between text and chips with the arrow keys", () => {
    render(<Harness start="a{species}b" />);
    const [first, second] = boxes();
    first.focus();
    first.setSelectionRange(1, 1);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const chip = screen.getByRole("button", { name: /^Common name/ });
    expect(document.activeElement).toBe(chip);
    fireEvent.keyDown(chip, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    second.setSelectionRange(0, 0);
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(chip);
  });

  it("keeps a long template with many chips editable", () => {
    const many = Array.from({ length: 30 }, () => "{species}").join(", ");
    render(<Harness start={many} />);
    expect(screen.getAllByRole("button", { name: /^Common name/ })).toHaveLength(30);
  });
});

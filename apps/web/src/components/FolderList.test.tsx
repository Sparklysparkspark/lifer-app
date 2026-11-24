// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FolderList from "./FolderList";

afterEach(cleanup);

const folders = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/Volumes/Photos/Trip ${i}` }));

describe("FolderList", () => {
  it("filters a long list and says when nothing matches", () => {
    render(<FolderList label="Watched folders" folders={folders(30)} />);
    const filter = screen.getByLabelText("Filter Watched folders");
    fireEvent.change(filter, { target: { value: "trip 12" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "nowhere" } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No folders match")).toBeTruthy();
  });

  it("has no filter for a short list, and ends each row in the page's own control", () => {
    const onRemove = vi.fn();
    render(
      <FolderList
        label="Watched folders"
        folders={[{ path: "/a/Birds", note: "Inside /a" }]}
        onRemove={onRemove}
        renderControl={(f) => <span>menu for {f.path}</span>}
      />,
    );
    expect(screen.queryByLabelText("Filter Watched folders")).toBeNull();
    expect(screen.getByText("menu for /a/Birds")).toBeTruthy();
    expect(screen.getByText("Inside /a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onRemove).toHaveBeenCalledWith("/a/Birds");
  });
});

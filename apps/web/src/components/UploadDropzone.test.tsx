// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const enqueueUploads = vi.fn();
vi.mock("../lib/uploadQueue", () => ({ enqueueUploads: (...a: unknown[]) => enqueueUploads(...a) }));
const { default: UploadDropzone } = await import("./UploadDropzone");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UploadDropzone", () => {
  it("takes dropped photos and videos, leaving other files out", () => {
    const onClose = vi.fn();
    render(<UploadDropzone speciesId="s1" volumeId="" onUploaded={() => {}} onClose={onClose} />);
    const files = [
      new File(["x"], "heron.jpg", { type: "image/jpeg" }),
      new File(["x"], "clip.mov", { type: "video/quicktime" }),
      new File(["x"], "notes.txt", { type: "text/plain" }),
    ];
    fireEvent.drop(screen.getByText("Choose photos or videos").parentElement!, { dataTransfer: { files } });
    expect(enqueueUploads).toHaveBeenCalledOnce();
    expect((enqueueUploads.mock.calls[0][1] as File[]).map((f) => f.name)).toEqual(["heron.jpg", "clip.mov"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("is reachable by keyboard through its Choose buttons", () => {
    render(<UploadDropzone speciesId="s1" volumeId="" onUploaded={() => {}} />);
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
  });
});

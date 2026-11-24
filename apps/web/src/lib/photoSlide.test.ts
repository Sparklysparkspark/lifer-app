import { describe, expect, it } from "vitest";
import { photoSlide } from "./photoSlide";

describe("photoSlide", () => {
  it("always carries the thumbnail, so the viewer never opens on a black frame", () => {
    const slide = photoSlide({ photoId: "p1", width: 600, height: 400 });
    expect(slide).toMatchObject({ url: "/api/photos/p1/display", thumbUrl: "/api/photos/p1/thumb", width: 600 });
    expect(slide.videoUrl).toBeNull();
  });

  it("plays videos and recordings and lists each stored file once", () => {
    const video = photoSlide({ photoId: "v", kind: "video", originalRef: "/a/v.mov", rawRef: "/a/v.mov" });
    expect(video.videoUrl).toBe("/api/photos/v/video");
    expect(video.info?.files).toEqual(["/a/v.mov"]);
    expect(photoSlide({ photoId: "r", kind: "audio" }).audioUrl).toBe("/api/photos/r/audio");
  });

  it("lets the page add its caption and handlers over the defaults", () => {
    const onRate = () => {};
    const slide = photoSlide({ photoId: "p", captureId: "c" }, { caption: "Osprey", rating: 4, onRate });
    expect(slide).toMatchObject({ captureId: "c", caption: "Osprey", rating: 4, onRate });
  });
});

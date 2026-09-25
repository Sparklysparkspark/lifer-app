import { describe, expect, it } from "vitest";
import { parseFfmpegDescription } from "./image.js";

// Real `ffmpeg -hide_banner -i` output for a Canon 4K clip.
const canonMp4 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'DM8A6874.mp4':
  Metadata:
    major_brand     : mp42
  Duration: 00:01:38.20, start: 0.000000, bitrate: 121490 kb/s
  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuvj420p(pc, bt709, progressive), 3840x2160, 121158 kb/s, 29.97 fps
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 253 kb/s (default)
At least one output file must be specified`;

const iphoneHevc = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Duration: 00:00:12.50, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 29.97 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo`;

describe("parseFfmpegDescription", () => {
  it("reads duration and treats H.264/AAC in MP4 as playable everywhere", () => {
    expect(parseFfmpegDescription(canonMp4)).toEqual({ durationSeconds: 98.2, isWebSafe: true });
  });
  it("flags HEVC for a playable copy", () => {
    expect(parseFfmpegDescription(iphoneHevc)).toEqual({ durationSeconds: 12.5, isWebSafe: false });
  });
  it("fails on something that isn't a video", () => {
    expect(() => parseFfmpegDescription("notes.txt: Invalid data found when processing input")).toThrow();
  });
});

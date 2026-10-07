import { describe, expect, it } from "vitest";
import { isInsecurePublicUrl, isPrivateHost } from "./privateHost";

describe("isPrivateHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.10.10",
    "100.64.0.1",
    "100.127.255.255",
    "[::1]",
    "fd12:3456::1",
    "fc00::1",
    "fe80::1",
    "nas",
    "lifer.local",
    "lifer.lan",
    "box.home.arpa",
    "svc.internal",
  ])("treats %s as private", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    "lifer.example.com",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "2001:db8::1",
  ])("treats %s as public", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe("isInsecurePublicUrl", () => {
  it("flags plain http to a public host", () => {
    expect(isInsecurePublicUrl("http://lifer.example.com")).toBe(true);
  });

  it("allows https and private http", () => {
    expect(isInsecurePublicUrl("https://lifer.example.com")).toBe(false);
    expect(isInsecurePublicUrl("http://192.168.1.10:4310")).toBe(false);
  });

  it("ignores empty or unparseable input", () => {
    expect(isInsecurePublicUrl("")).toBe(false);
    expect(isInsecurePublicUrl("lifer.example.com")).toBe(false);
  });
});

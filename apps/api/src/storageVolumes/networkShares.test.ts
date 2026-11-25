import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const settings = { getInstallSetting: vi.fn(), setInstallSetting: vi.fn() };
const execFile = vi.fn();

async function load() {
  vi.resetModules();
  vi.doMock("@lifer/core/db.js", () => ({ pool: { query } }));
  vi.doMock("../lib/installSettings.js", () => settings);
  vi.doMock("node:child_process", () => ({ execFile }));
  return import("./networkShares.js");
}

// Callback-style, as promisify(execFile) calls it.
function execReturns(byCommand: Record<string, string>) {
  execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    const out = byCommand[cmd];
    if (out === undefined) cb(new Error(`no ${cmd}`));
    else cb(null, { stdout: out, stderr: "" });
  });
}

const MAC_MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk5s1 on /Volumes/Photos SSD (apfs, local, nodev, nosuid, journaled, noowners)
//jstarkey@truenas.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by jstarkey)
//jstarkey@truenas.local/home on /Volumes/home-1 (smbfs, nodev, nosuid, mounted by jstarkey)
//guest@nas._afpovertcp._tcp.local/Old%20Photos on /Volumes/Old Photos (afpfs, nodev, nosuid, mounted by jstarkey)
truenas:/mnt/tank/photos on /Volumes/photos (nfs, nodev, nosuid, mounted by jstarkey)
`;

const LINUX_MOUNTS = `/dev/nvme0n1p2 / ext4 rw,relatime 0 0
//truenas/home /mnt/home cifs rw,relatime,vers=3.1.1 0 0
truenas:/mnt/tank /mnt/My\\040Photos nfs4 rw,relatime 0 0
gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw,nosuid 0 0
`;

const NET_USE = `New connections will be remembered.


Status       Local     Remote                    Network

-------------------------------------------------------------------------------
OK           Z:        \\\\truenas\\home            Microsoft Windows Network
Unavailable  Y:        \\\\truenas\\media           Microsoft Windows Network
OK                     \\\\truenas\\plex-media      Microsoft Windows Network
The command completed successfully.
`;

beforeEach(() => {
  query.mockReset();
  execFile.mockReset();
  settings.getInstallSetting.mockReset().mockResolvedValue(null);
  settings.setInstallSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.doUnmock("@lifer/core/db.js");
  vi.doUnmock("../lib/installSettings.js");
  vi.doUnmock("node:child_process");
});

describe("mount table parsers", () => {
  it("reads macOS mount output, network shares with their address and local disks without", async () => {
    const { parseMacMount } = await load();
    const entries = parseMacMount(MAC_MOUNT);
    expect(entries).toContainEqual({ mountPath: "/Volumes/Photos SSD", url: null, mounted: true });
    expect(entries).toContainEqual({
      mountPath: "/Volumes/media",
      url: "smb://jstarkey@truenas.local/media",
      mounted: true,
    });
    expect(entries).toContainEqual({
      mountPath: "/Volumes/Old Photos",
      url: "afp://guest@nas._afpovertcp._tcp.local/Old%20Photos",
      mounted: true,
    });
    expect(entries).toContainEqual({
      mountPath: "/Volumes/photos",
      url: "nfs://truenas/mnt/tank/photos",
      mounted: true,
    });
  });

  it("reads Linux /proc/mounts, unescaping spaces", async () => {
    const { parseLinuxMounts } = await load();
    const entries = parseLinuxMounts(LINUX_MOUNTS);
    expect(entries).toContainEqual({ mountPath: "/mnt/home", url: "smb://truenas/home", mounted: true });
    expect(entries).toContainEqual({ mountPath: "/mnt/My Photos", url: "nfs://truenas/mnt/tank", mounted: true });
    expect(entries.find((e) => e.mountPath === "/")?.url).toBeNull();
  });

  it("reads a GNOME gio mount folder name", async () => {
    const { gvfsShareUrl } = await load();
    expect(gvfsShareUrl("smb-share:server=truenas.local,share=home,user=judah")).toBe("smb://judah@truenas.local/home");
    expect(gvfsShareUrl("sftp:host=truenas")).toBeNull();
  });

  it("reads Windows net use: mapped drives, a disconnected one, and a connection without a letter", async () => {
    const { parseWindowsNetUse } = await load();
    expect(parseWindowsNetUse(NET_USE)).toEqual([
      { mountPath: "Z:", url: "smb://truenas/home", mounted: true },
      { mountPath: "Y:", url: "smb://truenas/media", mounted: false },
      { mountPath: "\\\\truenas\\plex-media", url: "smb://truenas/plex-media", mounted: true },
    ]);
  });

  it("never keeps a password from a mount source", async () => {
    const { parseLinuxMounts } = await load();
    const [entry] = parseLinuxMounts("//judah:secret@truenas/home /mnt/home cifs rw 0 0");
    expect(entry.url).toBe("smb://judah@truenas/home");
  });
});

describe("share addresses Lifer will hand to the OS", () => {
  it("accepts plain share addresses and refuses anything that could break out of a command", async () => {
    const { isValidShareUrl } = await load();
    expect(isValidShareUrl("smb://jstarkey@truenas.local/home")).toBe(true);
    expect(isValidShareUrl("nfs://truenas/mnt/tank/photos")).toBe(true);
    for (const bad of [
      'smb://truenas/home" & do shell script "rm',
      "smb://truenas/home with space",
      "http://truenas/home",
      "smb://truenas",
      "smb://user:pw@truenas/home",
      "smb://truenas/a\\b",
    ])
      expect(isValidShareUrl(bad)).toBe(false);
  });

  it("builds each OS's mount command with the address as a single argument", async () => {
    const { connectCommand } = await load();
    expect(connectCommand("smb://u@truenas.local/home", "/Volumes/home", "darwin")).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", 'mount volume "smb://u@truenas.local/home"'],
    });
    expect(connectCommand("smb://truenas/home", "/mnt/home", "linux")).toEqual({
      command: "gio",
      args: ["mount", "smb://truenas/home"],
    });
    expect(connectCommand("smb://truenas/home", "Z:", "win32")).toEqual({
      command: "net",
      args: ["use", "Z:", "\\\\truenas\\home"],
    });
    expect(() => connectCommand('smb://x/y"', "/Volumes/y", "darwin")).toThrow();
  });
});

describe("connectShare", () => {
  it("only connects a remembered share that holds this user's library, never a requested address", async () => {
    settings.getInstallSetting.mockResolvedValue({ "/Volumes/home": { url: "smb://jstarkey@truenas.local/home" } });
    execReturns({ "/sbin/mount": MAC_MOUNT, net: NET_USE, "/usr/bin/osascript": "" });
    query.mockResolvedValue({ rows: [] });
    const { connectShare } = await load();
    expect(await connectShare("u1", "/Volumes/home")).toBeNull();
    expect(await connectShare("u1", "/Volumes/somewhere-else")).toBeNull();
    expect(execFile.mock.calls.some(([cmd]) => cmd === "/usr/bin/osascript")).toBe(false);
  });

  it.runIf(process.platform === "darwin")("asks the OS to mount it, then reports where it landed", async () => {
    settings.getInstallSetting.mockResolvedValue({ "/Volumes/home": { url: "smb://jstarkey@truenas.local/home" } });
    execReturns({ "/sbin/mount": MAC_MOUNT, "/usr/bin/osascript": "" });
    query.mockResolvedValue({ rows: [{ root: "/Volumes/home" }] });
    const { connectShare } = await load();
    const location = await connectShare("u1", "/Volumes/home");
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-e", 'mount volume "smb://jstarkey@truenas.local/home"'],
      expect.anything(),
      expect.any(Function),
    );
    expect(location).toMatchObject({ mountPath: "/Volumes/home", name: "home", mountedAt: "/Volumes/home-1" });
  });
});

describe("checkFile", () => {
  it("answers not responding instead of waiting on a hung share, then skips it for a while", async () => {
    const { checkFile } = await load();
    const hung = vi.fn(() => new Promise(() => {}));
    // Many files on one dead share at once still touch the share only once.
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((f) => checkFile(`/Volumes/home/${f}.jpg`, hung, 20)),
    );
    expect(results.every((r) => r === "not_responding")).toBe(true);
    expect(await checkFile("/Volumes/home/g.jpg", hung, 20)).toBe("not_responding");
    expect(hung).toHaveBeenCalledTimes(1);
    expect(hung).toHaveBeenCalledWith("/Volumes/home");
    expect(await checkFile("/Volumes/media/a.jpg", () => Promise.resolve(), 20)).toBe("ok");
    const gone = (p: string) => (p === "/Volumes/media" ? Promise.resolve() : Promise.reject(new Error("ENOENT")));
    expect(await checkFile("/Volumes/media/b.jpg", gone, 20)).toBe("missing");
  });
});

describe.runIf(process.platform === "darwin")("remembering shares (macOS)", () => {
  it("remembers each network share it sees and finds a share mounted under a new name", async () => {
    settings.getInstallSetting.mockResolvedValue({ "/Volumes/home": { url: "smb://jstarkey@truenas.local/home" } });
    execReturns({ "/sbin/mount": MAC_MOUNT });
    const { initNetworkShares, remapToMountedShare, unmountedShareOf } = await load();
    await initNetworkShares();
    const saved = settings.setInstallSetting.mock.calls[0][2];
    expect(saved["/Volumes/media"]).toEqual({ url: "smb://jstarkey@truenas.local/media" });
    expect(saved["/Volumes/home"]).toEqual({ url: "smb://jstarkey@truenas.local/home" });
    expect(JSON.stringify(saved)).not.toContain("Photos SSD");
    expect(remapToMountedShare("/Volumes/home/Birds/heron.jpg")).toBe("/Volumes/home-1/Birds/heron.jpg");
    expect(remapToMountedShare("/Volumes/media/heron.jpg")).toBe("/Volumes/media/heron.jpg");
    expect(await unmountedShareOf("/Volumes/plex/a.jpg")).toEqual({ name: "plex", sharePath: null });
    expect(await unmountedShareOf("/Volumes/media/a.jpg")).toBeNull();
  });
});

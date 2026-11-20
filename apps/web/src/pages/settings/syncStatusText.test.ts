import { describe, expect, it } from "vitest";
import { idleJobStatus } from "@lifer/shared";
import {
  describeLibraryPush,
  describeMirror,
  describePush,
  describeReason,
  describeWaiting,
  type SyncStatus,
} from "./syncStatusText";

const pushResult = { pushed: 0, uploaded: 0, failed: 0, unknownSpecies: 0, conflicts: 0, userSpecies: 0, library: 0 };
const base: SyncStatus = {
  linked: true,
  serverUrl: "http://nas:4000",
  unpushed: 0,
  waiting: { photos: 0, albums: 0, trips: 0 },
  serverChanged: false,
  derivative: "thumb",
  packs: idleJobStatus(),
  mirror: idleJobStatus<NonNullable<SyncStatus["mirror"]["result"]>>(),
  push: idleJobStatus<NonNullable<SyncStatus["push"]["result"]>>(),
};
const waiting = (photos: number, albums = 0, trips = 0): SyncStatus => ({
  ...base,
  unpushed: photos + albums + trips,
  waiting: { photos, albums, trips },
});

describe("what is waiting", () => {
  it("says up to date, or counts the changes, one and 120,000", () => {
    expect(describeWaiting(0)).toBe("Up to date");
    expect(describeWaiting(1)).toBe("1 change waiting to sync");
    expect(describeWaiting(120000)).toBe("120,000 changes waiting to sync");
  });

  it("gives a plain reason only while something waits", () => {
    expect(describeReason(base)).toBeNull();
    expect(describeReason(waiting(2))).toMatch(/^It sends when the app connects/);
    expect(describeReason({ ...waiting(2), push: { ...base.push, running: true } })).toBe("Sending now.");
    expect(describeReason({ ...waiting(2), serverChanged: true })).toBe("Waiting for your answer below.");
    expect(describeReason({ ...waiting(2), push: { ...base.push, error: "The server refused it (500)" } })).toBe(
      "The last send stopped: The server refused it (500)",
    );
  });
});

describe("what the last send of photos did", () => {
  it("covers never sent, running, sent, conflicts and a stop", () => {
    expect(describePush(base)).toBe("Nothing sent yet.");
    expect(describePush({ ...base, push: { ...base.push, running: true, processed: 3, total: 9 } })).toBe(
      "Sending to the server: 3 of 9.",
    );
    const done = (over: Partial<typeof pushResult>) => ({
      ...base,
      push: { ...base.push, finishedAt: 1, result: { ...pushResult, ...over } },
    });
    expect(describePush(done({ uploaded: 2, pushed: 1 }))).toMatch(/2 uploaded, 1 updated, 0 failed\.$/);
    expect(describePush(done({ conflicts: 2 }))).toMatch(
      /0 failed\. 2 also changed on the server since this computer last synced, so the server's versions were kept\.$/,
    );
    expect(
      describePush({
        ...base,
        push: { ...base.push, finishedAt: 1, error: "The server refused 2 species marks (500)" },
      }),
    ).toMatch(/^Last send stopped .*: The server refused 2 species marks \(500\)$/);
  });
});

describe("albums and trips, and the copy from the server", () => {
  it("says what the last send and copy brought", () => {
    expect(describeLibraryPush(base)).toBe("Nothing sent yet.");
    expect(
      describeLibraryPush({ ...base, push: { ...base.push, finishedAt: 1, result: { ...pushResult, library: 1 } } }),
    ).toMatch(/: 1 album, trip or album photo\.$/);
    expect(
      describeLibraryPush({ ...base, push: { ...base.push, finishedAt: 1, result: { ...pushResult, library: 40 } } }),
    ).toMatch(/: 40 albums, trips and album photos\.$/);
    expect(describeMirror(base)).toBe("Not copied yet.");
    expect(describeMirror({ ...base, mirror: { ...base.mirror, running: true, processed: 12 } })).toBe(
      "Copying from the server: 12 so far.",
    );
    expect(
      describeMirror({
        ...base,
        mirror: {
          ...base.mirror,
          finishedAt: 1,
          result: { applied: 5, removed: 0, skippedSpecies: 0, userSpecies: 1, library: 3 },
        },
      }),
    ).toMatch(/: 5 photos, 1 species mark, 3 album and trip changes\.$/);
  });
});

describe("large counts", () => {
  it("groups the digits of a send in progress", () => {
    const push = { running: true, processed: 1500, total: 118450 };
    expect(describePush({ push } as never)).toBe("Sending to the server: 1,500 of 118,450.");
  });
});

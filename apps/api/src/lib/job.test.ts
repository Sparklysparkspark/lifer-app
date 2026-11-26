import { describe, expect, it } from "vitest";
import { createJob, describeError, JobCancelledError, runningJobsProgress, UNEXPECTED_ERROR } from "./job.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createJob", () => {
  it("claims synchronously, so a second start while running is rejected", async () => {
    const job = createJob<number>("test");
    const gate = deferred();
    expect(
      job.start(async () => {
        await gate.promise;
        return 1;
      }),
    ).toBe(true);
    expect(job.status.running).toBe(true);
    expect(job.start(async () => 2)).toBe(false);
    gate.resolve();
    await job.settled();
    expect(job.status).toMatchObject({ running: false, result: 1, error: null, cancelled: false });
    expect(job.status.finishedAt).not.toBeNull();
  });

  it("can start again after the previous run finished, resetting status", async () => {
    const job = createJob<number, { count: number }>("test", { count: 0 });
    job.start(async (ctx) => {
      ctx.update({ count: 5, processed: 3 });
      throw new Error("boom");
    });
    await job.settled();
    expect(job.status).toMatchObject({ error: "boom", count: 5, processed: 3, running: false });
    expect(job.start(async () => 7)).toBe(true);
    expect(job.status).toMatchObject({ error: null, count: 0, processed: null, running: true });
    await job.settled();
    expect(job.status.result).toBe(7);
  });

  it("cancel aborts the signal and marks the run cancelled, not errored", async () => {
    const job = createJob("test");
    const started = deferred();
    job.start(async (ctx) => {
      started.resolve();
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    await started.promise;
    expect(job.cancel()).toBe(true);
    expect(job.status.cancelRequested).toBe(true);
    await job.settled();
    expect(job.status).toMatchObject({ running: false, cancelled: true, error: null, cancelRequested: false });
  });

  it("throwIfCancelled throws JobCancelledError after cancel", async () => {
    const job = createJob("test");
    const gate = deferred();
    let thrown: unknown;
    job.start(async (ctx) => {
      await gate.promise;
      try {
        ctx.throwIfCancelled();
      } catch (err) {
        thrown = err;
        throw err;
      }
    });
    job.cancel();
    gate.resolve();
    await job.settled();
    expect(thrown).toBeInstanceOf(JobCancelledError);
    expect(job.status.cancelled).toBe(true);
  });

  it("cancel is a no-op when nothing is running", () => {
    expect(createJob("test").cancel()).toBe(false);
  });

  it("does not share array defaults between runs", async () => {
    const job = createJob<void, { notFound: string[] }>("test", { notFound: [] });
    job.start(async () => {
      job.status.notFound.push("x");
    });
    await job.settled();
    expect(job.status.notFound).toEqual(["x"]);
    job.start(async () => {});
    expect(job.status.notFound).toEqual([]);
    await job.settled();
  });

  it("shows a plain sentence for a Postgres error, never its text or detail", async () => {
    const job = createJob<void>("test");
    const pgErr = Object.assign(
      new Error('duplicate key value violates unique constraint "regions_name_parent_id_key"'),
      { detail: "Key (name, parent_id)=(Central, ...) already exists.", code: "23505", severity: "ERROR" },
    );
    job.start(async () => {
      throw pgErr;
    });
    await job.settled();
    expect(job.status.error).toBe(UNEXPECTED_ERROR);
  });
});

describe("describeError", () => {
  it("keeps a plain message as it is", () => {
    expect(describeError(new Error("Couldn't download the catalog. Try again."))).toBe(
      "Couldn't download the catalog. Try again.",
    );
    expect(describeError("just a string")).toBe("just a string");
  });

  it("hides database, OS and stack text behind one plain sentence", () => {
    expect(describeError(Object.assign(new Error("boom"), { severity: "ERROR", detail: "Key (id)=(1)" }))).toBe(
      UNEXPECTED_ERROR,
    );
    for (const raw of [
      "deadlock detected",
      'relation "photos" does not exist',
      "connect ECONNREFUSED 127.0.0.1:5432",
      "Cannot read properties of undefined at run (/srv/app/index.js:12:3)",
    ])
      expect(describeError(new Error(raw)), raw).toBe(UNEXPECTED_ERROR);
  });

  it("says what to do about a missing or locked folder", () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
      path: "/Volumes/Photos",
    });
    expect(describeError(err)).toMatch(/^That folder \(\/Volumes\/Photos\) doesn't exist/);
  });

  it("falls back for empty or unknown values", () => {
    expect(describeError(new Error(""))).toBe(UNEXPECTED_ERROR);
    expect(describeError(undefined)).toBe(UNEXPECTED_ERROR);
    expect(describeError({ some: "object" })).toBe(UNEXPECTED_ERROR);
  });
});

describe("runningJobsProgress", () => {
  it("averages the jobs that can say how far along they are, and drops finished ones", async () => {
    expect(runningJobsProgress()).toEqual({ running: 0, progress: null });
    const gate = deferred();
    const a = createJob("progress-a");
    const b = createJob("progress-b");
    const c = createJob("progress-c");
    const hold = (processed: number | null, total: number | null) => async (ctx: { update: (p: object) => void }) => {
      ctx.update({ processed, total });
      await gate.promise;
    };
    a.start(hold(1, 4));
    b.start(hold(3, 4));
    c.start(hold(null, null));
    expect(runningJobsProgress()).toEqual({ running: 3, progress: 0.5 });
    gate.resolve();
    await Promise.all([a.settled(), b.settled(), c.settled()]);
    expect(runningJobsProgress()).toEqual({ running: 0, progress: null });
  });

  it("leaves silent jobs out", async () => {
    const gate = deferred();
    const quiet = createJob("progress-silent", undefined, { silent: true });
    quiet.start(async (ctx) => {
      ctx.update({ processed: 1, total: 2 });
      await gate.promise;
    });
    expect(quiet.status.running).toBe(true);
    expect(runningJobsProgress()).toEqual({ running: 0, progress: null });
    gate.resolve();
    await quiet.settled();
  });
});

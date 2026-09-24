import { describe, expect, it } from "vitest";
import { createJob, describeError, JobCancelledError } from "./job.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createJob", () => {
  it("claims synchronously, so a second start while running is rejected", async () => {
    const job = createJob<number>("test");
    const gate = deferred();
    expect(job.start(async () => { await gate.promise; return 1; })).toBe(true);
    expect(job.status.running).toBe(true);
    expect(job.start(async () => 2)).toBe(false);
    gate.resolve();
    await job.settled();
    expect(job.status).toMatchObject({ running: false, result: 1, error: null, cancelled: false });
    expect(job.status.finishedAt).not.toBeNull();
  });

  it("can start again after the previous run finished, resetting status", async () => {
    const job = createJob<number, { count: number }>("test", { count: 0 });
    job.start(async (ctx) => { ctx.update({ count: 5, processed: 3 }); throw new Error("boom"); });
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
    job.start(async () => { job.status.notFound.push("x"); });
    await job.settled();
    expect(job.status.notFound).toEqual(["x"]);
    job.start(async () => {});
    expect(job.status.notFound).toEqual([]);
    await job.settled();
  });

  it("surfaces a Postgres error's detail in the job status, not just the bare message", async () => {
    const job = createJob<void>("test");
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "regions_name_parent_id_key"'), {
      detail: "Key (name, parent_id)=(Central, ...) already exists.",
      code: "23505",
    });
    job.start(async () => {
      throw pgErr;
    });
    await job.settled();
    expect(job.status.error).toBe(
      'duplicate key value violates unique constraint "regions_name_parent_id_key" (Key (name, parent_id)=(Central, ...) already exists.)',
    );
  });
});

describe("describeError", () => {
  it("appends a Postgres error's detail when present", () => {
    const err = Object.assign(new Error("boom"), { detail: "extra context" });
    expect(describeError(err)).toBe("boom (extra context)");
  });

  it("falls back to the plain message when there's no detail", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("just a string")).toBe("just a string");
  });
});

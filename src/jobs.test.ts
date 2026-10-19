import assert from "node:assert/strict";
import { test } from "node:test";
import { type Job, JobRegistry, NotificationBatcher, type ToolResultLike } from "./jobs.ts";

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

const ok = (text: string, exit = 0): ToolResultLike => ({
	content: [{ type: "text", text }],
	isError: exit !== 0,
	structuredContent: { exit_code: exit },
});

test("job records success, failure exit code, and rejection", async () => {
	const settled: string[] = [];
	const registry = new JobRegistry({ onSettled: (j) => settled.push(j.id) });
	const a = deferred<ToolResultLike>();
	const b = deferred<ToolResultLike>();
	const c = deferred<ToolResultLike>();
	const ja = registry.adopt("echo a", a.promise, new AbortController(), () => "");
	const jb = registry.adopt("false", b.promise, new AbortController(), () => "");
	const jc = registry.adopt("x", c.promise, new AbortController(), () => "");
	a.resolve(ok("a"));
	b.resolve(ok("boom", 2));
	c.reject(new Error("Command timed out after 1 seconds"));
	await Promise.all([ja.settled, jb.settled, jc.settled]);
	assert.deepEqual([ja.status, ja.text, ja.exitCode], ["succeeded", "a", 0]);
	assert.deepEqual([jb.status, jb.exitCode], ["failed", 2]);
	assert.deepEqual([jc.status, jc.text], ["failed", "Command timed out after 1 seconds"]);
	assert.deepEqual(settled, ["bash-1", "bash-2", "bash-3"]);
});

test("kill aborts, marks delivered, and settles as killed", async () => {
	const registry = new JobRegistry({ onSettled: () => {} });
	const run = deferred<ToolResultLike>();
	const controller = new AbortController();
	controller.signal.addEventListener("abort", () => run.reject(new Error("Command aborted")));
	const job = registry.adopt("sleep 9", run.promise, controller, () => "partial");
	assert.equal(registry.output(job.id), "partial");
	assert.equal(registry.kill(job.id), true);
	await job.settled;
	assert.equal(job.status, "killed");
	assert.equal(job.delivered, true);
	assert.equal(registry.kill(job.id), false, "second kill is a no-op");
	assert.equal(registry.kill("bash-99"), false);
});

test("batcher sends near-simultaneous completions as one batch and skips delivered jobs", async () => {
	const batches: string[][] = [];
	const batcher = new NotificationBatcher((jobs) => batches.push(jobs.map((j) => j.id)), 20);
	const job = (id: string, delivered = false) => ({ id, delivered, queued: false, watchers: 0 }) as Job;
	const a = job("bash-1");
	batcher.add(a);
	batcher.add(job("bash-2"));
	batcher.add(job("bash-3", true));
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(batches, [["bash-1", "bash-2"]]);
	assert.equal(a.queued, true, "flushed jobs are queued until the transcript confirms them");
	assert.equal(a.delivered, false);
	batcher.add(job("bash-4"));
	batcher.dispose();
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(batches.length, 1, "disposed batcher sends nothing");
});

test("a job delivered by wait before the window closes is not re-sent", async () => {
	const batches: string[][] = [];
	const batcher = new NotificationBatcher((jobs) => batches.push(jobs.map((j) => j.id)), 20);
	const j = { id: "bash-1", delivered: false, queued: false, watchers: 0 } as Job;
	batcher.add(j);
	j.delivered = true;
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(batches, []);
});

test("jobs being waited on are left to the wait", async () => {
	const batches: string[][] = [];
	const batcher = new NotificationBatcher((jobs) => batches.push(jobs.map((j) => j.id)), 20);
	batcher.add({ id: "bash-1", delivered: false, queued: false, watchers: 1 } as Job);
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(batches, []);
});

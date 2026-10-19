// Integration tests: the extension wired to a fake ExtensionAPI, running pi's real built-in bash.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import bashYield, { capabilitiesFor, effectiveThresholdMs, parseThresholdSeconds } from "./index.ts";
import { backgroundAwareRenderResult, noticeRenderer } from "./render.ts";

type Handler = (event: any, ctx: any) => any;

function harness(options: { mode?: string; flags?: Record<string, unknown> } = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Handler[]>();
	const sent: { message: any; options: any }[] = [];
	const statuses: (string | undefined)[] = [];
	const renderers = new Map<string, any>();
	const pi: any = {
		registerMessageRenderer: (type: string, r: any) => renderers.set(type, r),
		registerFlag() {},
		getFlag: (name: string) => options.flags?.[name],
		getSettings: () => ({}),
		registerTool: (def: any) => tools.set(def.name, def),
		on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
		sendMessage: (message: any, opts: any) => sent.push({ message, options: opts }),
	};
	bashYield(pi);
	let pending = false;
	const ctx: any = {
		mode: options.mode ?? "tui",
		cwd: process.cwd(),
		hasPendingMessages: () => pending,
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		model: undefined,
		ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
	};
	const bash = (params: any, signal?: AbortSignal, id = "call-1") => tools.get("bash").execute(id, params, signal, undefined, ctx);
	const job = (params: any) => tools.get("bash_job").execute("call-j", params, undefined, undefined, ctx);
	const emit = async (type: string, event: any = {}) => {
		for (const h of handlers.get(type) ?? []) await h({ type, ...event }, ctx);
	};
	// Like pi: input handlers run first, the steer is queued only after they all return.
	const steer = async (queueDelayMs = 0) => {
		await emit("input", { text: "hi", source: "interactive", streamingBehavior: "steer" });
		if (queueDelayMs) await sleep(queueDelayMs);
		pending = true;
	};
	const shutdown = () => emit("session_shutdown", { reason: "quit" });
	const setPending = (value: boolean) => (pending = value);
	return { bash, job, steer, shutdown, emit, setPending, sent, ctx, statuses, renderers, tools };
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (marker: string) => {
	try {
		execSync(`pgrep -f "${marker}"`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

test("capabilities per mode", () => {
	assert.deepEqual(capabilitiesFor("tui", false), { yieldOnSteer: true, background: true });
	assert.deepEqual(capabilitiesFor("rpc", false), { yieldOnSteer: true, background: false });
	assert.deepEqual(capabilitiesFor("print", false), { yieldOnSteer: false, background: false });
	assert.deepEqual(capabilitiesFor("json", false), { yieldOnSteer: false, background: false });
	assert.deepEqual(capabilitiesFor("tui", true), { yieldOnSteer: false, background: false });
});

test("threshold parsing", () => {
	assert.equal(parseThresholdSeconds(undefined), 60);
	assert.equal(parseThresholdSeconds("0"), 0);
	assert.equal(parseThresholdSeconds("2.5"), 2.5);
	assert.equal(parseThresholdSeconds("-1"), 60);
	assert.equal(parseThresholdSeconds("abc"), 60);
});

test("fast commands match built-in bash output, exit code, and truncation", async () => {
	const h = harness();
	const builtin = createBashToolDefinition(process.cwd());
	const strip = (r: any) => ({ ...r, structuredContent: r.structuredContent && { ...r.structuredContent, wall_time_seconds: 0 } });
	for (const command of ["echo hi; echo err >&2", "exit 3", "seq 1 5000"]) {
		const ours = strip(await h.bash({ command }));
		const theirs = strip(await builtin.execute("x", { command }, undefined, undefined, h.ctx));
		if (ours.details?.fullOutputPath) {
			ours.details.fullOutputPath = theirs.details.fullOutputPath = "<tmp>";
			ours.content[0].text = ours.content[0].text.replace(/Full output: \S+/, "");
			theirs.content[0].text = theirs.content[0].text.replace(/Full output: \S+/, "");
		}
		assert.deepEqual(ours, theirs, command);
	}
});

test("a steer moves the running command to the background; completion is notified via steer", async () => {
	const h = harness();
	const call = h.bash({ command: "sleep 0.6; echo finished" });
	await sleep(150);
	await h.steer();
	const result = await call;
	assert.match(textOf(result), /Backgrounded early .* as job bash-1/);
	await sleep(900);
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(h.sent[0].message.content, /bash-1 succeeded exit=0[\s\S]*finished/);
});

test("abort (Esc) while in the foreground kills the command like built-in", async () => {
	const h = harness();
	const controller = new AbortController();
	const call = h.bash({ command: "sleep 31.01" }, controller.signal);
	await sleep(200);
	assert.equal(alive("sleep 31.01"), true);
	controller.abort();
	await assert.rejects(call, /Command aborted/);
	await sleep(100);
	assert.equal(alive("sleep 31.01"), false);
});

test("threshold backgrounds without input; bash_job wait returns the result once", async () => {
	const h = harness({ flags: { "bash-yield-threshold": "0.2" } });
	const result = await h.bash({ command: "sleep 0.5; echo t-done" });
	assert.match(textOf(result), /Still running after 0s; moved to the background/);
	const waited = await h.job({ action: "wait", id: "bash-1", timeout: 5 });
	assert.match(textOf(waited), /bash-1 succeeded[\s\S]*t-done/);
	await sleep(400);
	assert.equal(h.sent.length, 0, "wait delivered it; no duplicate notification");
});

test("run_in_background returns immediately; kill terminates the process group", async () => {
	const h = harness();
	const started = await h.bash({ command: "sleep 32.02", run_in_background: true });
	assert.match(textOf(started), /Started in the background as job bash-1/);
	await sleep(150);
	assert.equal(alive("sleep 32.02"), true);
	const killed = await h.job({ action: "kill", id: "bash-1" });
	assert.match(textOf(killed), /bash-1 killed/);
	await sleep(100);
	assert.equal(alive("sleep 32.02"), false);
	assert.equal(h.sent.length, 0);
});

test("wait ends early when the user sends a message", async () => {
	const h = harness();
	await h.bash({ command: "sleep 33.03", run_in_background: true });
	const waiting = h.job({ action: "wait", timeout: 20 });
	await sleep(100);
	await h.steer();
	assert.match(textOf(await waiting), /user sent a message[\s\S]*bash-1 running/);
	await h.shutdown();
});

test("session_shutdown kills background jobs and suppresses notifications", async () => {
	const h = harness();
	await h.bash({ command: "sleep 34.04", run_in_background: true });
	await sleep(150);
	assert.equal(alive("sleep 34.04"), true);
	await h.shutdown();
	await sleep(400);
	assert.equal(alive("sleep 34.04"), false);
	assert.equal(h.sent.length, 0);
});

test("print mode ignores steer and run_in_background (built-in behavior)", async () => {
	const h = harness({ mode: "print" });
	const call = h.bash({ command: "sleep 0.4; echo p-done", run_in_background: true });
	await sleep(100);
	await h.steer();
	assert.equal(textOf(await call).trim(), "p-done");
});

test("rpc mode yields on steer but ignores threshold and run_in_background", async () => {
	const h = harness({ mode: "rpc", flags: { "bash-yield-threshold": "0.1" } });
	assert.equal(textOf(await h.bash({ command: "sleep 0.3; echo r-done", run_in_background: true })).trim(), "r-done");
	const call = h.bash({ command: "sleep 0.5; echo r2" });
	await sleep(100);
	await h.steer();
	assert.match(textOf(await call), /Backgrounded early/);
	await h.shutdown();
});

test("nested tool calls are never backgrounded", async () => {
	const h = harness({ flags: { "bash-yield-threshold": "0.1" } });
	const result = await h.bash({ command: "sleep 0.3; echo nested" }, undefined, "parent/1");
	assert.equal(textOf(result).trim(), "nested");
});

test("huge thresholds mean never instead of overflowing the timer", () => {
	assert.equal(parseThresholdSeconds("3000000"), 0);
	assert.equal(parseThresholdSeconds("2147483"), 2147483);
});

test("an earlier pending follow-up does not make the steer yield before it is queued", async () => {
	const h = harness();
	h.setPending(true); // a follow-up queued before the steer
	const call = h.bash({ command: "sleep 2; echo late" });
	await sleep(100);
	const t0 = Date.now();
	await h.steer(200); // another handler takes 200 ms before pi queues the steer
	const result = await call;
	assert.match(textOf(result), /Backgrounded early/);
	assert.ok(Date.now() - t0 >= 400, "waited for the grace deadline instead of trusting the old pending flag");
	await h.shutdown();
});

test("abort followed by a steer before the kill settles still reports the abort", async () => {
	const h = harness();
	const controller = new AbortController();
	const call = h.bash({ command: "sleep 35.05" }, controller.signal);
	await sleep(150);
	await h.emit("input", { text: "hi", source: "interactive", streamingBehavior: "steer" });
	h.setPending(true);
	controller.abort();
	await assert.rejects(call, /Command aborted/);
});

test("a notice dropped from the queue (Esc) is re-sent for the next turn; a delivered one is not", async () => {
	const h = harness();
	await h.bash({ command: "echo one", run_in_background: true });
	await h.bash({ command: "echo two", run_in_background: true });
	await sleep(400);
	assert.equal(h.sent.length, 1, "both completions batched into one notice");
	assert.deepEqual([...h.sent[0].message.details.jobs].sort(), ["bash-1", "bash-2"]); // settle order is up to the OS
	// Esc: the queue was cleared, the notice never reached the transcript.
	await h.emit("agent_settled", { aborted: true });
	assert.equal(h.sent.length, 2);
	assert.deepEqual(h.sent[1].options, { deliverAs: "nextTurn", triggerTurn: false });
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 2, "re-sent once only");

	await h.bash({ command: "echo three", run_in_background: true });
	await sleep(400);
	assert.equal(h.sent.length, 3);
	await h.emit("message_end", { message: { role: "custom", customType: "bash-yield", details: h.sent[2].message.details } });
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 3, "confirmed notice is not re-sent");
});

test("waiting on several jobs reports each result once, without a separate notice", async () => {
	const h = harness();
	await h.bash({ command: "echo fast-one", run_in_background: true });
	await h.bash({ command: "sleep 0.8; echo slow-one", run_in_background: true });
	const waited = textOf(await h.job({ action: "wait", timeout: 5 }));
	await sleep(400);
	assert.match(waited, /fast-one/);
	assert.match(waited, /slow-one/);
	assert.equal(h.sent.length, 0);
});

test("timeout at or below the threshold disables auto-background for that call", () => {
	assert.equal(effectiveThresholdMs(60_000, undefined), 60_000);
	assert.equal(effectiveThresholdMs(60_000, 120), 60_000);
	assert.equal(effectiveThresholdMs(60_000, 60), undefined);
	assert.equal(effectiveThresholdMs(60_000, 5), undefined);
	assert.equal(effectiveThresholdMs(0, undefined), undefined);
});

test("a command that times out before the threshold fails in the foreground instead of moving", async () => {
	const h = harness({ flags: { "bash-yield-threshold": "1" } });
	await assert.rejects(h.bash({ command: "sleep 36.06", timeout: 1 }), /timed out/);
	assert.equal(h.sent.length, 0);
	await sleep(100);
	assert.equal(alive("sleep 36.06"), false);
});

test("backgrounded results carry display details; notices carry per-job summaries", async () => {
	const h = harness();
	const call = h.bash({ command: "echo partial-line; sleep 0.6; echo finished" });
	await sleep(200);
	await h.steer();
	const result = await call;
	assert.match(textOf(result), /^Backgrounded early .* as job bash-1\./, "model-facing text unchanged");
	assert.equal(result.details.backgrounded.jobId, "bash-1");
	assert.equal(result.details.backgrounded.reason, "steer");
	assert.match(result.details.backgrounded.output, /partial-line/);
	await sleep(900);
	const details = h.sent[0].message.details;
	assert.deepEqual(details.jobs, ["bash-1"]);
	assert.equal(details.summary[0].status, "succeeded");
	assert.match(details.summary[0].line, /^bash-1 succeeded exit=0 /);
	assert.match(details.summary[0].output, /finished/);
});

test("footer status shows running jobs in tui and clears when none remain", async () => {
	const h = harness();
	await h.bash({ command: "sleep 0.3", run_in_background: true });
	assert.equal(h.statuses.at(-1), "⏵ bash-1 running");
	await h.bash({ command: "sleep 0.3", run_in_background: true });
	assert.equal(h.statuses.at(-1), "⏵ 2 bash jobs running");
	await sleep(600);
	assert.equal(h.statuses.at(-1), undefined);
	await h.shutdown();
});

test("rpc mode never touches the footer status", async () => {
	const h = harness({ mode: "rpc" });
	const call = h.bash({ command: "sleep 0.3" });
	await sleep(100);
	await h.steer();
	await call;
	await sleep(400);
	assert.deepEqual(h.statuses, []);
});

const fakeTheme: any = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
const renderText = (component: any) => component.render(120).join("\n");

test("renderResult marks backgrounded results and delegates everything else to built-in", () => {
	const h = harness();
	const seen: any[] = [];
	const builtin = (result: any) => (seen.push(result), new Text(result.content[0].text, 0, 0));
	const render = backgroundAwareRenderResult(builtin);
	const plain: any = { content: [{ type: "text", text: "hello" }], details: undefined };
	render(plain, { expanded: false, isPartial: false }, fakeTheme, {} as any);
	assert.equal(seen[0], plain);
	const out = renderText(
		render(
			{ content: [{ type: "text", text: "model text" }], details: { backgrounded: { jobId: "bash-3", reason: "steer", thresholdMs: 0, output: "tick 1" } } },
			{ expanded: false, isPartial: false },
			fakeTheme,
			{} as any,
		),
	);
	assert.match(out, /tick 1/);
	assert.match(out, /↪ moved to background \(message received\) as bash-3/);
	assert.doesNotMatch(out, /model text/);
	assert.ok(h.tools.get("bash").renderResult, "bash registers the wrapper");
});

test("notice renderer: one line per job collapsed, output when expanded, default for old notices", () => {
	const message: any = {
		customType: "bash-yield",
		content: "x",
		details: {
			jobs: ["bash-1", "bash-2"],
			summary: [
				{ id: "bash-1", status: "succeeded", line: "bash-1 succeeded exit=0 50s — make", output: "built ok" },
				{ id: "bash-2", status: "failed", line: "bash-2 failed exit=1 3s — test", output: "boom" },
			],
		},
	};
	const expanded = renderText(noticeRenderer(message, { expanded: true, outputPad: 1 }, fakeTheme));
	assert.match(expanded, /✓ bash-1 succeeded[\s\S]*built ok[\s\S]*✗ bash-2 failed[\s\S]*boom/);
	assert.equal(noticeRenderer({ ...message, details: { jobs: ["bash-1"] } }, { expanded: false, outputPad: 1 }, fakeTheme), undefined);
});

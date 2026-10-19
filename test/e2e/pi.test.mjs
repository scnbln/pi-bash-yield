// End-to-end tests against the installed `pi` binary with a scripted (faux) model.
// Requires `pi` (1.3.x) on PATH. Run: npm run test:e2e
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";

const BASE_ARGS = ["--no-session", "-ne", "--no-mcp", "-ns", "-np", "-nc", "--no-themes",
	"-e", "./test/e2e/faux-provider.ts", "-e", "./src/index.ts", "--model", "faux/m"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pattern) => {
	try {
		execSync(`pgrep -f "${pattern}"`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

function startRpc(script) {
	const child = spawn("pi", ["--mode", "rpc", ...BASE_ARGS], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PI_BY_SCRIPT: script } });
	const events = [];
	const waiters = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		let ev;
		try { ev = JSON.parse(line); } catch { return; }
		events.push(ev);
		for (const w of [...waiters]) if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
	});
	const next = (match, ms = 10000) => {
		const found = events.find(match);
		if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found); }
		return new Promise((resolve, reject) => {
			const w = { match, resolve: (ev) => { clearTimeout(t); events.splice(events.indexOf(ev), 1); resolve(ev); } };
			const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timed out waiting for event")); }, ms);
			waiters.push(w);
		});
	};
	const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
	const close = () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); });
	return { send, next, close, events };
}

const assistantText = (ev) => ev.type === "message_end" && ev.message?.role === "assistant"
	&& ev.message.content.some((c) => c.type === "text" && c.text);
const textOf = (ev) => ev.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");

test("rpc: a steer reaches the very next LLM call with its image while bash keeps running", async () => {
	const pi = startRpc("sleep 41.01; echo done");
	try {
		pi.send({ type: "prompt", message: "go" });
		await pi.next((e) => e.type === "tool_execution_start" && e.toolName === "bash");
		await sleep(500);
		const t0 = Date.now();
		pi.send({ type: "prompt", message: "STEER-MSG", images: [{ type: "image", data: PNG, mimeType: "image/png" }], streamingBehavior: "steer" });
		const end = await pi.next((e) => e.type === "tool_execution_end" && e.toolName === "bash");
		assert.match(end.result.content[0].text, /Backgrounded early .* as job bash-1/);
		const reply = await pi.next(assistantText);
		assert.ok(Date.now() - t0 < 2000, "steer delivered promptly");
		const context = JSON.parse(textOf(reply).replace(/^TURN\d+ CONTEXT /, ""));
		assert.deepEqual(context.at(-1), { role: "user", text: "STEER-MSG", images: 1 });
		assert.equal(context.at(-2).role, "toolResult");
		assert.equal(alive("sleep 41.01"), true, "command keeps running");
	} finally {
		await pi.close();
	}
	await sleep(200);
	assert.equal(alive("sleep 41.01"), false, "pi exit cleans up the background job");
});

test("rpc: a backgrounded job reports completion as a new turn", async () => {
	const pi = startRpc("sleep 1.5; echo job-finished");
	try {
		pi.send({ type: "prompt", message: "go" });
		await pi.next((e) => e.type === "tool_execution_start" && e.toolName === "bash");
		pi.send({ type: "prompt", message: "STEER", streamingBehavior: "steer" });
		await pi.next(assistantText);
		const notice = await pi.next((e) => e.type === "message_end" && e.message?.role === "custom", 5000);
		assert.equal(notice.message.customType, "bash-yield");
		assert.match(JSON.stringify(notice.message.content), /bash-1 succeeded exit=0.*job-finished/);
		const reply = await pi.next(assistantText);
		assert.match(textOf(reply), /job-finished/);
	} finally {
		await pi.close();
	}
});

test("rpc: new_session (session_shutdown) kills background jobs", async () => {
	const pi = startRpc("sleep 42.02; echo never");
	try {
		pi.send({ type: "prompt", message: "go" });
		await pi.next((e) => e.type === "tool_execution_start" && e.toolName === "bash");
		pi.send({ type: "prompt", message: "STEER", streamingBehavior: "steer" });
		await pi.next(assistantText);
		await pi.next((e) => e.type === "agent_settled");
		assert.equal(alive("sleep 42.02"), true);
		pi.send({ id: "n", type: "new_session" });
		await pi.next((e) => e.type === "response" && e.id === "n");
		await sleep(300);
		assert.equal(alive("sleep 42.02"), false);
	} finally {
		await pi.close();
	}
});

test("print mode: pi -p waits for the command and returns its result", () => {
	const out = execFileSync("pi", ["-p", ...BASE_ARGS, "run: sleep 5; echo ok"], {
		env: { ...process.env, PI_BY_SCRIPT: "sleep 5; echo ok", PI_BASH_YIELD_THRESHOLD: "1" },
		encoding: "utf8",
		timeout: 30000,
	});
	const context = JSON.parse(out.trim().replace(/^TURN\d+ CONTEXT /, ""));
	assert.deepEqual(context.at(-1), { role: "toolResult", text: "ok\n", images: 0 });
});

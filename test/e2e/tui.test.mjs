// Drives the interactive TUI through tmux with the scripted (faux) model. Skipped without tmux.
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { test } from "node:test";

const hasTmux = (() => {
	try {
		execSync("command -v tmux", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" });
// Match the real processes, not the tmux command line that carries the script in an env var.
const alive = (secs) => {
	try {
		execSync(`pgrep -f "^(/bin/bash -c )?sleep ${secs}"`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

async function withTui(name, script, extraArgs, body) {
	const session = `pby-${name}-${process.pid}`;
	const cmd = `cd '${process.cwd()}' && PI_BY_SCRIPT='${script}' pi --no-session -ne --no-mcp -ns -np -nc --no-themes ` +
		`-e ./test/e2e/faux-provider.ts -e ./src/index.ts --model faux/m ${extraArgs}`;
	tmux("new-session", "-d", "-s", session, "-x", "160", "-y", "50", cmd);
	const screen = () => tmux("capture-pane", "-pt", session, "-S", "-200");
	const waitFor = async (re, ms = 10000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (re.test(screen())) return;
			await sleep(100);
		}
		assert.fail(`screen never matched ${re}\n${screen()}`);
	};
	const keys = (...k) => tmux("send-keys", "-t", session, ...k);
	try {
		await waitFor(/faux\) m/);
		keys("go", "Enter");
		await body({ screen, waitFor, keys });
	} finally {
		try { tmux("kill-session", "-t", session); } catch {}
	}
}

test("tui: Enter while bash runs yields, the model sees the message, completion is reported", { skip: !hasTmux }, async () => {
	await withTui("steer", "sleep 3.31; echo done-marker", "", async ({ waitFor, keys }) => {
		await waitFor(/\$ sleep 3\.31/);
		await sleep(500);
		keys("STEER-FROM-TUI", "Enter");
		await waitFor(/↪ moved to background \(message received\) as bash-1/, 2000);
		await waitFor(/⏵ bash-1 running/, 2000);
		await waitFor(/"text":"STEER-FROM-TUI"/, 2000);
		assert.equal(alive("3.31"), true, "command keeps running");
		// Collapsed notice: one summary line; the model still got the full text (TURN3 echoes it).
		await waitFor(/✓ bash-1 succeeded exit=0 \d+s — sleep 3\.31[\s\S]*TURN3[\s\S]*Background bash job finished/, 8000);
		await waitFor(/^(?![\s\S]*⏵ bash-1 running)/, 2000);
	});
});

test("tui: Esc kills the foreground command", { skip: !hasTmux }, async () => {
	await withTui("esc", "sleep 61.1; echo x", "", async ({ waitFor, keys }) => {
		await waitFor(/\$ sleep 61\.1/);
		await sleep(500);
		assert.equal(alive("61.1"), true);
		keys("Escape");
		await waitFor(/Command aborted/);
		await sleep(300);
		assert.equal(alive("61.1"), false);
	});
});

test("tui: threshold backgrounds; /reload kills the job", { skip: !hasTmux }, async () => {
	await withTui("reload", "sleep 62.2; echo y", "--bash-yield-threshold 1", async ({ waitFor, keys }) => {
		await waitFor(/↪ moved to background \(still running after 1s\) as bash-1/, 5000);
		assert.equal(alive("62.2"), true);
		keys("/reload", "Enter");
		await waitFor(/Reloaded/);
		await sleep(300);
		assert.equal(alive("62.2"), false);
	});
});

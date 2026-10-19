import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { backgroundedText, jobLine, notificationText, runningStatus, tail } from "./format.ts";
import { type Job, JobRegistry, NotificationBatcher, resultText } from "./jobs.ts";
import { Interrupts, raceForeground } from "./race.ts";
import { type BackgroundedDetails, backgroundAwareRenderResult, type NoticeDetails, noticeRenderer } from "./render.ts";

export const DEFAULT_THRESHOLD_SECONDS = 60;
const WAIT_DEFAULT_SECONDS = 300;
const WAIT_MAX_SECONDS = 1800;
/** How long a steer may take to reach pi's queue before the foreground command yields anyway. */
const STEER_QUEUE_GRACE_MS = 500;
const MAX_TIMER_MS = 2_147_483_647;
const NOTICE_TYPE = "bash-yield";
const STATUS_KEY = "bash-yield";

export interface Capabilities {
	/** A user steer moves the running foreground command to the background. */
	yieldOnSteer: boolean;
	/** The threshold and `run_in_background` may background a command without user input. */
	background: boolean;
}

/**
 * tui: everything. rpc: yield only on an explicit steer, because pi-subagents children
 * run in rpc mode and must not end a run with work still pending. print/json: built-in bash.
 */
export function capabilitiesFor(mode: ExtensionContext["mode"], disabled: boolean): Capabilities {
	if (disabled) return { yieldOnSteer: false, background: false };
	if (mode === "tui") return { yieldOnSteer: true, background: true };
	if (mode === "rpc") return { yieldOnSteer: true, background: false };
	return { yieldOnSteer: false, background: false };
}

export function parseThresholdSeconds(raw: unknown): number {
	if (raw === undefined || raw === "") return DEFAULT_THRESHOLD_SECONDS;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return DEFAULT_THRESHOLD_SECONDS;
	// Node timers overflow past 2^31-1 ms and fire immediately; such a threshold means "never".
	return value * 1000 > MAX_TIMER_MS ? 0 : value;
}

/**
 * Auto-background threshold for one call, or undefined when it must not fire: a command whose
 * own timeout ends it at or before the threshold would be killed right after moving.
 */
export function effectiveThresholdMs(thresholdMs: number, timeoutSeconds: unknown): number | undefined {
	if (thresholdMs <= 0) return undefined;
	if (typeof timeoutSeconds === "number" && timeoutSeconds > 0 && timeoutSeconds * 1000 <= thresholdMs) return undefined;
	return thresholdMs;
}

const bashJobSchema = Type.Object({
	action: StringEnum(["status", "output", "wait", "kill"] as const, {
		description: "status: list jobs (or one job). output: current/final output. wait: block until the job(s) finish. kill: terminate.",
	}),
	id: Type.Optional(Type.String({ description: "Job id such as bash-1. Required for output and kill; optional for status and wait (all running jobs)." })),
	timeout: Type.Optional(Type.Number({ description: `wait only: maximum seconds to wait (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}).` })),
});

function text(value: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: value }], details: undefined };
}

function backgrounded(job: Job, reason: BackgroundedDetails["backgrounded"]["reason"], thresholdMs: number, partial: string): AgentToolResult<BackgroundedDetails> {
	return {
		content: [{ type: "text", text: backgroundedText(job, reason, thresholdMs, partial) }],
		details: { backgrounded: { jobId: job.id, reason, thresholdMs, output: tail(partial, 2000) } },
	};
}

export default function bashYield(pi: ExtensionAPI) {
	pi.registerFlag("bash-yield-threshold", {
		type: "string",
		description: `Seconds before a foreground bash command moves to the background (0 = never; default ${DEFAULT_THRESHOLD_SECONDS}). Env: PI_BASH_YIELD_THRESHOLD.`,
	});
	pi.registerFlag("bash-yield-disable", {
		type: "boolean",
		description: "Disable pi-bash-yield; bash behaves like the built-in tool. Env: PI_BASH_YIELD_DISABLE=1.",
	});

	const disabled = () => pi.getFlag("bash-yield-disable") === true || process.env.PI_BASH_YIELD_DISABLE === "1";
	const thresholdMs = () => parseThresholdSeconds(pi.getFlag("bash-yield-threshold") ?? process.env.PI_BASH_YIELD_THRESHOLD) * 1000;

	let disposed = false;
	const steer = new Interrupts();
	// Latest TUI context, for the footer status; job settlement happens outside any handler.
	let statusCtx: ExtensionContext | undefined;
	const trackStatusCtx = (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") statusCtx = ctx;
	};
	const refreshStatus = () => {
		if (!statusCtx) return;
		try {
			statusCtx.ui.setStatus(STATUS_KEY, disposed ? undefined : runningStatus(registry.running()));
		} catch {
			statusCtx = undefined; // stale after reload or session switch
		}
	};
	const notify = (jobs: Job[], deliverAs: "steer" | "nextTurn") => {
		if (disposed) return;
		const now = Date.now();
		const details: NoticeDetails = {
			jobs: jobs.map((j) => j.id),
			summary: jobs.map((j) => ({ id: j.id, status: j.status, line: jobLine(j, now), output: tail(j.text ?? "") })),
		};
		try {
			pi.sendMessage(
				{ customType: NOTICE_TYPE, content: notificationText(jobs, now), display: true, details },
				{ deliverAs, triggerTurn: deliverAs === "steer" },
			);
		} catch {
			// Runtime replaced between settle and flush; session_shutdown already killed what it owned.
		}
	};
	const batcher = new NotificationBatcher((jobs) => notify(jobs, "steer"));
	const registry = new JobRegistry({
		onSettled: (job) => {
			refreshStatus();
			batcher.add(job);
		},
	});
	pi.registerMessageRenderer(NOTICE_TYPE, noticeRenderer);
	pi.on("session_start", (_event, ctx) => trackStatusCtx(ctx));

	// A notice counts as delivered once it is in the transcript.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== NOTICE_TYPE) return;
		const ids = (message.details as { jobs?: string[] } | undefined)?.jobs ?? [];
		for (const id of ids) {
			const job = registry.get(id);
			if (job) job.delivered = true;
		}
	});

	// Esc clears pi's queues, dropping notices that were waiting there. Re-attach them to the
	// user's next prompt instead of waking the agent the user just stopped.
	pi.on("agent_settled", () => {
		const lost = registry.unconfirmed();
		if (lost.length === 0) return;
		for (const job of lost) job.delivered = true;
		notify(lost, "nextTurn");
	});

	pi.on("input", (event, ctx) => {
		if (event.streamingBehavior !== "steer" || event.source === "extension" || steer.size === 0) return { action: "continue" };
		if (!capabilitiesFor(ctx.mode, disabled()).yieldOnSteer) return { action: "continue" };
		// pi queues the steer only after every input handler returns. Yield once it is queued
		// so the next LLM call carries it; fall back to a deadline if another handler stalls.
		// A message already pending (e.g. an earlier follow-up) says nothing about this steer.
		const deadline = Date.now() + STEER_QUEUE_GRACE_MS;
		let alreadyPending = true;
		try {
			alreadyPending = ctx.hasPendingMessages();
		} catch {
			// stale ctx: rely on the deadline
		}
		const poll = () => {
			let queued = true;
			try {
				queued = disposed || (!alreadyPending && ctx.hasPendingMessages());
			} catch {
				// stale ctx: yield anyway
			}
			if (queued || Date.now() >= deadline) steer.fire();
			else setTimeout(poll, 10);
		};
		setTimeout(poll, 0);
		return { action: "continue" };
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		batcher.dispose();
		registry.killAll();
		steer.fire();
		refreshStatus();
		statusCtx = undefined;
	});

	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} If the user sends a message while a command runs, or it runs longer than the auto-background threshold, the command keeps running as a background job (bash-N) and you are notified when it finishes; use bash_job to check, wait for, or kill it. To start a long-running process, set run_in_background instead of appending '&' (detached processes are not tracked or cleaned up).`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			run_in_background: Type.Optional(
				Type.Boolean({ description: "Start as a background job and return immediately. Use for long-running servers or watchers." }),
			),
		}),
		renderResult: builtin.renderResult && backgroundAwareRenderResult(builtin.renderResult),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			trackStatusCtx(ctx);
			const { run_in_background, ...bashParams } = params;
			const settings = pi.getSettings();
			const base = createBashToolDefinition(ctx.cwd, { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath });
			const caps = capabilitiesFor(ctx.mode, disabled());
			// Nested calls (codemode scripts, `<parent>/<n>` ids) expect the structured bash result.
			const nested = toolCallId.includes("/");
			if (disposed || nested || (!caps.yieldOnSteer && !caps.background)) {
				return base.execute(toolCallId, bashParams, signal, onUpdate, ctx);
			}

			// Own the abort: the tool signal kills only while we are in the foreground.
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			if (signal?.aborted) controller.abort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });
			let detached = false;
			let latest = "";
			const startedAt = Date.now();
			const run = base.execute(
				toolCallId,
				bashParams,
				controller.signal,
				(update) => {
					latest = resultText(update);
					if (!detached) onUpdate?.(update);
				},
				ctx,
			);
			const detach = (): Job => {
				detached = true;
				signal?.removeEventListener("abort", forwardAbort);
				const job = registry.adopt(params.command, run, controller, () => latest, startedAt);
				refreshStatus();
				return job;
			};

			if (run_in_background && caps.background && !signal?.aborted) {
				return backgrounded(detach(), "requested", 0, "");
			}

			const interrupt = caps.yieldOnSteer ? steer.register() : undefined;
			try {
				const outcome = await raceForeground(run, {
					interrupt: interrupt?.promise ?? new Promise<void>(() => {}),
					thresholdMs: caps.background ? effectiveThresholdMs(thresholdMs(), bashParams.timeout) : undefined,
				});
				if (outcome.kind === "settled") return outcome.value;
				// Already aborted (Esc) or shutting down: let the built-in report the kill as usual.
				if (disposed || controller.signal.aborted) {
					controller.abort();
					return await run;
				}
				return backgrounded(detach(), outcome.reason, thresholdMs(), latest);
			} finally {
				interrupt?.dispose();
				if (!detached) signal?.removeEventListener("abort", forwardAbort);
			}
		},
	});

	pi.registerTool({
		name: "bash_job",
		label: "bash job",
		description:
			"Inspect or control background bash jobs (bash-N) created when a bash command was backgrounded. Completion is reported automatically; use wait only when you cannot proceed without the result.",
		parameters: bashJobSchema,
		async execute(_toolCallId, params, signal) {
			const now = Date.now();
			const lookup = (id: string | undefined): Job | string => {
				if (!id) return `id is required for ${params.action}`;
				return registry.get(id) ?? `Unknown job ${id}. Known: ${registry.list().map((j) => j.id).join(", ") || "none"}`;
			};
			const finalText = (job: Job): string => {
				if (job.delivered) return `${jobLine(job)} (result already reported)`;
				job.delivered = true;
				return `${jobLine(job)}\n${tail(job.text ?? "") || "(no output)"}`;
			};

			switch (params.action) {
				case "status": {
					if (params.id) {
						const job = lookup(params.id);
						return text(typeof job === "string" ? job : jobLine(job, now));
					}
					const jobs = registry.list();
					return text(jobs.length ? jobs.map((j) => jobLine(j, now)).join("\n") : "No background bash jobs.");
				}
				case "output": {
					const job = lookup(params.id);
					if (typeof job === "string") return text(job);
					if (job.status === "running") return text(`${jobLine(job, now)} (still running)\n${tail(registry.output(job.id) ?? "") || "(no output yet)"}`);
					job.delivered = true;
					return text(`${jobLine(job, now)}\n${job.text || "(no output)"}`);
				}
				case "kill": {
					const job = lookup(params.id);
					if (typeof job === "string") return text(job);
					if (!registry.kill(job.id)) return text(`${jobLine(job, now)} (not running)`);
					let killTimer: NodeJS.Timeout | undefined;
					await Promise.race([job.settled, new Promise((r) => (killTimer = setTimeout(r, 5000)))]);
					clearTimeout(killTimer);
					return text(jobLine(job));
				}
				case "wait": {
					let targets: Job[];
					if (params.id) {
						const job = lookup(params.id);
						if (typeof job === "string") return text(job);
						targets = [job];
					} else {
						targets = registry.running();
						if (targets.length === 0) return text("No running background bash jobs.");
					}
					const seconds = Math.min(Math.max(params.timeout ?? WAIT_DEFAULT_SECONDS, 0), WAIT_MAX_SECONDS);
					// This wait reports its targets itself; keep the automatic notice out of the way.
					for (const job of targets) job.watchers++;
					const interrupt = steer.register();
					let timer: NodeJS.Timeout | undefined;
					let onAbort: (() => void) | undefined;
					const stopped = await Promise.race([
						Promise.all(targets.map((j) => j.settled)).then(() => "done" as const),
						interrupt.promise.then(() => "message" as const),
						new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), seconds * 1000))),
						new Promise<"aborted">((r) => {
							onAbort = () => r("aborted");
							if (signal?.aborted) onAbort();
							else signal?.addEventListener("abort", onAbort, { once: true });
						}),
					]).finally(() => {
						for (const job of targets) job.watchers--;
						interrupt.dispose();
						if (timer) clearTimeout(timer);
						if (onAbort) signal?.removeEventListener("abort", onAbort);
					});
					const finished = targets.filter((j) => j.status !== "running");
					const pending = targets.filter((j) => j.status === "running");
					const note = {
						done: "",
						message: "Stopped waiting: the user sent a message. Jobs keep running.",
						timeout: `Stopped waiting after ${seconds}s. Jobs keep running.`,
						aborted: "Wait cancelled. Jobs keep running.",
					}[stopped];
					return text(
						[note, ...finished.map(finalText), ...pending.map((j) => `${jobLine(j)} (still running)`)].filter(Boolean).join("\n\n"),
					);
				}
			}
		},
	});
}

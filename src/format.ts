import type { Job } from "./jobs.ts";

/** Inline cap for job output inside notices; the full result stays readable via `bash_job output`. */
export const NOTICE_MAX_CHARS = 4000;

export function tail(text: string, maxChars = NOTICE_MAX_CHARS): string {
	if (text.length <= maxChars) return text;
	return `[... ${text.length - maxChars} earlier characters omitted; use bash_job output for the full result]\n${text.slice(-maxChars)}`;
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function oneLine(command: string, max = 80): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function jobLine(job: Job, now = Date.now()): string {
	const elapsed = seconds((job.endedAt ?? now) - job.startedAt);
	const exit = job.exitCode !== undefined && job.status !== "running" ? ` exit=${job.exitCode}` : "";
	return `${job.id} ${job.status}${exit} ${elapsed} — ${oneLine(job.command)}`;
}

export function backgroundedText(job: Job, reason: "steer" | "threshold" | "requested", thresholdMs: number, partial: string): string {
	const why = {
		steer: "Backgrounded early to handle an incoming message; the command keeps running",
		threshold: `Still running after ${seconds(thresholdMs)}; moved to the background, the command keeps running`,
		requested: "Started in the background",
	}[reason];
	const lines = [
		`${why} as job ${job.id}.`,
		"You will be notified when it finishes. Use bash_job (status/output/wait/kill) only if you need it sooner.",
	];
	if (partial.trim()) lines.push("", "Output so far:", tail(partial, 2000));
	return lines.join("\n");
}

/** One-line TUI marker for a call that moved to the background. Display only; the model gets `backgroundedText`. */
export function backgroundMarker(jobId: string, reason: "steer" | "threshold" | "requested", thresholdMs: number): string {
	const why = {
		steer: "moved to background (message received)",
		threshold: `moved to background (still running after ${seconds(thresholdMs)})`,
		requested: "started in background",
	}[reason];
	return `↪ ${why} as ${jobId} · keeps running, reports when done`;
}

/** Footer status while jobs run, or undefined to clear it. */
export function runningStatus(running: Job[]): string | undefined {
	if (running.length === 0) return undefined;
	if (running.length === 1) return `⏵ ${running[0].id} running`;
	return `⏵ ${running.length} bash jobs running`;
}

export function notificationText(jobs: Job[], now = Date.now()): string {
	const header = jobs.length === 1 ? "Background bash job finished:" : `${jobs.length} background bash jobs finished:`;
	const blocks = jobs.map((job) => `## ${jobLine(job, now)}\n${tail(job.text ?? "") || "(no output)"}`);
	return [header, ...blocks].join("\n\n");
}

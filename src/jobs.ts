/** Minimal shape of a tool result this module needs (matches pi's AgentToolResult). */
export interface ToolResultLike {
	content: { type: string; text?: string }[];
	isError?: boolean;
	structuredContent?: unknown;
}

export type JobStatus = "running" | "succeeded" | "failed" | "killed";

export interface Job {
	readonly id: string;
	readonly command: string;
	readonly startedAt: number;
	endedAt?: number;
	status: JobStatus;
	/** Final model-facing text once settled. */
	text?: string;
	exitCode?: number;
	/** True once the model has seen the final result (notification, wait, or output), or needs none. */
	delivered: boolean;
	/** A completion notice was handed to pi but not yet confirmed in the transcript. */
	queued: boolean;
	/** Number of in-flight bash_job waits that will report this job themselves. */
	watchers: number;
	/** Resolves when the job settles; never rejects. */
	readonly settled: Promise<void>;
}

export function resultText(result: ToolResultLike): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function exitCodeOf(result: ToolResultLike): number | undefined {
	const sc = result.structuredContent as { exit_code?: unknown } | undefined;
	return typeof sc?.exit_code === "number" ? sc.exit_code : undefined;
}

interface Entry {
	job: Job;
	controller: AbortController;
	latestOutput: () => string;
}

/**
 * Registry of detached bash runs. It owns no processes itself: each job is a
 * pending execution of pi's built-in bash, killed through its AbortController.
 */
export class JobRegistry {
	#entries = new Map<string, Entry>();
	#next = 1;
	#onSettled: (job: Job) => void;
	#now: () => number;

	constructor(options: { onSettled: (job: Job) => void; now?: () => number }) {
		this.#onSettled = options.onSettled;
		this.#now = options.now ?? Date.now;
	}

	adopt(command: string, run: Promise<ToolResultLike>, controller: AbortController, latestOutput: () => string, startedAt?: number): Job {
		const id = `bash-${this.#next++}`;
		let markSettled!: () => void;
		const settled = new Promise<void>((resolve) => (markSettled = resolve));
		const job: Job = {
			id,
			command,
			startedAt: startedAt ?? this.#now(),
			status: "running",
			delivered: false,
			queued: false,
			watchers: 0,
			settled,
		};
		this.#entries.set(id, { job, controller, latestOutput });
		run.then(
			(result) => {
				job.status = result.isError ? "failed" : "succeeded";
				job.text = resultText(result);
				job.exitCode = exitCodeOf(result);
			},
			(error: unknown) => {
				job.status = controller.signal.aborted ? "killed" : "failed";
				job.text = error instanceof Error ? error.message : String(error);
			},
		).then(() => {
			job.endedAt = this.#now();
			markSettled();
			this.#onSettled(job);
		});
		return job;
	}

	get(id: string): Job | undefined {
		return this.#entries.get(id)?.job;
	}

	list(): Job[] {
		return [...this.#entries.values()].map((e) => e.job);
	}

	running(): Job[] {
		return this.list().filter((j) => j.status === "running");
	}

	/** Notices handed to pi that never reached the transcript (e.g. the queue was cleared by Esc). */
	unconfirmed(): Job[] {
		return this.list().filter((j) => j.queued && !j.delivered);
	}

	/** Latest streamed output for a running job, or the final text once settled. */
	output(id: string): string | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		return entry.job.status === "running" ? entry.latestOutput() : (entry.job.text ?? "");
	}

	/** Request termination. Returns false when the job is unknown or already settled. */
	kill(id: string): boolean {
		const entry = this.#entries.get(id);
		if (!entry || entry.job.status !== "running") return false;
		entry.job.delivered = true; // the model asked for it; no completion notice
		entry.controller.abort();
		return true;
	}

	killAll(): void {
		for (const entry of this.#entries.values()) {
			if (entry.job.status !== "running") continue;
			entry.job.delivered = true;
			entry.controller.abort();
		}
	}
}

/**
 * Collects settled jobs for a short window and hands the ones nobody has reported
 * (not delivered, not already queued, not being waited on) to `flush` in one batch,
 * marking them queued. Delivery is confirmed separately, once the notice is in the transcript.
 */
export class NotificationBatcher {
	#pending: Job[] = [];
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	readonly #flush: (jobs: Job[]) => void;
	readonly #windowMs: number;

	constructor(flush: (jobs: Job[]) => void, windowMs = 250) {
		this.#flush = flush;
		this.#windowMs = windowMs;
	}

	add(job: Job): void {
		if (this.#disposed) return;
		this.#pending.push(job);
		this.#timer ??= setTimeout(() => this.#flushNow(), this.#windowMs);
	}

	#flushNow(): void {
		this.#timer = undefined;
		const jobs = this.#pending.filter((j) => !j.delivered && !j.queued && j.watchers === 0);
		this.#pending = [];
		if (jobs.length === 0 || this.#disposed) return;
		for (const job of jobs) job.queued = true;
		this.#flush(jobs);
	}

	dispose(): void {
		this.#disposed = true;
		this.#pending = [];
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

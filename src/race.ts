/** Fan-out signal: every waiter registered before `fire()` is released. */
export class Interrupts {
	#waiters = new Set<() => void>();

	/** Returns a promise released by the next `fire()`, and a disposer for when the waiter is no longer needed. */
	register(): { promise: Promise<void>; dispose: () => void } {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => (release = resolve));
		this.#waiters.add(release);
		return { promise, dispose: () => this.#waiters.delete(release) };
	}

	get size(): number {
		return this.#waiters.size;
	}

	fire(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const release of waiters) release();
	}
}

export type ForegroundOutcome<T> = { kind: "settled"; value: T } | { kind: "background"; reason: "steer" | "threshold" };

/**
 * Wait for `run` unless the interrupt or the threshold fires first. A rejection of `run`
 * before either fires propagates unchanged, so aborts and timeouts surface exactly as
 * the wrapped tool reports them.
 */
export async function raceForeground<T>(
	run: Promise<T>,
	options: { interrupt: Promise<void>; thresholdMs?: number },
): Promise<ForegroundOutcome<T>> {
	let timer: NodeJS.Timeout | undefined;
	const contenders: Promise<ForegroundOutcome<T>>[] = [
		run.then((value) => ({ kind: "settled", value })),
		options.interrupt.then(() => ({ kind: "background", reason: "steer" })),
	];
	if (options.thresholdMs !== undefined && options.thresholdMs > 0) {
		contenders.push(
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({ kind: "background", reason: "threshold" }), options.thresholdMs);
			}),
		);
	}
	try {
		return await Promise.race(contenders);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

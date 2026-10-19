import assert from "node:assert/strict";
import { test } from "node:test";
import { Interrupts, raceForeground } from "./race.ts";

const never = new Promise<void>(() => {});
const delay = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

test("settled run wins and returns its value", async () => {
	const outcome = await raceForeground(delay(5, "ok"), { interrupt: never, thresholdMs: 1000 });
	assert.deepEqual(outcome, { kind: "settled", value: "ok" });
});

test("interrupt backgrounds with reason steer", async () => {
	const interrupts = new Interrupts();
	const { promise } = interrupts.register();
	setTimeout(() => interrupts.fire(), 5);
	const outcome = await raceForeground(delay(1000, "late"), { interrupt: promise, thresholdMs: 2000 });
	assert.deepEqual(outcome, { kind: "background", reason: "steer" });
});

test("threshold backgrounds with reason threshold", async () => {
	const outcome = await raceForeground(delay(1000, "late"), { interrupt: never, thresholdMs: 10 });
	assert.deepEqual(outcome, { kind: "background", reason: "threshold" });
});

test("threshold 0 or undefined never fires", async () => {
	for (const thresholdMs of [0, undefined]) {
		const outcome = await raceForeground(delay(20, "ok"), { interrupt: never, thresholdMs });
		assert.equal(outcome.kind, "settled");
	}
});

test("rejection before any interrupt propagates unchanged", async () => {
	const error = new Error("Command aborted");
	await assert.rejects(raceForeground(Promise.reject(error), { interrupt: never, thresholdMs: 1000 }), error);
});

test("Interrupts releases every registered waiter once and forgets disposed ones", async () => {
	const interrupts = new Interrupts();
	const a = interrupts.register();
	const b = interrupts.register();
	b.dispose();
	assert.equal(interrupts.size, 1);
	interrupts.fire();
	await a.promise;
	assert.equal(interrupts.size, 0);
});

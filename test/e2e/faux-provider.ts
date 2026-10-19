// Test-only provider: deterministic scripted model driven by PI_BY_SCRIPT.
// Turn 1 emits tool calls; later turns describe what the model received.
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function describe(context: { messages: any[] }): string {
	const tail = context.messages.filter((m) => m.role !== "system").slice(-6);
	return JSON.stringify(
		tail.map((m) => ({
			role: m.role,
			text: (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text.slice(0, 160))
				.join("|"),
			images: Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "image").length : 0,
		})),
	);
}

export default function (pi: ExtensionAPI) {
	const core = createFauxCore({ provider: "faux", api: "faux-api", models: [{ id: "m", input: ["text", "image"] }] });
	const script = process.env.PI_BY_SCRIPT ?? "sleep 300; echo done";
	const withRead = process.env.PI_BY_PARALLEL_SLEEP;
	let turn = 0;
	const step = (context: any) => {
		turn++;
		if (turn === 1) {
			const calls = [fauxToolCall("bash", { command: script })];
			if (withRead) calls.push(fauxToolCall("bash", { command: `sleep ${withRead}; echo parallel-done` }));
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`TURN${turn} CONTEXT ${describe(context)}`));
	};
	core.setResponses(Array.from({ length: 20 }, () => step));
	pi.registerProvider("faux", {
		baseUrl: "http://localhost",
		apiKey: "faux",
		api: core.api as any,
		models: [{ id: "m", name: "m", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: core.streamSimple as any,
	});
}

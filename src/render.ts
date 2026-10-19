// TUI-only presentation. Nothing here reaches the model: it reads tool-result and message `details`.
import {
	type AgentToolResult,
	keyHint,
	type MessageRenderer,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

// ToolRenderContext is not exported from the package root; take it from ToolDefinition.
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";
import { backgroundMarker } from "./format.ts";
import type { JobStatus } from "./jobs.ts";

/** `details` of a bash result that moved to the background. */
export interface BackgroundedDetails {
	backgrounded: { jobId: string; reason: "steer" | "threshold" | "requested"; thresholdMs: number; output: string };
}

/** Per-job summary carried in a completion notice's `details`. */
export interface NoticeJob {
	id: string;
	status: JobStatus;
	line: string;
	output: string;
}

/** `details` of a completion notice. `jobs` (ids) is what delivery tracking reads. */
export interface NoticeDetails {
	jobs: string[];
	summary?: NoticeJob[];
}

function backgroundedOf(details: unknown): BackgroundedDetails["backgrounded"] | undefined {
	const value = (details as Partial<BackgroundedDetails> | undefined)?.backgrounded;
	return value && typeof value.jobId === "string" ? value : undefined;
}

// The wrapped renderer is bash's, typed with bash's details/state/args; ours is registered for the same tool.
// biome-ignore lint/suspicious/noExplicitAny: bivariant on purpose, see above
type RenderResult = (result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme, context: any) => Component;

/**
 * Wraps the built-in bash `renderResult`: a backgrounded result shows its partial output with the
 * built-in preview, then a marker line the 5-line collapsed preview cannot cut off.
 */
export function backgroundAwareRenderResult(builtin: RenderResult): RenderResult {
	return (result, options, theme, context: ToolRenderContext) => {
		const bg = backgroundedOf(result.details);
		if (!bg) return builtin(result, options, theme, context);
		const partial: AgentToolResult<undefined> = { content: [{ type: "text", text: bg.output }], details: undefined };
		const container = new Container();
		container.addChild(builtin(partial, options, theme, { ...context, lastComponent: undefined }));
		container.addChild(new Text(`\n${theme.fg("accent", backgroundMarker(bg.jobId, bg.reason, bg.thresholdMs))}`, 0, 0));
		return container;
	};
}

const ICON: Record<JobStatus, [string, "success" | "error" | "warning" | "muted"]> = {
	succeeded: ["✓", "success"],
	failed: ["✗", "error"],
	killed: ["⊘", "warning"],
	running: ["⏵", "muted"],
};

/** Completion notice: one line per job when collapsed, each job's output when expanded. */
export const noticeRenderer: MessageRenderer<NoticeDetails> = (message, { expanded, outputPad }, theme) => {
	const summary = message.details?.summary;
	if (!Array.isArray(summary)) return undefined; // older sessions: pi's default rendering
	const lines: string[] = [];
	for (const job of summary) {
		const [icon, color] = ICON[job.status] ?? ICON.failed;
		lines.push(`${theme.fg(color, icon)} ${job.line}`);
		if (expanded) {
			const output = job.output.trimEnd() || "(no output)";
			lines.push(...output.split("\n").map((l) => theme.fg("toolOutput", l)), "");
		}
	}
	if (expanded) lines.pop();
	else lines.push(theme.fg("muted", "(") + keyHint("app.tools.expand", "to show output") + theme.fg("muted", ")"));
	const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(lines.join("\n"), 0, 0));
	return box;
};

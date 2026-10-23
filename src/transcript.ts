/**
 * Transcript excerpt for the autopilot judge.
 *
 * The judge needs to know what the run was doing when it asked. It does not
 * need the whole session, a tool-result dump, or the system prompt. This module
 * turns session entries into a bounded, labelled excerpt: newest-first budget,
 * per-message caps, and no I/O.
 */

const PER_MESSAGE_CHARS = 1500;
const THINKING_CHARS = 400;
const TOOL_RESULT_CHARS = 300;

export interface TailEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		command?: unknown;
		exitCode?: unknown;
		summary?: unknown;
	};
}

function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	let out = "";
	for (const block of asArray(content)) {
		if (block?.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}

export function compact(text: string, max: number): string {
	const trimmed = text.replace(/\s+$/g, "");
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…(${trimmed.length - max} chars omitted)`;
}

function formatEntry(entry: TailEntry): string {
	const message = entry.message;
	if (message === undefined) return "";
	switch (message.role) {
		case "user": {
			const text = compact(textOf(message.content), PER_MESSAGE_CHARS);
			return text.length > 0 ? `[user] ${text}` : "";
		}
		case "assistant": {
			const parts: string[] = [];
			for (const block of asArray(message.content)) {
				if (block?.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				} else if (block?.type === "thinking") {
					parts.push(`[thinking] ${compact(String(block.thinking ?? ""), THINKING_CHARS)}`);
				} else if (block?.type === "toolCall") {
					const args = compact(JSON.stringify(block.arguments ?? {}), 200);
					parts.push(`[tool call ${String(block.name)}(${args})]`);
				}
			}
			if (parts.length === 0) return "";
			return `[assistant] ${compact(parts.join("\n"), PER_MESSAGE_CHARS)}`;
		}
		case "toolResult": {
			const text = compact(textOf(message.content), TOOL_RESULT_CHARS);
			return text.length > 0 ? `[tool result] ${text}` : "";
		}
		case "compactionSummary":
		case "branchSummary":
			return `[summary] ${compact(String(message.summary ?? ""), 600)}`;
		case "bashExecution":
			return `[user ran] ${compact(String(message.command ?? ""), 200)} -> exit ${String(message.exitCode)}`;
		default:
			return "";
	}
}

/**
 * Build the excerpt handed to the judge. The budget is spent newest-first, so
 * the turns closest to the question always survive truncation.
 */
export function buildTranscript(
	entries: readonly TailEntry[],
	options: { tailMessages: number; maxTailChars: number },
): string {
	const newestFirst: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		if (newestFirst.length >= options.tailMessages) break;
		const entry = entries[i];
		if (entry === undefined) continue;
		const formatted = formatEntry(entry);
		if (formatted.length > 0) newestFirst.push(formatted);
	}
	const text = newestFirst.reverse().join("\n\n");
	return compact(text, options.maxTailChars);
}

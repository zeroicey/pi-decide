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
 * Build the excerpt handed to the judge.
 *
 * The budget is spent newest-first, so the turns closest to the question are
 * the ones that survive truncation. The character cap is enforced *while*
 * collecting, newest before oldest: an older turn that does not fit is
 * dropped whole — or, when it is the newest turn that does not fit, truncated
 * to what is left — never the other way around, which is what a plain
 * end-truncation of the joined text did: it cut from the chronological tail,
 * i.e. from the newest turns, and left the judge with the beginning of the
 * conversation and none of the context that produced the question.
 */
export function buildTranscript(
	entries: readonly TailEntry[],
	options: { tailMessages: number; maxTailChars: number },
): string {
	// The "\n\n" that joins two entries; charged against the budget so the
	// joined text can never exceed the cap by more than one omission marker.
	const SEPARATOR_CHARS = 2;
	const newestFirst: string[] = [];
	let remaining = options.maxTailChars;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (newestFirst.length >= options.tailMessages) break;
		const entry = entries[i];
		if (entry === undefined) continue;
		const formatted = formatEntry(entry);
		if (formatted.length === 0) continue;
		if (remaining <= 0) break;
		if (formatted.length + SEPARATOR_CHARS <= remaining) {
			newestFirst.push(formatted);
			remaining -= formatted.length + SEPARATOR_CHARS;
			continue;
		}
		// This entry does not fit, and it is the newest one not yet included.
		// The budget is spent on it and everything older is dropped: reserving
		// the remainder for an earlier turn would let a newer message vanish,
		// which is exactly the inversion a newest-first budget exists to
		// prevent. The marker in the piece says how much of *this* entry was
		// lost, which is the number a reader of the excerpt can act on.
		newestFirst.push(compact(formatted, remaining));
		break;
	}
	return newestFirst.reverse().join("\n\n");
}

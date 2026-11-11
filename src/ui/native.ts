/**
 * The `custom()`-free path for hosts that show Pi dialogs but cannot render a
 * component.
 *
 * RPC hosts (T3 Code, and any other remote UI driving `pi --mode rpc`) answer
 * `ui.custom()` with `undefined` immediately — Pi documents that a component
 * factory is ignored outside the terminal. What they *do* render is Pi's own
 * primitives: `ui.select()` / `ui.input()` become a native prompt card in their
 * UI. So on those hosts the questionnaire is asked one question at a time
 * through `ui.select()`.
 *
 * What survives the translation: option order, option descriptions folded into
 * the labels, the recommendation, free-text answers (hosts such as T3 render an
 * extra "type your own" row), and the deadline — passed down as `opts.timeout`
 * so the host itself dismisses the prompt.
 *
 * What does not: per-question notes, the Submit/review tab, full previews (only
 * a short excerpt is folded into the prompt), and multi-select as a single
 * screen. Multi-select becomes a toggle loop that ends on a Done row: still one
 * tap per choice, just several prompts.
 *
 * Nothing here decides policy — the caller has already resolved that a human
 * should be asked, and what to do when nobody answers.
 */

import type { Question, Questionnaire } from "../types.ts";
import type { DialogAnswer, DialogOutcome } from "./dialog.ts";

/** The only Pi primitive this path needs. Structurally satisfied by `ctx.ui`. */
export interface NativePrompter {
	select(
		title: string,
		options: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<string | undefined>;
}

/** The row that ends a multi-select toggle loop. */
export const DONE_LABEL = "✅ Done";

/** Markers the loop uses so a human can see what is already selected. */
const SELECTED_MARK = "✅";
const UNSELECTED_MARK = "◻";

/** Long previews would crowd the prompt card; keep the shape, drop the bulk. */
const MAX_PREVIEW_CHARS = 280;

export interface NativeAskOptions {
	signal?: AbortSignal;
	deadlineKind?: "auto" | "deadline";
	/** Clock seam: tests (and callers that already own a deadline) supply one. */
	now?: () => number;
}

interface Choice {
	/** The authored option label, which is what the answer records. */
	value: string;
	/** What this prompt row shows — the label plus whatever marking it carries. */
	display: string;
}

/** One prompt's result, before it is turned into a dialog answer. */
type Step =
	| { kind: "value"; value: string }
	| { kind: "expired" }
	| { kind: "dismissed" };

function truncate(text: string, limit: number): string {
	const collapsed = text.trim().replace(/\r\n/g, "\n");
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The prompt text for one question.
 *
 * Hosts show this string twice (once as the card's header chip, once as the
 * question body), so it opens with the question itself and keeps the rest short:
 * the recommendation, then any preview excerpt the option list could not carry.
 */
export function nativeTitle(question: Question, position: { index: number; total: number }): string {
	const parts: string[] = [question.question];

	if (question.recommended !== undefined) {
		const because = question.recommendedBecause?.trim();
		parts.push(`Recommended: ${question.recommended}${because ? ` — ${because}` : ""}`);
	}

	const previews = question.options
		.filter((option) => option.preview !== undefined && option.preview.trim().length > 0)
		.map((option) => `Preview — ${option.label}:\n${truncate(option.preview ?? "", MAX_PREVIEW_CHARS)}`);
	if (previews.length > 0) parts.push(...previews);

	if (question.multiSelect) {
		parts.push(
			`Select every choice that applies, then ${DONE_LABEL}. Each tap asks again with what you picked marked ${SELECTED_MARK}.`,
		);
	} else {
		parts.push("Pick one, or type your own answer.");
	}

	if (position.total > 1) parts.push(`(${position.index + 1} of ${position.total})`);

	return parts.join("\n\n");
}

/** One prompt row per option, with the recommendation marked on its label. */
function singleChoices(question: Question): Choice[] {
	return question.options.map((option) => ({
		value: option.label,
		display: question.recommended === option.label ? `${option.label} ★ recommended` : option.label,
	}));
}

/**
 * Ask one questionnaire through native prompts.
 *
 * Resolves with the same `DialogOutcome` the terminal dialog produces, so the
 * tool's envelope code does not care which host answered.
 */
export async function askNatively(
	prompter: NativePrompter,
	questionnaire: Questionnaire,
	timeoutSeconds: number,
	options: NativeAskOptions = {},
): Promise<DialogOutcome> {
	const clock = options.now ?? Date.now;
	const startedAt = clock();
	const deadline = timeoutSeconds > 0 ? startedAt + timeoutSeconds * 1000 : undefined;
	const elapsedSeconds = () => Math.max(0, Math.round((clock() - startedAt) / 1000));

	/**
	 * A prompt the host itself cancels (timeout / dismiss) resolves `undefined`,
	 * exactly like a deadline. Which one it was is only knowable from the clock:
	 * at the deadline the promise is a timeout, well before it is a dismiss.
	 */
	const explainUndefined = (): Step => {
		if (deadline === undefined) return { kind: "dismissed" };
		const left = deadline - clock();
		return left <= 1000 ? { kind: "expired" } : { kind: "dismissed" };
	};

	const ask = async (title: string, rows: string[]): Promise<Step> => {
		if (deadline !== undefined && clock() >= deadline) return { kind: "expired" };
		const answer = await prompter.select(title, rows, {
			...(deadline !== undefined ? { timeout: Math.max(1, deadline - clock()) } : {}),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		if (answer === undefined) return explainUndefined();
		// A host may hand back the row exactly as it rendered it; strip padding and
		// keep the raw string otherwise, because a custom answer is free text.
		const trimmed = answer.trim();
		return { kind: "value", value: trimmed.length > 0 ? trimmed : answer };
	};

	const answers = new Map<number, DialogAnswer>();

	for (let index = 0; index < questionnaire.questions.length; index += 1) {
		const question = questionnaire.questions[index]!;
		const title = nativeTitle(question, { index, total: questionnaire.questions.length });

		if (!question.multiSelect) {
			const choices = singleChoices(question);
			const step = await ask(title, choices.map((choice) => choice.display));
			if (step.kind === "expired") return { kind: "autopilot", waitedSeconds: elapsedSeconds() };
			if (step.kind === "dismissed") return { kind: "cancelled" };
			const matched = choices.find((choice) => choice.display === step.value || choice.value === step.value);
			answers.set(
				index,
				matched !== undefined ? { selected: [matched.value] } : { selected: [], text: step.value },
			);
			continue;
		}

		// Multi-select: one tap per choice, then Done. The loop is bounded by the
		// option count so a host that never returns Done cannot spin forever.
		const picked: string[] = [];
		let freeText: string | undefined;
		for (let round = 0; round <= question.options.length + 1; round += 1) {
			const rows: Choice[] = question.options.map((option) => ({
				value: option.label,
				display: `${picked.includes(option.label) ? SELECTED_MARK : UNSELECTED_MARK} ${option.label}`,
			}));
			rows.push({ value: DONE_LABEL, display: DONE_LABEL });

			const step = await ask(title, rows.map((choice) => choice.display));
			if (step.kind === "expired") return { kind: "autopilot", waitedSeconds: elapsedSeconds() };
			if (step.kind === "dismissed") return { kind: "cancelled" };
			if (step.value === DONE_LABEL) break;

			// Rows come back either as rendered (marked) or as the bare label; both
			// toggle. Anything else is a typed answer, which ends the toggle list.
			const row = rows.find((choice) => choice.display === step.value) ?? rows.find((choice) => choice.value === step.value);
			if (row === undefined) {
				freeText = step.value;
				break;
			}
			if (row.value === DONE_LABEL) break;
			if (picked.includes(row.value)) picked.splice(picked.indexOf(row.value), 1);
			else picked.push(row.value);
		}

		if (picked.length > 0 || freeText !== undefined) {
			// Authored order, so the envelope reads the same as a terminal answer.
			const ordered = question.options
				.map((option) => option.label)
				.filter((label) => picked.includes(label));
			answers.set(index, {
				selected: ordered,
				...(freeText !== undefined ? { text: freeText } : {}),
			});
		}
	}

	if (answers.size === 0) return { kind: "cancelled" };
	return { kind: "answered", answers };
}

/**
 * The answer envelope: what the model reads back.
 *
 * Two audiences, two shapes. `content` is the text the model consumes, written
 * so an unattended resolution is impossible to miss ("autopilot answered these
 * on the user's behalf"). `details` is structured state for rendering and for
 * programmatic callers.
 */

import type { Answer, DecisionResult, Questionnaire } from "../types.ts";

export interface ToolDetails {
	outcome: DecisionResult["outcome"];
	answers: Answer[];
	unanswered: string[];
	reason?: string;
	globalNote?: string;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ToolDetails;
	isError?: boolean;
}

function answerLine(answer: Answer): string {
	const parts: string[] = [];
	if (answer.selected.length > 0) {
		parts.push(answer.selected.map((label) => `"${label}"`).join(", "));
	}
	if (answer.text !== undefined && answer.text.length > 0) {
		const quoted = answer.text.replace(/\n/g, "\n      ");
		parts.push(answer.selected.length > 0 ? `plus: ${quoted}` : quoted);
	}
	if (parts.length === 0) parts.push("(no answer)");
	const prose = parts.join(" ");
	const tags: string[] = [];
	if (answer.source !== "user") tags.push(answer.source);
	if (answer.source === "timeout" && answer.waitedSeconds !== undefined) {
		tags.push(`after ${answer.waitedSeconds}s`);
	}
	const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
	const note =
		answer.note !== undefined && answer.note.length > 0 ? `\n      user note: ${answer.note}` : "";
	return `- ${answer.header}: ${prose}${suffix}${note}`;
}

/** Render the resolution for the model. */
export function formatResult(result: DecisionResult, questionnaire: Questionnaire): string {
	const header: string[] = [];
	switch (result.outcome) {
		case "autopilot":
			header.push(
				`These answers were chosen by the autopilot, not by the user: ${
					result.reason ?? "nobody was available"
				}.`,
			);
			header.push(
				"The user did not see these questions and did not confirm these choices. Proceed on your own judgement; if the choice turns out to be unrecoverable, say so plainly in your final report instead of silently assuming it was approved.",
			);
			break;
		case "timeout":
			// Two flavours, and the difference matters to the reader: `auto` was a
			// delay the user chose, `deadline` fired because nobody was there.
			header.push(
				`Nobody answered the dialog (${result.reason ?? "the countdown expired"}), so the autopilot answered.`,
			);
			header.push(
				"The user did not see these questions and did not confirm these choices. Continue, but say in your final report which decisions were assumed rather than approved.",
			);
			break;
		case "cancelled":
			header.push(
				"The user cancelled the questionnaire. These questions were NOT answered — do not treat the cancellation as agreement, and do not re-ask the same questions immediately. Either proceed with a reasonable default (say which) or stop and explain what you need.",
			);
			break;
		case "refused":
			header.push(
				`The autopilot REFUSED to answer: ${result.reason ?? "an irreversible decision needs a human"}.`,
			);
			header.push(
				"These questions involve something that cannot be undone and offer no cautious option, so nobody was willing to decide on the user's behalf. Do NOT pick one yourself and do NOT proceed as if it were answered. Stop this line of work, finish whatever is safe to finish, and report clearly that this decision is blocked on the user.",
			);
			break;
		case "rejected":
			header.push(
				`The questionnaire was rejected before it was shown: ${result.reason ?? "no reason given"}. Nothing was asked, so do not treat this as an answer.`,
			);
			break;
		case "answered":
			break;
	}

	const refusedHeaders = new Set(result.refused?.map((item) => item.header) ?? []);
	const answered = result.answers.filter(
		(answer) => answer.source !== "abandoned" && !refusedHeaders.has(answer.header),
	);
	const lines = [...header];
	if (lines.length > 0) lines.push("");
	if (answered.length > 0) {
		lines.push("Answers:");
		for (const answer of answered) lines.push(answerLine(answer));
	}
	if (result.unanswered.length > 0) {
		lines.push("", `Unanswered: ${result.unanswered.join(", ")}`);
	}
	if (result.guarded !== undefined && result.guarded.length > 0) {
		lines.push(
			"",
			`Safety rail: ${result.guarded
				.map((item) => `${item.header} was steered to the cautious option "${item.chose}"`)
				.join("; ")} (these decisions cannot be undone).`,
		);
	}
	if (result.globalNote !== undefined && result.globalNote.length > 0) {
		lines.push("", `Global note: ${result.globalNote}`);
	}

	// Guard against a silent empty answer: the model must never be handed "".
	if (lines.length === 0) {
		lines.push("No answers were produced by the questionnaire.");
	}
	return lines.join("\n");
}

export function buildResult(
	result: DecisionResult,
	questionnaire: Questionnaire,
	options: { isError?: boolean } = {},
): ToolResult {
	return {
		content: [{ type: "text", text: formatResult(result, questionnaire) }],
		details: {
			outcome: result.outcome,
			answers: result.answers,
			unanswered: result.unanswered,
			...(result.reason !== undefined ? { reason: result.reason } : {}),
			...(result.globalNote !== undefined ? { globalNote: result.globalNote } : {}),
		},
		...(options.isError === true ? { isError: true } : {}),
	};
}

/** A rejection raised before any UI existed, with a model-facing explanation. */
export function rejected(questionnaire: Questionnaire | undefined, reason: string, isError = false): ToolResult {
	const header = questionnaire?.questions.map((question) => question.header) ?? [];
	return buildResult(
		{ answers: [], outcome: "rejected", reason, unanswered: header },
		questionnaire ?? { questions: [] },
		{ isError },
	);
}

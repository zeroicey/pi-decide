/**
 * Argument validation.
 *
 * Model-authored questionnaires are untrusted input. Validation runs before any
 * UI is built, and it normalises rather than merely rejecting: trailing
 * punctuation is stripped from labels, a `recommended` that does not match an
 * option is dropped (with a warning the caller can surface), and duplicate
 * labels are rejected because the answer envelope would be ambiguous.
 */

import type { Limits } from "../config.ts";
import type { Option, Question, Questionnaire } from "../types.ts";

export type ValidationErrorName =
	| "no_questions"
	| "too_many_questions"
	| "too_few_options"
	| "too_many_options"
	| "empty_label"
	| "duplicate_label"
	| "empty_description"
	| "empty_header"
	| "reserved_label"
	/** A field had the wrong type — the model sent junk rather than a bad questionnaire. */
	| "malformed";

export interface ValidationError {
	ok: false;
	error: ValidationErrorName;
	message: string;
}

export interface ValidationOk {
	ok: true;
	questionnaire: Questionnaire;
	/** Non-fatal problems that were repaired instead of rejected. */
	warnings: string[];
}

export type Validation = ValidationOk | ValidationError;

/** Labels the runtime appends itself; authoring one would produce two identical rows. */
export const RESERVED_LABELS = ["other", "type something", "type something."] as const;

/** Thrown internally so each check can read as one line. Never escapes the module. */
class Reject extends Error {
	constructor(
		readonly errorName: ValidationErrorName,
		message: string,
	) {
		super(message);
		this.name = "Reject";
	}
}

function normalizeLabel(label: string): string {
	return label.trim().replace(/[\s\u00a0]+/g, " ");
}

function build(raw: Questionnaire, limits: Limits): ValidationOk {
	const questions = raw.questions ?? [];
	if (questions.length === 0) {
		throw new Reject("no_questions", "At least one question is required.");
	}
	if (questions.length > limits.maxQuestions) {
		throw new Reject(
			"too_many_questions",
			`At most ${limits.maxQuestions} questions are allowed per invocation (got ${questions.length}). Split them across calls.`,
		);
	}

	const warnings: string[] = [];
	const out: Question[] = [];

	questions.forEach((question, questionIndex) => {
		const at = `question ${questionIndex + 1}`;
		const header = normalizeLabel(question.header ?? "");
		if (header.length === 0) {
			throw new Reject("empty_header", `${at}: header must not be empty.`);
		}

		const options = question.options ?? [];
		if (options.length < 2) {
			throw new Reject("too_few_options", `${at}: needs at least 2 options (got ${options.length}).`);
		}
		if (options.length > limits.maxOptions) {
			throw new Reject(
				"too_many_options",
				`${at}: at most ${limits.maxOptions} options are allowed (got ${options.length}).`,
			);
		}

		const seen = new Set<string>();
		const built: Option[] = [];
		for (const option of options) {
			const label = normalizeLabel(option.label ?? "");
			if (label.length === 0) {
				throw new Reject("empty_label", `${at}: every option needs a non-empty label.`);
			}
			const folded = label.toLowerCase();
			if ((RESERVED_LABELS as readonly string[]).includes(folded)) {
				throw new Reject(
					"reserved_label",
					`${at}: "${label}" is reserved — the "Type something." row is appended automatically.`,
				);
			}
			if (seen.has(folded)) {
				throw new Reject("duplicate_label", `${at}: duplicate option label "${label}".`);
			}
			seen.add(folded);
			const description = (option.description ?? "").trim();
			if (description.length === 0) {
				throw new Reject("empty_description", `${at}: option "${label}" needs a description.`);
			}
			built.push({
				label,
				description,
				...(typeof option.preview === "string" && option.preview.length > 0 ? { preview: option.preview } : {}),
			});
		}

		let recommended = question.recommended === undefined ? undefined : normalizeLabel(question.recommended);
		if (recommended !== undefined) {
			const match = built.find((option) => option.label.toLowerCase() === recommended?.toLowerCase());
			if (match === undefined) {
				warnings.push(`${at}: recommended "${recommended}" matches no option — ignored`);
				recommended = undefined;
			} else {
				recommended = match.label;
			}
		}

		out.push({
			question: (question.question ?? "").trim(),
			header,
			...(question.category !== undefined && question.category.trim().length > 0
				? { category: question.category.trim() }
				: {}),
			options: built,
			...(question.multiSelect === true ? { multiSelect: true } : {}),
			...(recommended !== undefined ? { recommended } : {}),
			...(recommended !== undefined && question.recommendedBecause !== undefined
				? { recommendedBecause: question.recommendedBecause.trim() }
				: {}),
			...(question.irreversible === true ? { irreversible: true } : {}),
		});
	});

	return {
		ok: true,
		warnings,
		questionnaire: {
			questions: out,
			...(typeof raw.context === "string" && raw.context.trim().length > 0 ? { context: raw.context.trim() } : {}),
			...(raw.mode === "ask" || raw.mode === "auto" ? { mode: raw.mode } : {}),
		},
	};
}

/** Validate a raw tool argument object into a normalised questionnaire. */
export function validateQuestionnaire(raw: Questionnaire, limits: Limits): Validation {
	try {
		return build(raw, limits);
	} catch (error) {
		if (error instanceof Reject) {
			return { ok: false, error: error.errorName, message: `Error: ${error.message}` };
		}
		// A thrown non-Reject is a type error deep inside normalization (a label
		// that is not a string, an options array holding null). Reporting that as
		// `no_questions` sent the model chasing the wrong fix, and echoing the raw
		// TypeError told it nothing useful. Name the real problem instead.
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: "malformed",
			message: `Error: the questionnaire arguments are malformed — every question needs a string header, and every option needs a string label and description. (${detail})`,
		};
	}
}

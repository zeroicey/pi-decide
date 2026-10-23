/**
 * Shared domain types.
 *
 * Everything in this file is host-free: no pi imports, no TUI imports. The
 * engine (`policy.ts`, `recommend.ts`, `decide.ts`, `validate.ts`) is driven by
 * these shapes so the whole decision layer is testable without a Pi process or
 * a model call.
 */

/** How an answer to a question was produced. */
export type AnswerSource = "user" | "autopilot" | "timeout" | "abandoned";

/** One authored choice on a question. */
export interface Option {
	/** Human-facing display text. */
	label: string;
	/** What the choice means or costs. */
	description: string;
	/** Optional markdown artifact shown beside the option list. */
	preview?: string;
}

/** One question in a questionnaire. */
export interface Question {
	question: string;
	/** Short chip / category tag shown in the tab bar. */
	header: string;
	/** Optional wider category, used for grouping in the summary. */
	category?: string;
	options: Option[];
	/** Allow more than one choice. */
	multiSelect?: boolean;
	/** Label of the option the model would pick. Must match an option label. */
	recommended?: string;
	/** Why the recommendation, in a few words. Shown to the user and logged. */
	recommendedBecause?: string;
}

/** What the model asked for. This is the tool's validated argument shape. */
export interface Questionnaire {
	questions: Question[];
	/** The model's own one-line statement of what it is trying to decide. */
	context?: string;
	/** Per-call override of the global autopilot policy. */
	mode?: "ask" | "auto";
}

/** A resolved answer to one question. */
export interface Answer {
	/** Index into `Questionnaire.questions`. */
	index: number;
	header: string;
	question: string;
	/** Selected option labels, in authored order. Empty when free-text only. */
	selected: string[];
	/** Free-text answer, when the user/model typed one. */
	text?: string;
	source: AnswerSource;
	/** Free-text note attached to this answer. */
	note?: string;
	/** Seconds the dialog waited before this answer was produced by `timeout`. */
	waitedSeconds?: number;
}

/** The complete outcome of one `ask_user_question` call. */
export interface DecisionResult {
	answers: Answer[];
	/** How the invocation resolved. */
	outcome: "answered" | "autopilot" | "timeout" | "cancelled" | "rejected";
	/** One-line reason for autopilot/timeout resolutions. */
	reason?: string;
	/** Free-text note attached to the whole questionnaire. */
	globalNote?: string;
	/** Questions that never got an answer (cancelled/rejected paths). */
	unanswered: string[];
}

/** The resolved autopilot behaviour for one invocation. */
export type PolicyMode = "off" | "on" | "auto";

export interface Policy {
	mode: PolicyMode;
	/**
	 * Seconds the dialog waits before answering itself. `0` disables the
	 * countdown (wait forever). Only meaningful when `mode === "auto"`.
	 */
	timeoutSeconds: number;
	/** Play a terminal BEL when the dialog starts waiting on a human. */
	bell: boolean;
	/** Where the resolved policy came from, for the footer and the transcript. */
	source: "config" | "per-call" | "flag" | "default";
}

/** One graded recommendation from the autopilot judge. */
export interface Recommendation {
	questionIndex: number;
	/** Chosen option labels, in authored order. Empty when the judge chose free text. */
	selected: string[];
	/** Free-text answer, when no authored option fits or the question is multi-select. */
	text?: string;
	/** Why this is the best available answer. */
	reason: string;
}

/** The autopilot judge's whole verdict. */
export interface AutopilotVerdict {
	recommendations: Recommendation[];
	/** One line summarising the shape of the whole decision. */
	summary: string;
}

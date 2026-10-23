/**
 * Safety rails for irreversible questions.
 *
 * "Never block" must not be read as "always act". Some decisions have a blast
 * radius the user cannot take back — dropping a table, force-pushing, spending
 * money, publishing. An autopilot answering one of those on the user's behalf,
 * unattended, is the worst thing this extension could do.
 *
 * Two layers, cheapest first:
 *
 * 1. **The model's own declaration** (`irreversible: true` on a question).
 * 2. **A conservative text scan** over the question, option labels and
 *    descriptions. This is the layer that actually protects, because a model
 *    that forgot to declare it still has to write "force push" somewhere.
 *
 * When a question trips either layer, the autopilot may only choose an option
 * whose text reads as the cautious path (abort / keep / backup first). If no
 * such option exists, the invocation is refused with an envelope telling the
 * model to stop and ask a human — a stuck-but-safe run beats a fast destructive
 * one.
 */

import type { Question, Questionnaire } from "./types.ts";

/** Verbs and phrases that imply an effect the user cannot undo. */
const IRREVERSIBLE_PATTERNS: readonly RegExp[] = [
	/\brm\s+-[a-z]*[rf]/i,
	/\bdelet(e|ing|ion)\b/i,
	/\bdrop(ping)?\b/i,
	/\btruncat(e|ing)\b/i,
	/\bforce[- ]?push/i,
	/\bpush\s+(--force|-f)\b/i,
	/\breset\s+--hard\b/i,
	/\boverwrit(e|ing)\b/i,
	/\bdestroy(s|ed|ing)?\b/i,
	/\bwipe\b/i,
	/\bpurge\b/i,
	/\brevoke\b/i,
	/\brotat(e|ing)\s+(the\s+)?(\w+\s+){0,2}(key|secret|credentials?|password|token)s?\b/i,
	/\bpublish\b/i,
	/\bdeploy\s+to\s+prod/i,
	/\breleas(e|ing)\s+to\s+prod/i,
	/\bspend(s|ing)?\b/i,
	/\bcharg(e|ing)\b/i,
	/\bbill(ing)?\b/i,
	/\bcost(s|ing)?\s+money/i,
	/\btransfer\s+funds/i,
	/\brm\s+i\b/i,
];

/** Wording that reads as the cautious path. */
const CONSERVATIVE_PATTERNS: readonly RegExp[] = [
	/\babort\b/i,
	/\bcancel\b/i,
	/\bskip\b/i,
	/\bkeep\b/i,
	/\bpreserve\b/i,
	/\bback\s?up\b/i,
	/\bno[- ]?op\b/i,
	/\bdo\s+nothing\b/i,
	/\bdo\s+not\b/i,
	/\bdon't\b/i,
	/\bwithout\b/i,
	/\bwait\b/i,
	/\bask\b/i,
	/\breview\s+first\b/i,
	/\bdry[- ]?run\b/i,
	/\bnot\s+(yet|now)\b/i,
];

export function looksIrreversible(text: string): boolean {
	return IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A negated cautious word is not a cautious choice.
 *
 * "no backup", "without a dump", "don't keep it" read as the *irreversible*
 * path. Treating them as conservative is how a destructive option sneaks past
 * the rail: every option whose description mentions the safety it is skipping
 * would test as safe, and the guard would then have nothing to steer toward.
 */
const NEGATED_CONSERVATIVE =
	/\b(no|not|without|n't|never|lack\s+of)\b[^.!?]{0,24}?\b(back\s?up|keep|preserve|wait|review|dry[- ]?run|dump)\b/i;

export function looksConservative(text: string): boolean {
	// "Do not delete anything" is cautious *because* of the negation of the
	// destructive verb — that is a different shape from "no backup".
	if (/\b(do\s+not|don't|without)\b[^.!?]{0,24}?\b(delete|drop|force|publish|overwrite|wipe|purge|remove)/i.test(text)) {
		return true;
	}
	if (NEGATED_CONSERVATIVE.test(text)) return false;
	return CONSERVATIVE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Everything a user would read about this decision. */
function questionText(question: Question): string {
	const parts = [question.question, question.header, question.category ?? ""];
	for (const option of question.options) parts.push(option.label, option.description);
	return parts.join("\n");
}

/**
 * Whether a question needs a human, whatever the policy says.
 *
 * Deliberately errs toward "yes": a false positive costs a stuck run, and a
 * false negative can cost the user's data.
 */
export function needsHuman(question: Question): boolean {
	if (question.irreversible === true) return true;
	return looksIrreversible(questionText(question));
}

export interface IrreversibleFinding {
	questionIndex: number;
	header: string;
	/** The cautious options available, if any. */
	conservativeOptions: string[];
}

/** Every question that must not be auto-answered, and what it may pick from. */
export function findIrreversible(questionnaire: Questionnaire): IrreversibleFinding[] {
	const findings: IrreversibleFinding[] = [];
	questionnaire.questions.forEach((question, index) => {
		if (!needsHuman(question)) return;
		findings.push({
			questionIndex: index,
			header: question.header,
			conservativeOptions: question.options
				.filter((option) => looksConservative(`${option.label}\n${option.description}`))
				.map((option) => option.label),
		});
	});
	return findings;
}

/**
 * Guard a chosen answer against its question's safety rail.
 *
 * Returns the label to use instead, or `undefined` when the choice was already
 * the cautious one. When `conservativeOptions` is empty the caller must refuse
 * the whole invocation rather than guess — that case returns `null`.
 */
export function guardChoice(question: Question, chosen: readonly string[]): string | undefined | null {
	if (!needsHuman(question)) return undefined;
	const conservative = question.options
		.filter((option) => looksConservative(`${option.label}\n${option.description}`))
		.map((option) => option.label);
	if (conservative.length === 0) return null;
	const alreadySafe = chosen.every((label) => conservative.includes(label));
	return alreadySafe ? undefined : conservative[0];
}

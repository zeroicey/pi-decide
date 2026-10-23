/**
 * The autopilot judge: one model call that answers the questionnaire on the
 * user's behalf, with graded fallbacks so a drifting model can never turn an
 * unattended run into a hang or a crash.
 *
 * The completion function is injected, so this module stays host-free. That is
 * what lets the whole autopilot path be tested without a provider.
 */

import { compact } from "./transcript.ts";
import type { Answer, AutopilotVerdict, Question, Questionnaire, Recommendation } from "./types.ts";

/** The default judge prompt. */
export const DEFAULT_JUDGE_PROMPT = `You are the autopilot for "pi", a terminal coding agent that is running unattended.

The agent stopped to ask the human a set of structured questions. Nobody is
available — the user is asleep, away, or simply not watching. Your job is to
answer exactly as a competent, conservative senior engineer who owns this
codebase would: pick the option that most helps the stated task succeed, then
say why in one short line.

Judge by meaning. The conversation and the questions may be in any language.

Hard rules:
1. Answer EVERY question, in the order given. Never leave one out.
2. Prefer an authored option. Its label must be copied VERBATIM (character for
   character) into "selected".
3. When the question says the model recommended an option, that recommendation
   is your default. Override it only when the conversation clearly shows the
   recommendation is wrong, and say so in "reason".
4. If no authored option is defensible, put your answer in "text" and leave
   "selected" empty. Say why.
5. For multi-select questions, return every option that genuinely applies, in
   the authored order. Do not pad the list.
6. Prefer the choice that is reversible, cheap, and does not destroy data,
   spend money, publish anything, or delete work without a backup. When two
   options are otherwise equal, prefer the smaller blast radius.
7. Never invent options. Never answer with a question. Never ask for
   clarification — there is nobody to clarify with.

Reply with ONE JSON object and nothing else: no markdown fence, no prose.

{"summary":"one line on the shape of this decision",
 "recommendations":[
   {"question":1,"selected":["verbatim option label"],"text":"","reason":"under 25 words"}
 ]}

Use the question's 1-based number in "question".`;

export interface JudgeMessage {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
}

export interface JudgeRequest {
	systemPrompt: string;
	messages: JudgeMessage[];
}

/** Render the questionnaire for the judge: what was asked, and what it may pick. */
export function renderQuestionnaire(questionnaire: Questionnaire): string {
	const lines: string[] = [];
	if (questionnaire.context) {
		lines.push(`What the agent is trying to decide: ${questionnaire.context}`, "");
	}
	questionnaire.questions.forEach((question, index) => {
		const mode = question.multiSelect ? " (multi-select: list every option that applies)" : "";
		lines.push(`Q${index + 1} [${question.header}]${mode}`);
		lines.push(question.question);
		question.options.forEach((option, optionIndex) => {
			const recommended = question.recommended === option.label ? "  <-- model recommends this" : "";
			lines.push(`  ${optionIndex + 1}. ${option.label} — ${option.description}${recommended}`);
		});
		if (question.recommendedBecause) {
			lines.push(`  why the model recommends it: ${question.recommendedBecause}`);
		}
		lines.push("");
	});
	return lines.join("\n").trimEnd();
}

export function buildJudgeRequest(
	promptText: string,
	transcript: string,
	questionnaire: Questionnaire,
): JudgeRequest {
	const body = [
		"## Recent conversation",
		transcript.trim().length > 0 ? transcript.trim() : "(no conversation captured)",
		"",
		"## The questions that stopped the run",
		renderQuestionnaire(questionnaire),
	].join("\n");

	return {
		systemPrompt: promptText,
		messages: [{ role: "user", content: [{ type: "text", text: body }], timestamp: Date.now() }],
	};
}

/** Label matching that tolerates the punctuation and case drift models produce. */
function normalizeLabel(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s\u00a0]+/g, " ")
		.replace(/[.,;:!?。、；：！？"'`’“”()（）[\]]/g, "")
		.trim();
}

/** Resolve one returned label to an authored option, or undefined. */
export function matchOption(question: Question, raw: string): string | undefined {
	const wanted = normalizeLabel(raw);
	if (wanted.length === 0) return undefined;
	const exact = question.options.find((option) => normalizeLabel(option.label) === wanted);
	if (exact) return exact.label;
	// Prefix only — no `contains` tier, because a bare substring resolves to a
	// *different* option ("cache" sits inside "No cache") and a silently wrong
	// answer is worse than falling back to the stated recommendation.
	//
	// Longest match wins. `.find` alone would pick "No cache" when the judge
	// wrote "No cache with TTL 5m", since "No cache" is a prefix of the input and
	// is tested first. Longer labels are strictly more specific, so taking the
	// longest removes that ambiguity.
	let best: { label: string; length: number } | undefined;
	for (const option of question.options) {
		const label = normalizeLabel(option.label);
		if (!(label.startsWith(wanted) || wanted.startsWith(label))) continue;
		if (best === undefined || label.length > best.length) best = { label: option.label, length: label.length };
	}
	return best?.label;
}

/**
 * Answer straight from the calling model's own recommendations.
 *
 * This is the strong path, not a fallback. The model that wrote the
 * questionnaire just did the work and knows the task better than any judge
 * reading a truncated transcript; when it marks an option, that is the answer.
 */
export function hasRecommendation(question: Question): boolean {
	return (
		question.recommended !== undefined &&
		question.options.some((option) => option.label === question.recommended)
	);
}

/** Indices of the questions that genuinely need a judge. */
export function questionsNeedingJudge(questionnaire: Questionnaire): number[] {
	return questionnaire.questions.map((_, index) => index).filter((index) => {
		const question = questionnaire.questions[index];
		return question !== undefined && !hasRecommendation(question);
	});
}

/**
 * Merge the two sources into one verdict.
 *
 * Per question, not all-or-nothing: a stated recommendation is *never*
 * overridden by the judge (the judge is the same blocked model with less
 * context, so it can only add error). `judged` is indexed against `needed`; its
 * `questionIndex` values are subset positions and are remapped back here.
 */
export function composeVerdict(
	questionnaire: Questionnaire,
	judged: AutopilotVerdict | undefined,
	needed: readonly number[],
): AutopilotVerdict {
	const recommendations: Recommendation[] = questionnaire.questions.map((question, index) => {
		if (hasRecommendation(question)) {
			return fallbackRecommendation(question, index, "stated with the question");
		}
		const position = needed.indexOf(index);
		const fromJudge =
			position === -1 ? undefined : judged?.recommendations.find((item) => item.questionIndex === position);
		return fromJudge !== undefined
			? { ...fromJudge, questionIndex: index }
			: fallbackRecommendation(question, index, "no recommendation and no judge verdict");
	});
	const judgedCount = recommendations.length - questionnaire.questions.filter(hasRecommendation).length;
	return {
		recommendations,
		summary:
			judged?.summary ??
			(judgedCount === 0
				? "answered from the recommendations stated with the questions"
				: "answered without a stated recommendation"),
	};
}

export type ParseOutcome =
	| { ok: true; verdict: AutopilotVerdict }
	| { ok: false; error: "empty" | "unparsable"; raw: string };

function pickNumber(raw: Record<string, unknown>): number | undefined {
	const value = raw.question ?? raw.index ?? raw.q;
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ""), 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Turn the judge's raw output into a validated verdict.
 *
 * Every step degrades instead of failing: an unnumbered recommendation is
 * matched by header, a missing match falls back to the model's own
 * recommendation (or the first option), and a question the judge skipped gets
 * a fallback. `ok: false` is reserved for "there was no usable JSON at all",
 * which the caller answers by falling back wholesale.
 */
export function parseVerdict(raw: string, questionnaire: Questionnaire): ParseOutcome {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: false, error: "empty", raw };

	const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return { ok: false, error: "unparsable", raw };

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
	} catch {
		return { ok: false, error: "unparsable", raw };
	}

	const rawList = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
	const byIndex = new Map<number, Record<string, unknown>>();
	for (const item of rawList) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as Record<string, unknown>;
		const number = pickNumber(entry);
		if (number === undefined) continue;
		byIndex.set(number - 1, entry);
	}
	// Unnumbered recommendations are matched by header, in order.
	const unnumbered = rawList.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null && pickNumber(item as Record<string, unknown>) === undefined,
	);

	const recommendations: Recommendation[] = [];
	questionnaire.questions.forEach((question, index) => {
		const entry =
			byIndex.get(index) ??
			unnumbered.find(
				(item) =>
					typeof item.header === "string" &&
					normalizeLabel(item.header) === normalizeLabel(question.header),
			) ??
			(index < unnumbered.length ? unnumbered[index] : undefined);

		if (entry === undefined) {
			recommendations.push(fallbackRecommendation(question, index, "the judge skipped this question"));
			return;
		}

		const rawSelected = Array.isArray(entry.selected)
			? entry.selected.filter((label): label is string => typeof label === "string")
			: typeof entry.selected === "string"
				? [entry.selected]
				: [];
		const selected: string[] = [];
		for (const label of rawSelected) {
			const matched = matchOption(question, label);
			if (matched !== undefined && !selected.includes(matched)) selected.push(matched);
		}
		// Keep the authored order regardless of what order the judge listed them in.
		const ordered = question.options.map((option) => option.label).filter((label) => selected.includes(label));
		const text = typeof entry.text === "string" && entry.text.trim().length > 0 ? entry.text.trim() : undefined;
		const reason =
			typeof entry.reason === "string" && entry.reason.trim().length > 0
				? entry.reason.trim()
				: "(no reason given)";

		if (ordered.length === 0 && text === undefined) {
			recommendations.push(fallbackRecommendation(question, index, `unmatched answer "${compact(rawSelected.join(", "), 80)}"`));
			return;
		}
		recommendations.push({
			questionIndex: index,
			selected: question.multiSelect ? ordered : ordered.slice(0, 1),
			...(text !== undefined ? { text } : {}),
			reason,
		});
	});

	const summary =
		typeof parsed.summary === "string" && parsed.summary.trim().length > 0
			? parsed.summary.trim()
			: "autopilot answered on the user's behalf";

	return { ok: true, verdict: { recommendations, summary } };
}

/**
 * The answer used when nothing usable came back for a question: the model's own
 * authored recommendation, else the first option. A question always gets *an*
 * answer — that is the entire point of the feature.
 *
 * The authored "because" and the fallback diagnostic are both kept: the reader
 * needs to know which answer was chosen *and* that nobody actually chose it.
 */
export function fallbackRecommendation(question: Question, index: number, reason: string): Recommendation {
	const recommended = question.recommended;
	if (recommended !== undefined) {
		return {
			questionIndex: index,
			selected: [recommended],
			reason:
				question.recommendedBecause !== undefined
					? `${question.recommendedBecause} (${reason})`
					: reason,
		};
	}
	const first = question.options[0];
	return {
		questionIndex: index,
		selected: first !== undefined ? [first.label] : [],
		reason,
	};
}

/** Build the whole-questionnaire fallback used when the judge call itself fails. */
export function fallbackVerdict(questionnaire: Questionnaire, reason: string): AutopilotVerdict {
	return {
		recommendations: questionnaire.questions.map((question, index) =>
			fallbackRecommendation(question, index, reason),
		),
		summary: reason,
	};
}

/** Project a verdict onto the answer shape the dialog and transcript use. */
export function synthesizeAnswers(
	verdict: AutopilotVerdict,
	questionnaire: Questionnaire,
	source: Answer["source"],
	waitedSeconds?: number,
): Answer[] {
	return questionnaire.questions.map((question, index) => {
		const recommendation =
			verdict.recommendations.find((item) => item.questionIndex === index) ??
			fallbackRecommendation(question, index, "no recommendation");
		return {
			index,
			header: question.header,
			question: question.question,
			selected: recommendation.selected,
			...(recommendation.text !== undefined ? { text: recommendation.text } : {}),
			source,
			...(waitedSeconds !== undefined ? { waitedSeconds } : {}),
		};
	});
}

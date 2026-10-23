/**
 * The autopilot entry point: transcript + questions in, recommendations out.
 *
 * Two sources, merged per question:
 *
 * 1. **A stated recommendation wins outright.** The model that wrote the
 *    questionnaire just did the work with full context; a judge reading a
 *    truncated transcript can only add error. This is also the answer to
 *    "if the options already contain the best one, just use it."
 * 2. **Only the un-recommended questions go to the judge** — one call, and no
 *    call at all when every question carries a recommendation.
 *
 * Every failure mode terminates in an answer. A broken model, an unparsable
 * reply, a timeout — all of them fall back to the first option, because the one
 * outcome this feature exists to prevent is a run that waits forever for a
 * human who is asleep.
 */

import {
	buildJudgeRequest,
	composeVerdict,
	DEFAULT_JUDGE_PROMPT,
	fallbackVerdict,
	type JudgeRequest,
	parseVerdict,
	questionsNeedingJudge,
} from "./decide.ts";
import type { DecideConfig } from "./config.ts";
import { guardChoice } from "./safety.ts";
import type { AutopilotVerdict, Questionnaire, Recommendation } from "./types.ts";

/** A non-streaming completion through the host's provider layer. */
export type CompleteFn = (
	request: JudgeRequest,
	options: { signal: AbortSignal; model: unknown },
) => Promise<{ stopReason?: string; content?: unknown; errorMessage?: string }>;

export interface AutopilotDeps {
	complete: CompleteFn;
	/** `undefined` means no model is available; the fallback path is used. */
	resolveModel?: () => unknown;
	/** The conversation excerpt, already bounded by `buildTranscript`. */
	transcript: string;
	/** Overrides `DEFAULT_JUDGE_PROMPT`; a plain-text override wins. */
	promptText?: string;
	/** External cancellation (aborted run / shutdown). */
	signal?: AbortSignal;
	/** Where diagnostics go. Never throws. */
	log?: (message: string) => void;
}

export interface AutopilotResult {
	verdict: AutopilotVerdict;
	/** True when a usable decision was reached without falling back. */
	judged: boolean;
	/** Which path produced the verdict. */
	from: "recommendation" | "judge" | "fallback";
	/** Why it fell back, when `judged` is false. */
	fallbackReason?: string;
	/**
	 * Questions the autopilot refused to answer because they are irreversible and
	 * offer no cautious option. Non-empty means the caller must NOT proceed.
	 */
	refused: Array<{ questionIndex: number; header: string }>;
	/** Choices the safety rail steered onto the cautious option. */
	guarded: Array<{ questionIndex: number; header: string; chose: string }>;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/**
 * Apply the irreversible-question rail to a finished verdict.
 *
 * Two outcomes per guarded question: steer onto the cautious option (and say
 * so), or refuse — an irreversible decision with no cautious option is exactly
 * the case a human has to make.
 */
function applySafetyRail(
	questionnaire: Questionnaire,
	base: Pick<AutopilotResult, "judged" | "from" | "fallbackReason"> & { verdict: AutopilotVerdict },
): AutopilotResult {
	const refused: AutopilotResult["refused"] = [];
	const guarded: AutopilotResult["guarded"] = [];

	const recommendations: Recommendation[] = base.verdict.recommendations.map((recommendation) => {
		const question = questionnaire.questions[recommendation.questionIndex];
		if (question === undefined) return recommendation;
		const override = guardChoice(question, recommendation.selected);
		if (override === undefined) return recommendation;
		if (override === null) {
			refused.push({ questionIndex: recommendation.questionIndex, header: question.header });
			return recommendation;
		}
		guarded.push({ questionIndex: recommendation.questionIndex, header: question.header, chose: override });
		return {
			...recommendation,
			selected: [override],
			reason: `${recommendation.reason} — steered to the cautious option (this decision cannot be undone)`,
		};
	});

	return {
		...base,
		verdict: { ...base.verdict, recommendations },
		refused,
		guarded,
	};
}

/** Decide every question without a human. Never rejects, never returns nothing. */
export async function runAutopilot(
	questionnaire: Questionnaire,
	config: DecideConfig,
	deps: AutopilotDeps,
): Promise<AutopilotResult> {
	const needed = questionsNeedingJudge(questionnaire);

	// Nothing to ask a judge: the common case, and it costs nothing.
	if (needed.length === 0) {
		return applySafetyRail(questionnaire, {
			verdict: composeVerdict(questionnaire, undefined, needed),
			judged: true,
			from: "recommendation",
		});
	}

	const model = deps.resolveModel?.();
	if (model === undefined || model === null) {
		return applySafetyRail(questionnaire, {
			verdict: composeVerdict(questionnaire, undefined, needed),
			judged: false,
			from: "fallback",
			fallbackReason: "no model available",
		});
	}

	// The judge sees only the questions it must actually decide.
	const subset: Questionnaire = {
		...(questionnaire.context !== undefined ? { context: questionnaire.context } : {}),
		questions: needed.flatMap((index) => {
			const question = questionnaire.questions[index];
			return question === undefined ? [] : [question];
		}),
	};

	const request = buildJudgeRequest(deps.promptText ?? DEFAULT_JUDGE_PROMPT, deps.transcript, subset);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.judge.timeoutMs);
	(timer as unknown as { unref?: () => void }).unref?.();
	const onAbort = () => controller.abort();
	deps.signal?.addEventListener("abort", onAbort, { once: true });

	let response: { stopReason?: string; content?: unknown; errorMessage?: string };
	try {
		response = await deps.complete(request, { signal: controller.signal, model });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.log?.(`[pi-decide] autopilot judge call failed: ${message}`);
		return applySafetyRail(questionnaire, {
			verdict: composeVerdict(questionnaire, undefined, needed),
			judged: false,
			from: "fallback",
			fallbackReason: message,
		});
	} finally {
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", onAbort);
	}

	if (response.stopReason !== "stop" && response.stopReason !== undefined) {
		const reason = response.errorMessage ?? `stopReason=${response.stopReason}`;
		deps.log?.(`[pi-decide] autopilot judge did not complete: ${reason}`);
		return applySafetyRail(questionnaire, {
			verdict: composeVerdict(questionnaire, undefined, needed),
			judged: false,
			from: "fallback",
			fallbackReason: reason,
		});
	}

	const raw = textOf(response.content);
	const parsed = parseVerdict(raw, subset);
	if (!parsed.ok) {
		deps.log?.(`[pi-decide] autopilot judge output ${parsed.error}: ${raw.slice(0, 400)}`);
		return applySafetyRail(questionnaire, {
			verdict: composeVerdict(questionnaire, undefined, needed),
			judged: false,
			from: "fallback",
			fallbackReason: parsed.error,
		});
	}

	return applySafetyRail(questionnaire, {
		verdict: composeVerdict(questionnaire, parsed.verdict, needed),
		judged: true,
		from: "judge",
	});
}

/** Re-exported so callers can build a wholly-fallback verdict without a judge. */
export { fallbackVerdict };

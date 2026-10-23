/**
 * The autopilot entry point: transcript + questions in, recommendations out.
 *
 * Every failure mode terminates in an answer. A broken model, an unparsable
 * reply, a timeout — all of them fall back to the model's own authored
 * recommendation (or the first option), because the one outcome this feature
 * exists to prevent is a run that waits forever for a human who is asleep.
 */

import {
	buildJudgeRequest,
	DEFAULT_JUDGE_PROMPT,
	fallbackVerdict,
	type JudgeRequest,
	parseVerdict,
} from "./decide.ts";
import type { DecideConfig } from "./config.ts";
import type { AutopilotVerdict, Questionnaire } from "./types.ts";

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
	/** Where the resolved model came from, for the transcript note. */
	log?: (message: string) => void;
}

export interface AutopilotResult {
	verdict: AutopilotVerdict;
	/** True when the judge produced a usable verdict; false when this is a fallback. */
	judged: boolean;
	/** Why it fell back, when `judged` is false. */
	fallbackReason?: string;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/** Decide every question without a human. Never rejects, never returns nothing. */
export async function runAutopilot(
	questionnaire: Questionnaire,
	config: DecideConfig,
	deps: AutopilotDeps,
): Promise<AutopilotResult> {
	const model = deps.resolveModel?.();
	if (model === undefined || model === null) {
		return {
			verdict: fallbackVerdict(questionnaire, "no model was available to answer — using the stated recommendations"),
			judged: false,
			fallbackReason: "no model available",
		};
	}

	const request = buildJudgeRequest(deps.promptText ?? DEFAULT_JUDGE_PROMPT, deps.transcript, questionnaire);
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
		return {
			verdict: fallbackVerdict(
				questionnaire,
				`the judge call failed (${message}) — using the stated recommendations`,
			),
			judged: false,
			fallbackReason: message,
		};
	} finally {
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", onAbort);
	}

	if (response.stopReason !== "stop" && response.stopReason !== undefined) {
		const reason = response.errorMessage ?? `stopReason=${response.stopReason}`;
		deps.log?.(`[pi-decide] autopilot judge did not complete: ${reason}`);
		return {
			verdict: fallbackVerdict(questionnaire, `the judge did not finish (${reason}) — using the stated recommendations`),
			judged: false,
			fallbackReason: reason,
		};
	}

	const raw = textOf(response.content);
	const parsed = parseVerdict(raw, questionnaire);
	if (!parsed.ok) {
		deps.log?.(`[pi-decide] autopilot judge output ${parsed.error}: ${raw.slice(0, 400)}`);
		return {
			verdict: fallbackVerdict(
				questionnaire,
				`the judge's answer could not be read (${parsed.error}) — using the stated recommendations`,
			),
			judged: false,
			fallbackReason: parsed.error,
		};
	}

	return { verdict: parsed.verdict, judged: true };
}

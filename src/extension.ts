/**
 * Pi entry point.
 *
 * This is the file `package.json` declares under `pi.extensions`. It is pure
 * adapter code: Pi's `ExtensionContext` in, the host-free engine out. Every
 * decision worth testing lives in `policy.ts` / `decide.ts` / `autopilot.ts` /
 * `tool/validate.ts`.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { runAutopilot } from "./autopilot.ts";
import { describePolicy, resolvePolicy, type HostKind } from "./policy.ts";
import { loadConfig, type DecideConfig } from "./config.ts";
import { synthesizeAnswers } from "./decide.ts";
import { buildTranscript } from "./transcript.ts";
import { QuestionnaireDialog, type DialogOutcome } from "./ui/dialog.ts";
import { buildResult, rejected, type ToolResult } from "./tool/envelope.ts";
import { QuestionnaireSchema, TOOL_NAME } from "./tool/schema.ts";
import { validateQuestionnaire } from "./tool/validate.ts";
import type { Answer, DecisionResult, PolicyMode, Questionnaire } from "./types.ts";

const STATUS_KEY = "pi-decide";

const TOOL_DESCRIPTION = `Ask the user one or more structured questions when a decision genuinely needs a human: unclear requirements, mutually exclusive implementation choices, or a direction only the owner can pick.

The dialog offers written-out options with descriptions, a free-text row, per-question notes, and a Submit tab that reviews everything before it goes back. Up to 8 questions with 2-8 options each. Provide a \`preview\` (markdown mockup, diff, config) when the choice is easier to see than to describe.

Autopilot: when the session policy is \`on\`, or the host has no UI, or the user is away and the countdown expires, a model answers these questions on the user's behalf and the result is labelled as such. Mark your own best option with \`recommended\` — the autopilot uses it as the default, so a good recommendation is what keeps an unattended run on track.`;

const PROMPT_SNIPPET =
	"Ask the user up to 8 structured questions (2-8 options each) when a decision needs a human; autopilot answers them when nobody is there";

const PROMPT_GUIDELINES = [
	"Use ask_user_question when the request is underspecified and you cannot proceed without a concrete decision. Do not use it to confirm something you can verify yourself.",
	"Every question needs 2-8 options with one-sentence descriptions. Never author an \"Other\" or \"Type something.\" option — that row is appended automatically.",
	"Always set `recommended` to the label of the option you would pick, with a short `recommendedBecause`. The autopilot falls back to it, so this is what decides an unattended run.",
	"Do not stack several ask_user_question calls back to back. Group the questions into one invocation.",
	"Check the result envelope: answers marked `[autopilot]` were not chosen by the user. State the assumption in your final report rather than implying it was approved.",
];

/** Resolve the config from the agent directory, once per invocation so edits apply live. */
function currentConfig(): DecideConfig {
	const loaded = loadConfig(getAgentDir());
	if (loaded.warning !== undefined) process.stderr.write(`[pi-decide] ${loaded.warning}\n`);
	return loaded.config;
}

function hostKind(ctx: ExtensionContext): HostKind {
	if (ctx.mode === "tui") return "tui";
	if (ctx.mode === "rpc" && ctx.hasUI) return "rpc";
	return "none";
}

function emitBell(policy: { bell: boolean }, host: HostKind): void {
	// A BEL is only honest when a terminal is actually waiting on a human. In
	// RPC hosts the questionnaire renders in a remote UI, so ringing the local
	// tty would be noise the user cannot connect to anything.
	if (!policy.bell || host !== "tui") return;
	try {
		if (process.stdout.isTTY) process.stdout.write("\x07");
	} catch {
		// Terminal attention is best effort; the dialog must still open.
	}
}

/** Assemble the decision envelope from a human's dialog answers. */
function fromDialog(questionnaire: Questionnaire, outcome: Extract<DialogOutcome, { kind: "answered" }>): DecisionResult {
	const answers: Answer[] = [];
	questionnaire.questions.forEach((question, index) => {
		const raw = outcome.answers.get(index);
		if (raw === undefined) return;
		answers.push({
			index,
			header: question.header,
			question: question.question,
			selected: raw.selected,
			...(raw.text !== undefined ? { text: raw.text } : {}),
			source: "user",
			...(raw.note !== undefined ? { note: raw.note } : {}),
		});
	});
	const answeredIndexes = new Set(answers.map((answer) => answer.index));
	return {
		answers,
		outcome: "answered",
		unanswered: questionnaire.questions
			.filter((_, index) => !answeredIndexes.has(index))
			.map((question) => question.header),
		...(outcome.globalNote !== undefined ? { globalNote: outcome.globalNote } : {}),
	};
}

/** Show the dialog and wait. Resolves with the dialog's outcome, never throws. */
function showDialog(ctx: ExtensionContext, questionnaire: Questionnaire, timeoutSeconds: number, hint?: string): Promise<DialogOutcome> {
	return ctx.ui.custom<DialogOutcome>((tui, theme, keybindings, done) => {
		const dialog = new QuestionnaireDialog({
			questionnaire,
			...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
			...(hint !== undefined ? { autopilotHint: hint } : {}),
			tui,
			theme,
			keybindings,
			done,
		});
		return {
			render: (width: number) => dialog.render(width),
			invalidate: () => dialog.invalidate(),
			handleInput: (data: string) => dialog.handleInput(data),
			dispose: () => dialog.dispose(),
		};
	});
}

/** Ask the session's model to answer the questionnaire in the user's place. */
async function answerWithAutopilot(
	ctx: ExtensionContext,
	questionnaire: Questionnaire,
	config: DecideConfig,
	why: string,
	source: Answer["source"],
	waitedSeconds?: number,
): Promise<DecisionResult> {
	let transcript = "";
	try {
		const branch = ctx.sessionManager.getBranch();
		transcript = buildTranscript(branch as never, {
			tailMessages: config.judge.tailMessages,
			maxTailChars: config.judge.maxTailChars,
		});
	} catch (error) {
		process.stderr.write(
			`[pi-decide] could not read the session transcript: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}

	const pinned = config.judge.model;
	const model =
		pinned !== null
			? ctx.modelRegistry.find(pinned.provider, pinned.model)
			: ctx.model;

	const result = await runAutopilot(questionnaire, config, {
		transcript,
		signal: ctx.signal,
		resolveModel: () => model,
		complete: async (request, options) => {
			const completionModel = options.model;
			if (completionModel === undefined || completionModel === null) {
				throw new Error("no model available");
			}
			const response = await ctx.modelRegistry.complete(
				completionModel as Parameters<typeof ctx.modelRegistry.complete>[0],
				{
					systemPrompt: request.systemPrompt,
					messages: request.messages as unknown as Message[],
				},
				{ signal: options.signal },
			);
			return response;
		},
		log: (message) => process.stderr.write(`${message}\n`),
	});

	const answers = synthesizeAnswers(result.verdict, questionnaire, source, waitedSeconds);
	if (config.notify) {
		ctx.ui.notify(
			source === "timeout"
				? `No response — the autopilot answered ${answers.length} question${answers.length === 1 ? "" : "s"}.`
				: `Autopilot answered ${answers.length} question${answers.length === 1 ? "" : "s"} (${why}).`,
			"info",
		);
	}
	return {
		answers,
		outcome: source === "timeout" ? "timeout" : "autopilot",
		reason: result.judged ? result.verdict.summary : (result.fallbackReason ?? result.verdict.summary),
		unanswered: [],
	};
}

export default function piDecide(pi: ExtensionAPI): void {
	/** Session-scoped override, set by `/decide off|on|auto`. Not persisted on purpose. */
	let sessionMode: PolicyMode | undefined;
	let lastConfig = loadConfig(getAgentDir()).config;

	const paintStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const mode = sessionMode ?? lastConfig.autopilot.mode;
		ctx.ui.setStatus(
			STATUS_KEY,
			mode === "off"
				? undefined
				: `🤖 ${mode === "on" ? "auto" : `auto:${lastConfig.autopilot.timeoutSeconds}s`}${sessionMode !== undefined ? "*" : ""}`,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		lastConfig = loadConfig(getAgentDir()).config;
		paintStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("decide", {
		description:
			"Autopilot policy for ask_user_question: /decide [off|on|auto|status] [seconds]. `on` never asks, `auto` asks then self-answers after N seconds.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const head = parts[0]?.toLowerCase();
			lastConfig = loadConfig(getAgentDir()).config;

			if (head === "" || head === undefined || head === "status") {
				const effective = resolvePolicy({ config: lastConfig, ...(sessionMode !== undefined ? { sessionMode } : {}), host: hostKind(ctx) });
				ctx.ui.notify(
					[
						`ask_user_question: ${describePolicy(effective.mode, lastConfig.autopilot.timeoutSeconds)}`,
						`config: ${lastConfig.autopilot.mode}, timeout ${lastConfig.autopilot.timeoutSeconds}s`,
						sessionMode !== undefined ? `session override: ${sessionMode}` : "session override: none",
						effective.why,
					].join("\n"),
					"info",
				);
				return;
			}

			if (head === "reset" || head === "clear") {
				sessionMode = undefined;
				paintStatus(ctx);
				ctx.ui.notify(`Autopilot back to the configured policy: ${lastConfig.autopilot.mode}`, "info");
				return;
			}

			if (head !== "off" && head !== "on" && head !== "auto") {
				ctx.ui.notify("Usage: /decide [off|on|auto|status|reset] [seconds]", "error");
				return;
			}

			sessionMode = head;
			const seconds = parts[1] === undefined ? Number.NaN : Number.parseInt(parts[1], 10);
			if (Number.isFinite(seconds) && seconds >= 0) {
				lastConfig = { ...lastConfig, autopilot: { ...lastConfig.autopilot, timeoutSeconds: seconds } };
			}
			paintStatus(ctx);
			const describe =
				head === "off"
					? "always ask the human"
					: head === "on"
						? "never ask — the model answers every questionnaire"
						: `ask, then self-answer after ${lastConfig.autopilot.timeoutSeconds}s`;
			ctx.ui.notify(`Autopilot for this session: ${describe}.${head === "off" ? "" : " (/decide reset to undo)"}`, "info");
		},
	});

	pi.registerTool<typeof QuestionnaireSchema, ToolResult["details"]>({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: QuestionnaireSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = currentConfig();
			lastConfig = config;
			if (!config.enabled) {
				return rejected(undefined, "pi-decide is disabled in the config file (enabled: false)");
			}

			const validation = validateQuestionnaire(params as Questionnaire, config.limits);
			if (!validation.ok) return rejected(undefined, validation.message, true);
			const questionnaire = validation.questionnaire;
			if (validation.warnings.length > 0 && config.debug) {
				process.stderr.write(`[pi-decide] ${validation.warnings.join("; ")}\n`);
			}

			const host = hostKind(ctx);
			const resolved = resolvePolicy({
				config,
				host,
				...(sessionMode !== undefined ? { sessionMode } : {}),
				...(questionnaire.mode !== undefined ? { perCallMode: questionnaire.mode } : {}),
			});

			// No human to ask: answer it here rather than block the run.
			if (!resolved.ask) {
				return buildResult(
					await answerWithAutopilot(ctx, questionnaire, config, resolved.why, "autopilot"),
					questionnaire,
				);
			}

			const unansweredHeaders = questionnaire.questions.map((question) => question.header);
			let outcome: DialogOutcome;
			try {
				emitBell(resolved.policy, host);
				outcome = await showDialog(
					ctx,
					questionnaire,
					resolved.policy.timeoutSeconds,
					resolved.mode === "auto" && resolved.policy.timeoutSeconds > 0 ? "no one has answered" : undefined,
				);
			} catch (error) {
				return rejected(
					questionnaire,
					`the questionnaire UI could not be shown (${error instanceof Error ? error.message : String(error)}). The user never saw these questions — do NOT treat this as a decline. Ask them as plain chat text instead.`,
					true,
				);
			}

			switch (outcome.kind) {
				case "answered":
					return buildResult(fromDialog(questionnaire, outcome), questionnaire);
				case "cancelled":
					return buildResult(
						{ answers: [], outcome: "cancelled", unanswered: unansweredHeaders },
						questionnaire,
					);
				case "autopilot":
					return buildResult(
						await answerWithAutopilot(
							ctx,
							questionnaire,
							config,
							`no answer within ${outcome.waitedSeconds}s`,
							"timeout",
							outcome.waitedSeconds,
						),
						questionnaire,
					);
			}

			// `signal` is intentionally unused: the dialog close path owns cancellation,
			// and an abort mid-dialog must still produce an envelope for the model.
			void signal;
		},
	});
}

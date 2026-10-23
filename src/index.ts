/**
 * pi-decide — public API.
 *
 * The Pi entry point is `./extension.ts` (declared in `package.json` under
 * `pi.extensions`). Import this module when you want to reuse the engine in
 * your own extension, swap the judge, or drive the pieces from tests.
 */

export { default } from "./extension.ts";
export { runAutopilot } from "./autopilot.ts";
export type { AutopilotDeps, AutopilotResult, CompleteFn } from "./autopilot.ts";

export {
	DEFAULT_JUDGE_PROMPT,
	buildJudgeRequest,
	fallbackRecommendation,
	fallbackVerdict,
	matchOption,
	parseVerdict,
	renderQuestionnaire,
	synthesizeAnswers,
} from "./decide.ts";
export type { JudgeRequest, ParseOutcome } from "./decide.ts";

export { describePolicy, resolvePolicy } from "./policy.ts";
export type { HostKind, PolicyInput, Resolved } from "./policy.ts";

export { CONFIG_FILE, configPath, defaultConfig, loadConfig, mergeConfig } from "./config.ts";
export type { DecideConfig, JudgeConfig, Limits, LoadedConfig } from "./config.ts";

export { buildTranscript, compact, textOf } from "./transcript.ts";

export { QuestionnaireDialog, CUSTOM_ROW_LABEL, NOTE_ROW_LABEL } from "./ui/dialog.ts";
export type { DialogAnswer, DialogOptions, DialogOutcome } from "./ui/dialog.ts";
export { renderDialog, renderCollapsed } from "./ui/view.ts";
export type { ViewOption, ViewState, ViewTab } from "./ui/view.ts";
export { ansiPalette, PLAIN_PALETTE } from "./ui/palette.ts";
export type { Palette, Token } from "./ui/palette.ts";

export { RESERVED_LABELS, validateQuestionnaire } from "./tool/validate.ts";
export type { Validation, ValidationError, ValidationOk } from "./tool/validate.ts";
export { buildResult, formatResult, rejected } from "./tool/envelope.ts";
export type { ToolDetails, ToolResult } from "./tool/envelope.ts";
export { QuestionnaireSchema, TOOL_NAME } from "./tool/schema.ts";

export type {
	Answer,
	AnswerSource,
	AutopilotVerdict,
	DecisionResult,
	Option,
	Policy,
	PolicyMode,
	Question,
	Questionnaire,
	Recommendation,
} from "./types.ts";

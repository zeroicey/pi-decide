/**
 * The model-facing tool schema.
 *
 * Limits are stated in the descriptions rather than enforced only at runtime,
 * because a model that reads "up to 8 options" rarely sends 12. The runtime
 * limits come from config (`limits`), so the schema is deliberately looser than
 * the config defaults and reports the exact ceilings in `validate.ts`.
 */

import { Type } from "typebox";

export const TOOL_NAME = "ask_user_question";

export const OptionSchema = Type.Object({
	label: Type.String({
		minLength: 1,
		maxLength: 80,
		description:
			"Display text the user picks (1-5 words). Must be unique within its question. Do NOT author `Other` or `Type something.` — those rows are appended automatically.",
	}),
	description: Type.String({
		minLength: 1,
		description: "What this choice means, or what it costs. One sentence.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown rendered beside the option list when focused: an ASCII mockup, a code diff, a config fragment. Single-select questions only.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		minLength: 1,
		description:
			'The complete question, ending in a question mark. Example: "Which cache eviction policy should the session store use?" For multiSelect, phrase it plurally.',
	}),
	header: Type.String({
		minLength: 1,
		maxLength: 24,
		description:
			'Very short tab label / category chip, 1-3 words. Examples: "Cache", "Migration", "Release".',
	}),
	category: Type.Optional(
		Type.String({
			maxLength: 40,
			description: "Optional wider grouping used in the answer summary, e.g. \"database\" or \"rollout\".",
		}),
	),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		description: "Authored choices. Mutually exclusive unless multiSelect is true.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Allow more than one choice. Use for non-exclusive options.",
		}),
	),
	recommended: Type.Optional(
		Type.String({
			maxLength: 80,
			description:
				'Label of the option you would pick. Must match an option label verbatim. Marked in the UI and used as the autopilot default.',
		}),
	),
	recommendedBecause: Type.Optional(
		Type.String({
			maxLength: 200,
			description: "One clause on why that option is best. Shows next to the recommendation.",
		}),
	),
});

export const QuestionnaireSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		description: "Questions to ask, in the order they should be presented.",
	}),
	context: Type.Optional(
		Type.String({
			maxLength: 600,
			description:
				"One or two lines on the decision being made, so an autopilot answering in your place understands the goal.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("ask"), Type.Literal("auto")], {
			description:
				'Per-call override: "auto" lets the autopilot answer without a human; "ask" always waits for the human (ignored when the session policy is "on").',
		}),
	),
});

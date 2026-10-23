import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { validateQuestionnaire, type ValidationErrorName } from "../src/tool/validate.ts";
import { question, questionnaire } from "./fixtures.ts";

const limits = defaultConfig().limits;

function expectError(raw: Parameters<typeof validateQuestionnaire>[0], name: ValidationErrorName) {
	const result = validateQuestionnaire(raw, limits);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error).toBe(name);
	return result;
}

describe("validateQuestionnaire", () => {
	test("normalises a good questionnaire and reports no warnings", () => {
		const result = validateQuestionnaire(
			questionnaire(question({ recommended: "LRU", recommendedBecause: "cheapest" })),
			limits,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toEqual([]);
		const q = result.questionnaire.questions[0];
		expect(q?.recommended).toBe("LRU");
		expect(q?.recommendedBecause).toBe("cheapest");
		expect(q?.options).toHaveLength(3);
	});

	test("trims whitespace and collapses runs of spaces in labels and headers", () => {
		const result = validateQuestionnaire(
			{
				questions: [
					{
						question: "  Pick one  ",
						header: "  Cache   policy ",
						options: [
							{ label: "  LRU  ", description: "  cheap  " },
							{ label: "TTL   5m", description: "simple" },
						],
					},
				],
			},
			limits,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const q = result.questionnaire.questions[0];
		expect(q?.header).toBe("Cache policy");
		expect(q?.question).toBe("Pick one");
		expect(q?.options.map((option) => option.label)).toEqual(["LRU", "TTL 5m"]);
		expect(q?.options[0]?.description).toBe("cheap");
	});

	test("rejects an empty questionnaire", () => {
		expectError({ questions: [] }, "no_questions");
	});

	test("rejects more questions than the limit allows", () => {
		const many = Array.from({ length: limits.maxQuestions + 1 }, (_, index) =>
			question({ header: `Q${index}` }),
		);
		expectError(questionnaire(...many), "too_many_questions");
	});

	test("accepts exactly the maximum number of questions", () => {
		const many = Array.from({ length: limits.maxQuestions }, (_, index) => question({ header: `Q${index}` }));
		expect(validateQuestionnaire(questionnaire(...many), limits).ok).toBe(true);
	});

	test("rejects a question with fewer than two options", () => {
		expectError(
			questionnaire(question({ options: [{ label: "Only", description: "the one" }] })),
			"too_few_options",
		);
	});

	test("rejects more options than the limit allows", () => {
		const options = Array.from({ length: limits.maxOptions + 1 }, (_, index) => ({
			label: `Option ${index}`,
			description: "x",
		}));
		expectError(questionnaire(question({ options })), "too_many_options");
	});

	test("rejects duplicate labels, case-insensitively", () => {
		expectError(
			questionnaire(
				question({
					options: [
						{ label: "LRU", description: "a" },
						{ label: "lru", description: "b" },
					],
				}),
			),
			"duplicate_label",
		);
	});

	test("rejects the labels the runtime appends itself", () => {
		for (const label of ["Other", "other", "Type something", "Type something."]) {
			expectError(
				questionnaire(
					question({
						options: [
							{ label, description: "nope" },
							{ label: "TTL", description: "yes" },
						],
					}),
				),
				"reserved_label",
			);
		}
	});

	test("rejects empty labels, descriptions and headers", () => {
		expectError(
			questionnaire(
				question({
					options: [
						{ label: "  ", description: "a" },
						{ label: "b", description: "b" },
					],
				}),
			),
			"empty_label",
		);
		expectError(
			questionnaire(
				question({
					options: [
						{ label: "a", description: "   " },
						{ label: "b", description: "b" },
					],
				}),
			),
			"empty_description",
		);
		expectError(questionnaire(question({ header: "   " })), "empty_header");
	});

	test("drops an unmatched recommendation with a warning instead of failing", () => {
		const result = validateQuestionnaire(questionnaire(question({ recommended: "LRU2" })), limits);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("matches no option");
		expect(result.questionnaire.questions[0]?.recommended).toBeUndefined();
	});

	test("matches a recommendation case-insensitively and stores the authored label", () => {
		const result = validateQuestionnaire(questionnaire(question({ recommended: "lru" })), limits);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.questionnaire.questions[0]?.recommended).toBe("LRU");
	});

	test("keeps only the mode values the engine understands", () => {
		const withAuto = validateQuestionnaire({ ...questionnaire(), mode: "auto" }, limits);
		expect(withAuto.ok && withAuto.questionnaire.mode).toBe("auto");
		const withJunk = validateQuestionnaire(
			{ ...questionnaire(), mode: "later" } as unknown as Parameters<typeof validateQuestionnaire>[0],
			limits,
		);
		expect(withJunk.ok && withJunk.questionnaire.mode).toBeUndefined();
	});

	test("never throws on hostile input", () => {
		const hostile = [
			{ questions: null },
			{ questions: [null] },
			{ questions: [{ options: null }] },
			{ questions: [{ header: "x", options: [null, null] }] },
		];
		for (const raw of hostile) {
			const result = validateQuestionnaire(raw as never, limits);
			expect(result.ok).toBe(false);
		}
	});
});

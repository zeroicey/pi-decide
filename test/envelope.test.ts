import { describe, expect, test } from "bun:test";
import { buildResult, formatResult, rejected } from "../src/tool/envelope.ts";
import type { Answer, DecisionResult } from "../src/types.ts";
import { question, questionnaire } from "./fixtures.ts";

const q = questionnaire(question({ header: "Cache" }));

function answer(overrides: Partial<Answer> = {}): Answer {
	return {
		index: 0,
		header: "Cache",
		question: "which cache?",
		selected: ["LRU"],
		source: "user",
		...overrides,
	};
}

function result(overrides: Partial<DecisionResult> = {}): DecisionResult {
	return { answers: [answer()], outcome: "answered", unanswered: [], ...overrides };
}

describe("formatResult", () => {
	test("lists a plain human answer with no warning preamble", () => {
		const text = formatResult(result(), q);
		expect(text).toBe('Answers:\n- Cache: "LRU"');
	});

	test("says loudly that the autopilot answered, so the model cannot imply approval", () => {
		const text = formatResult(
			result({ outcome: "autopilot", answers: [answer({ source: "autopilot" })], reason: "nobody was there" }),
			q,
		);
		expect(text).toContain("chosen by the autopilot, not by the user: nobody was there");
		expect(text).toContain("did not confirm these choices");
		expect(text).toContain("[autopilot]");
	});

	test("reports the wait on a timeout resolution", () => {
		const text = formatResult(
			result({
				outcome: "timeout",
				answers: [answer({ source: "timeout", waitedSeconds: 180 })],
				reason: "no answer within 180s",
			}),
			q,
		);
		expect(text).toContain("Nobody answered the dialog (no answer within 180s)");
		expect(text).toContain("[timeout, after 180s]");
	});

	test("forbids reading a cancellation as agreement", () => {
		const text = formatResult(result({ answers: [], outcome: "cancelled", unanswered: ["Cache"] }), q);
		expect(text).toContain("do not treat the cancellation as agreement");
		expect(text).toContain("Unanswered: Cache");
	});

	test("carries free-text answers, notes and a global note", () => {
		const text = formatResult(
			result({
				answers: [answer({ selected: ["LRU"], text: "unless writes are hot", note: "ask me later" })],
				globalNote: "overall fine",
			}),
			q,
		);
		expect(text).toContain('"LRU" plus: unless writes are hot');
		expect(text).toContain("user note: ask me later");
		expect(text).toContain("Global note: overall fine");
	});

	test("shows a free-text-only answer as the plain answer", () => {
		expect(formatResult(result({ answers: [answer({ selected: [], text: "Use Redis" })] }), q)).toContain(
			"- Cache: Use Redis",
		);
	});

	test("never returns an empty string", () => {
		expect(formatResult({ answers: [], outcome: "answered", unanswered: [] }, q)).toBe(
			"No answers were produced by the questionnaire.",
		);
	});
});

describe("buildResult", () => {
	test("mirrors the envelope into details", () => {
		const built = buildResult(result({ reason: "r", globalNote: "g" }), q);
		expect(built.details.outcome).toBe("answered");
		expect(built.details.answers).toHaveLength(1);
		expect(built.details.reason).toBe("r");
		expect(built.details.globalNote).toBe("g");
		expect(built.isError).toBeUndefined();
	});

	test("marks an error result without throwing", () => {
		expect(buildResult(result(), q, { isError: true }).isError).toBe(true);
	});

	test("rejected() explains itself and names what went unanswered", () => {
		const built = rejected(q, "too many questions", true);
		expect(built.details.outcome).toBe("rejected");
		expect(built.details.unanswered).toEqual(["Cache"]);
		expect(built.content[0]?.text).toContain("too many questions");
		expect(built.isError).toBe(true);
	});
});

describe("refused questions", () => {
	test("are not listed as answers, because they were not answered", () => {
		const text = formatResult(
			{
				answers: [answer({ header: "Key", selected: ["Rotate immediately"], source: "autopilot" })],
				outcome: "refused",
				reason: "an irreversible decision with no cautious option needs a human (Key)",
				unanswered: ["Key"],
				refused: [{ questionIndex: 0, header: "Key" }],
			},
			q,
		);
		expect(text).toContain("REFUSED");
		expect(text).toContain("do NOT proceed as if it were answered");
		// The autopilot's own fallback pick must not appear as if it were an answer.
		expect(text).not.toContain('"Rotate immediately"');
		expect(text).toContain("Unanswered: Key");
	});

	test("a refusal still reports answers for the questions that were safe", () => {
		const two = questionnaire(question({ header: "Cache" }), question({ header: "Key" }));
		const text = formatResult(
			{
				answers: [
					answer({ index: 0, header: "Cache", selected: ["LRU"], source: "autopilot" }),
					answer({ index: 1, header: "Key", selected: ["Rotate immediately"], source: "autopilot" }),
				],
				outcome: "refused",
				unanswered: ["Key"],
				refused: [{ questionIndex: 1, header: "Key" }],
			},
			two,
		);
		expect(text).toContain('- Cache: "LRU" [autopilot]');
		expect(text).not.toContain("Rotate immediately");
	});

	test("reports when the rail steered a choice", () => {
		const text = formatResult(
			{
				answers: [answer({ selected: ["Back up first"], source: "autopilot" })],
				outcome: "autopilot",
				unanswered: [],
				guarded: [{ questionIndex: 0, header: "Cache", chose: "Back up first" }],
			},
			q,
		);
		expect(text).toContain('steered to the cautious option "Back up first"');
	});
});

describe("multi-select answers", () => {
	test("every checked label reaches the model, quoted and separated", () => {
		const q = questionnaire(question({ header: "Touched", multiSelect: true }));
		const result: DecisionResult = {
			answers: [
				{
					index: 0,
					header: "Touched",
					question: q.questions[0]?.question ?? "",
					selected: ["LRU", "TTL 5m", "No cache"],
					source: "user",
				},
			],
			outcome: "answered",
			unanswered: [],
		};
		const text = formatResult(result, q);
		expect(text).toContain('"LRU", "TTL 5m", "No cache"');
		// Three picks must not be flattened into one string the model has to split.
		expect(text).not.toContain('"LRU, TTL 5m, No cache"');
	});
});

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
		expect(text).toContain("waited no answer within 180s with no human input");
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

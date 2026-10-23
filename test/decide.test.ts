import { describe, expect, test } from "bun:test";
import {
	buildJudgeRequest,
	fallbackRecommendation,
	fallbackVerdict,
	matchOption,
	parseVerdict,
	renderQuestionnaire,
	synthesizeAnswers,
} from "../src/decide.ts";
import { question, questionnaire } from "./fixtures.ts";

const cache = questionnaire(question({ recommended: "TTL 5m", recommendedBecause: "nothing to invalidate" }));

function verdictOf(raw: string, q = cache) {
	const parsed = parseVerdict(raw, q);
	if (!parsed.ok) throw new Error(`expected a verdict, got ${parsed.error}`);
	return parsed.verdict;
}

describe("matchOption", () => {
	const q = question();

	test("matches verbatim, ignoring case and punctuation", () => {
		expect(matchOption(q, "LRU")).toBe("LRU");
		expect(matchOption(q, " lru. ")).toBe("LRU");
		expect(matchOption(q, "TTL 5m")).toBe("TTL 5m");
		expect(matchOption(q, "ttl   5m")).toBe("TTL 5m");
	});

	test("matches on a prefix", () => {
		expect(matchOption(q, "No")).toBe("No cache");
	});

	test("refuses a bare substring, so it cannot pick the wrong option", () => {
		// "cache" appears in "No cache" only as a substring. Guessing here is how a
		// judge's "No cache with TTL 5m" would silently resolve to "No cache".
		expect(matchOption(q, "cache")).toBeUndefined();
	});

	test("returns undefined for anything unmatched", () => {
		expect(matchOption(q, "LFU")).toBeUndefined();
		expect(matchOption(q, "   ")).toBeUndefined();
	});
});

describe("parseVerdict", () => {
	test("reads the canonical shape and keeps authored order", () => {
		const verdict = verdictOf(
			JSON.stringify({
				summary: "cache policy settled",
				recommendations: [{ question: 1, selected: ["TTL 5m"], reason: "simplest correct default" }],
			}),
		);
		expect(verdict.summary).toBe("cache policy settled");
		expect(verdict.recommendations).toEqual([
			{ questionIndex: 0, selected: ["TTL 5m"], reason: "simplest correct default" },
		]);
	});

	test("tolerates a markdown fence and surrounding prose", () => {
		const verdict = verdictOf(
			'Here you go:\n```json\n{"summary":"s","recommendations":[{"question":1,"selected":["LRU"],"reason":"r"}]}\n```',
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["LRU"]);
	});

	test("matches a recommendation by header when the number is missing", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ header: "cache", selected: ["LRU"], reason: "r" }] }),
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["LRU"]);
	});

	test("falls back to the model's own recommendation when the label does not match", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: ["LFU"], reason: "r" }] }),
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		expect(verdict.recommendations[0]?.reason).toContain("unmatched answer");
	});

	test("answers a question the judge skipped", () => {
		const verdict = verdictOf(JSON.stringify({ recommendations: [] }));
		expect(verdict.recommendations).toHaveLength(1);
		expect(verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		expect(verdict.recommendations[0]?.reason).toContain("skipped");
	});

	test("keeps a free-text answer when no option fits", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: [], text: "Use Redis", reason: "r" }] }),
		);
		expect(verdict.recommendations[0]).toEqual({
			questionIndex: 0,
			selected: [],
			text: "Use Redis",
			reason: "r",
		});
	});

	test("keeps only the first pick on a single-select question", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: ["LRU", "TTL 5m"], reason: "r" }] }),
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["LRU"]);
	});

	test("keeps every pick, in authored order, on a multi-select question", () => {
		const multi = questionnaire(question({ multiSelect: true }));
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: ["No cache", "LRU"], reason: "r" }] }),
			multi,
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["LRU", "No cache"]);
	});

	test("deduplicates repeated picks", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: ["LRU", "lru", "LRU"], reason: "r" }] }),
		);
		expect(verdict.recommendations[0]?.selected).toEqual(["LRU"]);
	});

	test("maps multiple questions by 1-based index", () => {
		const two = questionnaire(question({ header: "A" }), question({ header: "B" }));
		const verdict = verdictOf(
			JSON.stringify({
				recommendations: [
					{ question: 2, selected: ["No cache"], reason: "second" },
					{ question: 1, selected: ["LRU"], reason: "first" },
				],
			}),
			two,
		);
		expect(verdict.recommendations[0]).toEqual({ questionIndex: 0, selected: ["LRU"], reason: "first" });
		expect(verdict.recommendations[1]).toEqual({ questionIndex: 1, selected: ["No cache"], reason: "second" });
	});

	test("reports empty and unparsable output distinctly", () => {
		expect(parseVerdict("   ", cache)).toEqual({ ok: false, error: "empty", raw: "   " });
		expect(parseVerdict("no json here", cache)).toEqual({ ok: false, error: "unparsable", raw: "no json here" });
		expect(parseVerdict("{broken", cache).ok).toBe(false);
	});

	test("supplies a default summary when the judge omits one", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: ["LRU"], reason: "r" }] }),
		);
		expect(verdict.summary).toBe("autopilot answered on the user's behalf");
	});
});

describe("fallbacks", () => {
	test("prefer the model's authored recommendation", () => {
		const recommendation = fallbackRecommendation(question({ recommended: "LRU" }), 0, "because");
		expect(recommendation.selected).toEqual(["LRU"]);
	});

	test("fall back to the first option when there is no recommendation", () => {
		expect(fallbackRecommendation(question(), 0, "because").selected).toEqual(["LRU"]);
	});

	test("carry the authored reason alongside the fallback diagnostic", () => {
		const recommendation = fallbackRecommendation(
			question({ recommended: "LRU", recommendedBecause: "cheapest to run" }),
			0,
			"the judge skipped this question",
		);
		expect(recommendation.reason).toBe("cheapest to run (the judge skipped this question)");
	});

	test("answer every question", () => {
		const verdict = fallbackVerdict(questionnaire(question({ header: "A" }), question({ header: "B" })), "boom");
		expect(verdict.recommendations).toHaveLength(2);
		expect(verdict.summary).toBe("boom");
	});
});

describe("synthesizeAnswers", () => {
	test("project a verdict onto the answer envelope with the right source", () => {
		const answers = synthesizeAnswers(verdictOf(JSON.stringify({ recommendations: [{ question: 1, selected: ["LRU"] }] })), cache, "timeout", 30);
		expect(answers).toHaveLength(1);
		expect(answers[0]).toMatchObject({
			index: 0,
			header: "Cache",
			selected: ["LRU"],
			source: "timeout",
			waitedSeconds: 30,
		});
	});

	test("carry a free-text answer through", () => {
		const verdict = verdictOf(
			JSON.stringify({ recommendations: [{ question: 1, selected: [], text: "Use Redis" }] }),
		);
		expect(synthesizeAnswers(verdict, cache, "autopilot")[0]?.text).toBe("Use Redis");
	});

	test("still answer when the verdict is short", () => {
		const answers = synthesizeAnswers({ recommendations: [], summary: "s" }, cache, "autopilot");
		expect(answers[0]?.selected).toEqual(["TTL 5m"]);
	});
});

describe("prompt rendering", () => {
	test("show the judge every option, the recommendation and the context", () => {
		const text = renderQuestionnaire({
			context: "adding a cache layer",
			questions: [question({ recommended: "LRU", recommendedBecause: "cheapest" })],
		});
		expect(text).toContain("adding a cache layer");
		expect(text).toContain("Q1 [Cache]");
		expect(text).toContain("1. LRU — Evict the least recently used entry.");
		expect(text).toContain("<-- model recommends this");
		expect(text).toContain("why the model recommends it: cheapest");
	});

	test("mark multi-select questions so the judge returns several picks", () => {
		const text = renderQuestionnaire(questionnaire(question({ multiSelect: true })));
		expect(text).toContain("multi-select");
	});

	test("build a single-turn request carrying the transcript and the questions", () => {
		const request = buildJudgeRequest("SYSTEM", "[user] do the thing", cache);
		expect(request.systemPrompt).toBe("SYSTEM");
		expect(request.messages).toHaveLength(1);
		const body = request.messages[0]?.content[0]?.text ?? "";
		expect(body).toContain("[user] do the thing");
		expect(body).toContain("TTL 5m");
	});
});

describe("matchOption ambiguity", () => {
	test("takes the longest prefix match, not the first one", () => {
		// `.find` used to pick "No cache" here, because it is a prefix of the
		// judge's text and sits first in the list. Silently choosing the wrong
		// option is the failure mode this whole tier exists to avoid.
		const q = question({
			options: [
				{ label: "No cache", description: "always hit the database" },
				{ label: "No cache with TTL", description: "keep a short-lived copy" },
			],
		});
		expect(matchOption(q, "No cache with TTL 5m")).toBe("No cache with TTL");
		expect(matchOption(q, "No cache")).toBe("No cache");
	});

	test("still refuses a bare substring", () => {
		const q = question({
			options: [
				{ label: "No cache", description: "a" },
				{ label: "No cache with TTL", description: "b" },
			],
		});
		expect(matchOption(q, "with TTL")).toBeUndefined();
	});
});

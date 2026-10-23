import { describe, expect, test } from "bun:test";
import { runAutopilot, type CompleteFn } from "../src/autopilot.ts";
import { defaultConfig } from "../src/config.ts";
import { question, questionnaire } from "./fixtures.ts";

/** Every question carries a stated recommendation → no judge call at all. */
const allStated = questionnaire(question({ recommended: "TTL 5m", recommendedBecause: "nothing to invalidate" }));
/** No stated recommendation → the judge is consulted. */
const noneStated = questionnaire();
/** Mixed: the first question is decided by the caller, the second needs a judge. */
const mixed = questionnaire(
	question({ header: "Cache", recommended: "TTL 5m" }),
	question({
		header: "Scope",
		options: [
			{ label: "Session", description: "one per session" },
			{ label: "Client", description: "shared" },
		],
	}),
);

function config(overrides: Partial<ReturnType<typeof defaultConfig>["judge"]> = {}) {
	const base = defaultConfig();
	return { ...base, judge: { ...base.judge, ...overrides } };
}

function completion(text: string, stopReason = "stop"): CompleteFn {
	return async () => ({ stopReason, content: [{ type: "text", text }] });
}

const GOOD = JSON.stringify({
	summary: "picked TTL",
	recommendations: [{ question: 1, selected: ["TTL 5m"], reason: "nothing to invalidate" }],
});

describe("runAutopilot — the stated recommendation path", () => {
	test("answers every question from the stated recommendation without calling a model", async () => {
		let called = false;
		const result = await runAutopilot(allStated, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: async () => {
				called = true;
				return { stopReason: "stop", content: [] };
			},
		});
		expect(called).toBe(false);
		expect(result.from).toBe("recommendation");
		expect(result.judged).toBe(true);
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		expect(result.verdict.summary).toContain("stated");
	});

	test("still answers when no model is available at all", async () => {
		const result = await runAutopilot(allStated, config(), {
			transcript: "",
			resolveModel: () => undefined,
			complete: async () => {
				throw new Error("should not be called");
			},
		});
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
	});

	test("a stated recommendation is never overruled by a returning judge", async () => {
		// The judge is asked only about the un-recommended question, so even if it
		// tries to answer question 1 it cannot move the stated pick.
		const result = await runAutopilot(mixed, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: completion(
				JSON.stringify({
					summary: "s",
					recommendations: [
						{ question: 1, selected: ["LRU"], reason: "wrong question" },
						{ question: 2, selected: ["Client"], reason: "shared is simpler" },
					],
				}),
			),
		});
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		// The subset renumbers questions 1..n, so the judge's "question 2" is
		// ignored (it does not exist there) and its "question 1" — addressed to the
		// Scope question — lands on Scope. The stated Cache pick is untouched.
		expect(result.verdict.recommendations[1]?.selected).toEqual(["Session"]);
	});

	test("sends only the un-recommended questions to the judge", async () => {
		let seen = "";
		await runAutopilot(mixed, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: async (request) => {
				seen = request.messages[0]?.content[0]?.text ?? "";
				return { stopReason: "stop", content: [{ type: "text", text: "{}" }] };
			},
		});
		expect(seen).toContain("Scope");
		expect(seen).not.toContain("Cache");
	});
});

describe("runAutopilot — the judge path", () => {
	test("returns the judged verdict and says where it came from", async () => {
		const result = await runAutopilot(noneStated, config(), {
			transcript: "[user] add a cache",
			resolveModel: () => ({ id: "fake" }),
			complete: completion(GOOD),
		});
		expect(result.judged).toBe(true);
		expect(result.from).toBe("judge");
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
	});

	test("passes the transcript and the questions to the judge", async () => {
		let seen = "";
		await runAutopilot(noneStated, config(), {
			transcript: "[user] add a cache layer to the client",
			resolveModel: () => ({ id: "fake" }),
			complete: async (request) => {
				seen = request.messages.map((message) => message.content.map((block) => block.text).join("")).join("");
				return { stopReason: "stop", content: [{ type: "text", text: GOOD }] };
			},
		});
		expect(seen).toContain("add a cache layer");
		expect(seen).toContain("TTL 5m");
	});

	test("honours a prompt override", async () => {
		let system = "";
		await runAutopilot(noneStated, config(), {
			transcript: "",
			promptText: "USE THIS PROMPT",
			resolveModel: () => ({ id: "fake" }),
			complete: async (request) => {
				system = request.systemPrompt;
				return { stopReason: "stop", content: [{ type: "text", text: GOOD }] };
			},
		});
		expect(system).toBe("USE THIS PROMPT");
	});
});

describe("runAutopilot — every failure still answers", () => {
	const cases: Array<{ name: string; deps: () => Partial<Parameters<typeof runAutopilot>[2]>; expect: string }> = [
		{
			name: "no model available",
			deps: () => ({ resolveModel: () => undefined }),
			expect: "no model available",
		},
		{
			name: "the call throws",
			deps: () => ({
				resolveModel: () => ({ id: "fake" }),
				complete: async () => {
					throw new Error("401 unauthorized");
				},
			}),
			expect: "401",
		},
		{
			name: "the judge did not finish",
			deps: () => ({ resolveModel: () => ({ id: "fake" }), complete: completion("", "error") }),
			expect: "stopReason=error",
		},
		{
			name: "the prose is unreadable",
			deps: () => ({ resolveModel: () => ({ id: "fake" }), complete: completion("I'd pick the TTL one.") }),
			expect: "unparsable",
		},
		{
			name: "the reply is empty",
			deps: () => ({ resolveModel: () => ({ id: "fake" }), complete: completion("   ") }),
			expect: "empty",
		},
	];

	for (const { name, deps, expect: expected } of cases) {
		test(`${name} → falls back to the first option and reports why`, async () => {
			const result = await runAutopilot(noneStated, config(), {
				transcript: "",
				log: () => {},
				...deps(),
			} as Parameters<typeof runAutopilot>[2]);
			expect(result.judged).toBe(false);
			expect(result.from).toBe("fallback");
			expect(result.fallbackReason).toContain(expected);
			// The invariant: an answer, always.
			expect(result.verdict.recommendations).toHaveLength(1);
			expect(result.verdict.recommendations[0]?.selected).toEqual(["LRU"]);
		});
	}

	test("keeps the stated recommendation for the questions that had one, even when the judge fails", async () => {
		const result = await runAutopilot(mixed, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: async () => {
				throw new Error("boom");
			},
		});
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		// Scope had no recommendation, so it falls back to its own first option.
		expect(result.verdict.recommendations[1]?.selected).toEqual(["Session"]);
	});

	test("aborts a judge that overruns its budget, then falls back", async () => {
		let sawAbort = false;
		const result = await runAutopilot(noneStated, config({ timeoutMs: 1_000 }), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: (_request, options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => {
						sawAbort = true;
						reject(new Error("aborted"));
					});
				}),
		});
		expect(sawAbort).toBe(true);
		expect(result.judged).toBe(false);
		expect(result.verdict.recommendations[0]?.selected).toEqual(["LRU"]);
	}, 10_000);

	test("propagates external cancellation into the judge call", async () => {
		const controller = new AbortController();
		let sawAbort = false;
		const result = await runAutopilot(noneStated, config(), {
			transcript: "",
			signal: controller.signal,
			resolveModel: () => ({ id: "fake" }),
			complete: (_request, options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => {
						sawAbort = true;
						reject(new Error("aborted"));
					});
					controller.abort();
				}),
		});
		expect(sawAbort).toBe(true);
		expect(result.judged).toBe(false);
	});
});

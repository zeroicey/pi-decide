import { describe, expect, test } from "bun:test";
import { runAutopilot, type CompleteFn } from "../src/autopilot.ts";
import { defaultConfig } from "../src/config.ts";
import { question, questionnaire } from "./fixtures.ts";

const cache = questionnaire(question({ recommended: "TTL 5m", recommendedBecause: "nothing to invalidate" }));

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

describe("runAutopilot", () => {
	test("returns the judged verdict and says so", async () => {
		const result = await runAutopilot(cache, config(), {
			transcript: "[user] add a cache",
			resolveModel: () => ({ id: "fake" }),
			complete: completion(GOOD),
		});
		expect(result.judged).toBe(true);
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
	});

	test("answers from the stated recommendation when no model is available", async () => {
		const result = await runAutopilot(cache, config(), {
			transcript: "",
			resolveModel: () => undefined,
			complete: async () => {
				throw new Error("should not be called");
			},
		});
		expect(result.judged).toBe(false);
		expect(result.fallbackReason).toBe("no model available");
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
	});

	test("answers from the stated recommendation when the call throws", async () => {
		const logs: string[] = [];
		const result = await runAutopilot(cache, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: async () => {
				throw new Error("401 unauthorized");
			},
			log: (message) => logs.push(message),
		});
		expect(result.judged).toBe(false);
		expect(result.fallbackReason).toContain("401");
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
		expect(logs.join("\n")).toContain("401");
	});

	test("answers from the stated recommendation when the judge did not finish", async () => {
		const result = await runAutopilot(cache, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: completion("", "error"),
		});
		expect(result.judged).toBe(false);
		expect(result.fallbackReason).toContain("stopReason=error");
	});

	test("answers from the stated recommendation when the judge's prose is unreadable", async () => {
		const result = await runAutopilot(cache, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: completion("I would probably go with the TTL one."),
		});
		expect(result.judged).toBe(false);
		expect(result.fallbackReason).toBe("unparsable");
	});

	test("treats an empty reply as unreadable, not as a crash", async () => {
		const result = await runAutopilot(cache, config(), {
			transcript: "",
			resolveModel: () => ({ id: "fake" }),
			complete: completion("   "),
		});
		expect(result.judged).toBe(false);
		expect(result.fallbackReason).toBe("empty");
	});

	test("aborts a judge that overruns its budget, then falls back", async () => {
		let sawAbort = false;
		const result = await runAutopilot(cache, config({ timeoutMs: 1_000 }), {
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
		// The clamp in config.ts only runs on file input; runAutopilot honours what it is given.
		expect(sawAbort).toBe(true);
		expect(result.judged).toBe(false);
		expect(result.verdict.recommendations[0]?.selected).toEqual(["TTL 5m"]);
	}, 10_000);

	test("propagates external cancellation into the judge call", async () => {
		const controller = new AbortController();
		let sawAbort = false;
		const pending = runAutopilot(cache, config(), {
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
		const result = await pending;
		expect(sawAbort).toBe(true);
		expect(result.judged).toBe(false);
	});

	test("passes the transcript and the questions to the judge", async () => {
		let seen = "";
		await runAutopilot(cache, config(), {
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
		await runAutopilot(cache, config(), {
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

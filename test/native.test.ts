/**
 * The native prompt path: what a host that cannot render `custom()` gets.
 *
 * Everything here runs against a scripted prompter, so the tests describe the
 * card a human sees (title + rows) and the outcome the tool envelope receives.
 */

import { describe, expect, test } from "bun:test";
import { askNatively, DONE_LABEL, nativeTitle } from "../src/ui/native.ts";
import { question, questionnaire } from "./fixtures.ts";

interface Call {
	title: string;
	options: string[];
	timeout?: number;
}

/** A prompter that answers from a script and remembers what it was shown. */
function scripted(answers: (string | undefined)[], hooks: { onAsk?: () => void } = {}) {
	const calls: Call[] = [];
	return {
		calls,
		async select(title: string, options: string[], opts?: { timeout?: number }) {
			calls.push({ title, options, ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}) });
			hooks.onAsk?.();
			return answers.shift();
		},
	};
}

describe("nativeTitle", () => {
	test("leads with the question and the recommendation", () => {
		const title = nativeTitle(
			question({ recommended: "TTL 5m", recommendedBecause: "cheapest to reason about" }),
			{ index: 0, total: 1 },
		);
		expect(title.startsWith("Which cache eviction policy")).toBe(true);
		expect(title).toContain("Recommended: TTL 5m — cheapest to reason about");
		expect(title).toContain("Pick one, or type your own answer.");
	});

	test("folds a preview in, truncated", () => {
		const title = nativeTitle(
			question({
				header: "Migration",
				options: [
					{ label: "Rename", description: "Rename the column.", preview: "x".repeat(2_000) },
					{ label: "Copy", description: "Copy and swap." },
				],
			}),
			{ index: 1, total: 2 },
		);
		expect(title).toContain("Preview — Rename:");
		expect(title).toContain("…");
		expect(title.length).toBeLessThan(900);
		expect(title).toContain("(2 of 2)");
	});

	test("explains the toggle loop for multi-select", () => {
		const title = nativeTitle(question({ multiSelect: true }), { index: 0, total: 1 });
		expect(title).toContain(DONE_LABEL);
		expect(title).not.toContain("Pick one");
	});
});

describe("askNatively", () => {
	test("asks one prompt per question, in order, and records the label", async () => {
		const prompter = scripted(["LRU", "TTL 5m"]);
		const outcome = await askNatively(
			prompter,
			questionnaire(question(), question({ header: "Release", question: "Ship it tonight?" })),
			0,
		);

		expect(prompter.calls).toHaveLength(2);
		expect(prompter.calls[0]!.options).toEqual(["LRU", "TTL 5m", "No cache"]);
		expect(prompter.calls[1]!.title.startsWith("Ship it tonight?")).toBe(true);
		expect(outcome.kind).toBe("answered");
		if (outcome.kind !== "answered") return;
		expect(outcome.answers.get(0)).toEqual({ selected: ["LRU"] });
		expect(outcome.answers.get(1)).toEqual({ selected: ["TTL 5m"] });
	});

	test("marks the recommended row and still answers with the authored label", async () => {
		const prompter = scripted(["LRU ★ recommended"]);
		const outcome = await askNatively(prompter, questionnaire(question({ recommended: "LRU" })), 0);

		expect(prompter.calls[0]!.options[0]).toBe("LRU ★ recommended");
		if (outcome.kind !== "answered") throw new Error("expected an answer");
		expect(outcome.answers.get(0)).toEqual({ selected: ["LRU"] });
	});

	test("accepts the bare label when the host strips the marking", async () => {
		const prompter = scripted(["LRU"]);
		const outcome = await askNatively(prompter, questionnaire(question({ recommended: "LRU" })), 0);

		if (outcome.kind !== "answered") throw new Error("expected an answer");
		expect(outcome.answers.get(0)).toEqual({ selected: ["LRU"] });
	});

	test("keeps a typed answer as free text instead of an option", async () => {
		const prompter = scripted(["Something else entirely"]);
		const outcome = await askNatively(prompter, questionnaire(), 0);

		if (outcome.kind !== "answered") throw new Error("expected an answer");
		expect(outcome.answers.get(0)).toEqual({ selected: [], text: "Something else entirely" });
	});

	test("dismissing a prompt cancels the whole questionnaire", async () => {
		const prompter = scripted([undefined]);
		const outcome = await askNatively(prompter, questionnaire(question(), question({ header: "Next" })), 0);

		expect(outcome.kind).toBe("cancelled");
		expect(prompter.calls).toHaveLength(1);
	});

	test("the deadline is handed to the host, so its own prompt dismisses", async () => {
		const prompter = scripted(["LRU"]);
		await askNatively(prompter, questionnaire(), 30, { now: () => 1_000 });
		expect(prompter.calls[0]!.timeout).toBe(30_000);
	});

	test("an expired deadline becomes an autopilot hand-off, not a refusal", async () => {
		let now = 0;
		const prompter = scripted([undefined], { onAsk: () => (now = 31_000) });
		const outcome = await askNatively(prompter, questionnaire(), 30, { now: () => now });

		expect(outcome).toEqual({ kind: "autopilot", waitedSeconds: 31 });
	});

	test("a deadline that already passed asks nothing at all", async () => {
		let reads = 0;
		const now = () => (reads++ === 0 ? 0 : 1_000_000);
		const prompter = scripted(["LRU"]);
		const outcome = await askNatively(prompter, questionnaire(), 1, { now });

		expect(prompter.calls).toHaveLength(0);
		expect(outcome.kind).toBe("autopilot");
	});

	test("multi-select toggles one row at a time and ends on Done", async () => {
		const prompter = scripted(["◻ TTL 5m", "◻ LRU", "✅ Done"]);
		const outcome = await askNatively(prompter, questionnaire(question({ multiSelect: true })), 0);

		expect(prompter.calls.map((call) => call.options.at(-1))).toEqual([DONE_LABEL, DONE_LABEL, DONE_LABEL]);
		expect(prompter.calls[1]!.options).toContain("✅ TTL 5m");
		if (outcome.kind !== "answered") throw new Error("expected an answer");
		// Authored order, not tap order.
		expect(outcome.answers.get(0)).toEqual({ selected: ["LRU", "TTL 5m"] });
	});

	test("tapping a selected row again unselects it", async () => {
		const prompter = scripted(["◻ LRU", "✅ LRU", "◻ No cache", "✅ Done"]);
		const outcome = await askNatively(prompter, questionnaire(question({ multiSelect: true })), 0);

		if (outcome.kind !== "answered") throw new Error("expected an answer");
		expect(outcome.answers.get(0)).toEqual({ selected: ["No cache"] });
	});

	test("a typed answer inside the toggle loop is kept alongside the picks", async () => {
		const prompter = scripted(["◻ LRU", "Use Redis instead"]);
		const outcome = await askNatively(prompter, questionnaire(question({ multiSelect: true })), 0);

		if (outcome.kind !== "answered") throw new Error("expected an answer");
		expect(outcome.answers.get(0)).toEqual({ selected: ["LRU"], text: "Use Redis instead" });
	});

	test("Done with nothing picked leaves the question unanswered", async () => {
		const prompter = scripted(["✅ Done"]);
		const outcome = await askNatively(prompter, questionnaire(question({ multiSelect: true })), 0);

		expect(outcome.kind).toBe("cancelled");
		expect(prompter.calls).toHaveLength(1);
	});
});

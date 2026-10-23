import { describe, expect, test } from "bun:test";
import { findIrreversible, guardChoice, looksConservative, looksIrreversible, needsHuman } from "../src/safety.ts";
import { question } from "./fixtures.ts";

const destructive = question({
	header: "Data",
	question: "The staging table is 4 GB. Drop it to free space?",
	options: [
		{ label: "Drop it", description: "rm -rf the table, no backup" },
		{ label: "Back up first", description: "dump it, then drop" },
	],
});

const forcePush = question({
	header: "Git",
	question: "The remote has diverged. How should I sync?",
	options: [
		{ label: "Force push", description: "overwrite the remote branch" },
		{ label: "Merge", description: "keep both histories" },
	],
});

const harmless = question({
	question: "Which cache eviction policy should the session store use?",
	options: [
		{ label: "LRU", description: "evict the least recently used entry" },
		{ label: "TTL 5m", description: "expire after five minutes" },
	],
});

describe("looksIrreversible", () => {
	test("catches the phrasings that actually appear", () => {
		for (const text of [
			"rm -rf /data",
			"delete the table",
			"DROP TABLE users",
			"force-push to main",
			"force push",
			"git reset --hard",
			"overwrite the file",
			"destroy the volume",
			"wipe the disk",
			"purge the cache",
			"revoke the token",
			"rotate the key",
			"publish to npm",
			"deploy to prod",
			"spend the credits",
			"charge the card",
			"this costs money",
		]) {
			expect({ text, result: looksIrreversible(text) }).toEqual({ text, result: true });
		}
	});

	test("leaves ordinary engineering choices alone", () => {
		for (const text of [
			"Which cache eviction policy?",
			"Use TypeScript or JavaScript?",
			"Rename the module",
			"Add a test",
			"Which port should the dev server use?",
		]) {
			expect({ text, result: looksIrreversible(text) }).toEqual({ text, result: false });
		}
	});
});

describe("looksConservative", () => {
	test("recognises the cautious paths", () => {
		for (const text of [
			"Abort and ask me",
			"Skip it",
			"Keep the branch",
			"Back up first",
			"Do nothing",
			"Dry run only",
			"Do not delete anything",
			"Wait for a human",
		]) {
			expect({ text, result: looksConservative(text) }).toEqual({ text, result: true });
		}
	});
});

describe("needsHuman", () => {
	test("triggers on the model's own declaration", () => {
		expect(needsHuman(question({ irreversible: true }))).toBe(true);
	});

	test("triggers on the question wording", () => {
		expect(needsHuman(destructive)).toBe(true);
		expect(needsHuman(forcePush)).toBe(true);
	});

	test("triggers on an option's wording, not just the question", () => {
		const sneaky = question({
			question: "How should we proceed?",
			options: [
				{ label: "Continue", description: "drop the staging table as part of the migration" },
				{ label: "Hold", description: "wait" },
			],
		});
		expect(needsHuman(sneaky)).toBe(true);
	});

	test("stays out of the way for a benign decision", () => {
		expect(needsHuman(harmless)).toBe(false);
	});
});

describe("guardChoice", () => {
	test("leaves a benign question untouched", () => {
		expect(guardChoice(harmless, ["LRU"])).toBeUndefined();
	});

	test("steers an irreversible choice onto the cautious option", () => {
		expect(guardChoice(destructive, ["Drop it"])).toBe("Back up first");
	});

	test("leaves a choice that is already cautious alone", () => {
		expect(guardChoice(destructive, ["Back up first"])).toBeUndefined();
	});

	test("refuses (null) when an irreversible question has no cautious option", () => {
		const noExit = question({
			header: "Key",
			question: "Rotate the production key now?",
			options: [
				{ label: "Rotate immediately", description: "old clients break" },
				{ label: "Rotate tonight", description: "still breaks old clients" },
			],
		});
		expect(guardChoice(noExit, ["Rotate immediately"])).toBeNull();
	});

	test("a declaration alone is enough, even when the wording looks harmless", () => {
		const declared = question({
			question: "Which config should we load?",
			options: [
				{ label: "Production", description: "the live one" },
				{ label: "Keep the current one", description: "do nothing" },
			],
			irreversible: true,
		});
		expect(guardChoice(declared, ["Production"])).toBe("Keep the current one");
	});
});

describe("findIrreversible", () => {
	test("names every question that must not be auto-answered", () => {
		const findings = findIrreversible({ questions: [harmless, destructive, forcePush] });
		expect(findings.map((finding) => finding.header)).toEqual(["Data", "Git"]);
		expect(findings[0]?.conservativeOptions).toEqual(["Back up first"]);
		expect(findings[1]?.conservativeOptions).toEqual(["Merge"]);
	});

	test("returns nothing for a questionnaire that is safe to automate", () => {
		expect(findIrreversible({ questions: [harmless] })).toEqual([]);
	});
});

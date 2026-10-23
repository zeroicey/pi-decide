import { describe, expect, test } from "bun:test";
import { buildTranscript, compact, textOf } from "../src/transcript.ts";
import { messageEntry, textBlock } from "./fixtures.ts";

const options = { tailMessages: 5, maxTailChars: 4000 };

describe("textOf", () => {
	test("reads strings and text blocks, ignoring the rest", () => {
		expect(textOf("plain")).toBe("plain");
		expect(textOf([textBlock("a"), { type: "thinking", thinking: "hmm" }, textBlock("b")])).toBe("ab");
		expect(textOf(undefined)).toBe("");
		expect(textOf({})).toBe("");
	});
});

describe("compact", () => {
	test("leaves short text alone and marks what it dropped", () => {
		expect(compact("short", 10)).toBe("short");
		expect(compact("abcdefghij", 4)).toBe("abcd…(6 chars omitted)");
	});
});

describe("buildTranscript", () => {
	test("renders the roles the judge needs to follow the run", () => {
		const text = buildTranscript(
			[
				messageEntry("user", "add a cache layer"),
				messageEntry("assistant", [textBlock("I will look at the client first.")]),
				messageEntry("toolResult", [textBlock("src/api/client.ts: 120 lines")], { toolName: "read" }),
			],
			options,
		);
		expect(text).toContain("[user] add a cache layer");
		expect(text).toContain("[assistant] I will look at the client first.");
		expect(text).toContain("[tool result] src/api/client.ts: 120 lines");
	});

	test("labels tool calls and thinking", () => {
		const text = buildTranscript(
			[
				messageEntry("assistant", [
					{ type: "thinking", thinking: "maybe redis" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					textBlock("done"),
				]),
			],
			options,
		);
		expect(text).toContain("[thinking] maybe redis");
		expect(text).toContain('[tool call read({"path":"a.ts"})]');
	});

	test("spends the budget newest-first, so the recent turns survive", () => {
		const entries = Array.from({ length: 10 }, (_, index) => messageEntry("user", `message ${index}`));
		const text = buildTranscript(entries, { tailMessages: 3, maxTailChars: 4000 });
		expect(text).toContain("message 9");
		expect(text).toContain("message 8");
		expect(text).toContain("message 7");
		expect(text).not.toContain("message 6");
	});

	test("caps the total size", () => {
		const entries = [messageEntry("user", "x".repeat(500)), messageEntry("assistant", [textBlock("y".repeat(500))])];
		const text = buildTranscript(entries, { tailMessages: 5, maxTailChars: 200 });
		expect(text.length).toBeLessThan(300);
		expect(text).toContain("chars omitted");
	});

	test("skips entries that carry no prose", () => {
		const text = buildTranscript(
			[messageEntry("user", "hello"), messageEntry("assistant", []), messageEntry("user", "again")],
			options,
		);
		expect(text).toBe("[user] hello\n\n[user] again");
	});

	test("returns an empty string for an empty session", () => {
		expect(buildTranscript([], options)).toBe("");
	});
});

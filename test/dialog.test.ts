import { describe, expect, test } from "bun:test";
import { QuestionnaireDialog, type DialogOutcome } from "../src/ui/dialog.ts";
import { question, questionnaire } from "./fixtures.ts";
import { fakeTheme, fakeTui, KEY, makeHarness, stripAnsi } from "./harness.ts";

function open(
	q: ReturnType<typeof questionnaire>,
	timeoutSeconds = 0,
) {
	const outcomes: DialogOutcome[] = [];
	const dialog = new QuestionnaireDialog({
		questionnaire: q,
		...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
		tui: fakeTui() as never,
		theme: fakeTheme(),
		keybindings: {} as never,
		done: (outcome) => outcomes.push(outcome),
	});
	const harness = makeHarness(dialog);
	return { dialog, harness, outcomes, last: () => outcomes[outcomes.length - 1] };
}

const three = () => question();
const options = [
	{ label: "LRU", description: "Evict the least recently used entry." },
	{ label: "TTL 5m", description: "Expire entries five minutes after write." },
	{ label: "No cache", description: "Drop the cache and always hit the database." },
];

describe("rendering", () => {
	test("shows the question, its options, the appended rows and the key hints", () => {
		const { dialog } = open(questionnaire(question()));
		const text = dialog.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("Which cache eviction policy");
		expect(text).toContain("1. LRU");
		expect(text).toContain("Evict the least recently used entry.");
		expect(text).toContain("Type something.");
		expect(text).toContain("Add a note");
		expect(text).toContain("Esc cancel");
	});

	test("marks the recommended option with a star", () => {
		const { dialog } = open(questionnaire(question({ recommended: "TTL 5m" })));
		const text = dialog.render(80).map(stripAnsi).join("\n");
		expect(text).toMatch(/2\. TTL 5m\s+★/);
	});

	test("hides the tab strip for a single question but shows it for several", () => {
		expect(open(questionnaire(question())).dialog.render(80).map(stripAnsi).join("\n")).not.toContain("Submit");
		const multi = open(questionnaire(question({ header: "Cache" }), question({ header: "Scope" })));
		const text = multi.dialog.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("□ Cache");
		expect(text).toContain("□ Scope");
		expect(text).toContain("✔ Submit");
	});

	test("renders a preview beside the focused option", () => {
		const withPreview = question({
			options: [
				{ label: "Cache", description: "add one", preview: "client -> cache -> api" },
				{ label: "No cache", description: "skip it" },
			],
		});
		const text = open(questionnaire(withPreview)).dialog.render(80).map(stripAnsi).join("\n");
		expect(text).toContain("preview: Cache");
		expect(text).toContain("client -> cache -> api");
	});

	test("never emits a line wider than the requested width", () => {
		const { dialog } = open(
			questionnaire(
				question({
					question: "x".repeat(300),
					options: [
						{ label: "a".repeat(120), description: "b".repeat(200) },
						{ label: "c", description: "d" },
					],
				}),
			),
		);
		for (const width of [24, 40, 80, 120]) {
			for (const line of dialog.render(width)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("keyboard", () => {
	test("Enter on a single question answers it and closes the dialog", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.enter);
		expect(last()).toMatchObject({ kind: "answered" });
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.selected).toEqual(["LRU"]);
	});

	test("arrow keys move the highlight and Enter picks the highlighted option", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.down, KEY.down, KEY.enter);
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.selected).toEqual(["No cache"]);
	});

	test("the highlight stops at the ends instead of wrapping", () => {
		const { harness } = open(questionnaire(question()));
		harness.press(KEY.up, KEY.up);
		expect(harness.lastText()).toContain("❯ 1. LRU");
	});

	test("Escape cancels", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.esc);
		expect(last()).toEqual({ kind: "cancelled" });
	});

	test("answers several questions across tabs and submits", () => {
		const { harness, last } = open(questionnaire(question({ header: "A" }), question({ header: "B" })));
		harness.press(KEY.enter); // answers A, advances to B
		expect(harness.lastText()).toContain("B");
		harness.press(KEY.enter); // answers B, advances to Submit
		expect(harness.lastText()).toContain("Review before submitting");
		harness.press(KEY.enter); // submits
		const outcome = last();
		expect(outcome?.kind).toBe("answered");
		if (outcome?.kind !== "answered") return;
		expect([...outcome.answers.values()].map((answer) => answer.selected)).toEqual([["LRU"], ["LRU"]]);
	});

	test("Submit refuses until every question is answered, and jumps to the gap", () => {
		const { harness, last } = open(questionnaire(question({ header: "A" }), question({ header: "B" })));
		harness.press(KEY.enter); // A -> B
		harness.press(KEY.right); // B -> Submit without answering B
		expect(harness.lastText()).toContain("unanswered");
		harness.press(KEY.enter); // should jump back to B, not submit
		expect(last()).toBeUndefined();
		expect(harness.lastText()).toContain("Which cache eviction policy");
	});

	test("Tab and Shift+Tab move between questions", () => {
		const { harness } = open(questionnaire(question({ header: "A" }), question({ header: "B" })));
		expect(harness.lastText()).toContain("A");
		harness.press(KEY.tab);
		expect(harness.lastText()).toContain("B");
		harness.press(KEY.shiftTab);
		expect(harness.lastText()).toContain("A");
	});

	test("multi-select toggles with Space and submits what was checked", () => {
		const multi = question({ multiSelect: true });
		const { harness, last } = open(questionnaire(multi));
		harness.press(KEY.space); // check LRU
		harness.press(KEY.down, KEY.space); // check TTL
		expect(harness.lastText()).toContain("◉ LRU");
		harness.press(KEY.enter);
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.selected).toEqual(["LRU", "TTL 5m"]);
	});

	test("a free-text answer replaces the selected option", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.down, KEY.down, KEY.down); // Type something.
		harness.press(KEY.enter); // open the editor
		harness.press("Use", " ", "Redis");
		harness.press(KEY.enter);
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]).toMatchObject({
			text: "Use Redis",
			selected: [],
		});
	});

	test("Escape in the free-text editor returns to the list without answering", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.down, KEY.down, KEY.down, KEY.enter);
		harness.press("abc");
		harness.press(KEY.esc);
		expect(last()).toBeUndefined();
		// Back on the list: the draft is gone, and picking an option answers normally.
		expect(harness.lastText()).toContain("↑↓ move");
		harness.press(KEY.up, KEY.up, KEY.up, KEY.enter);
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.text).toBeUndefined();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.selected).toEqual(["LRU"]);
	});

	test("n attaches a note to the current answer", () => {
		const { harness, last } = open(questionnaire(question()));
		harness.press(KEY.note);
		harness.press("because", " ", "cheap");
		harness.press(KEY.enter);
		harness.press(KEY.enter); // pick LRU
		const outcome = last();
		expect(outcome?.kind === "answered" && [...outcome.answers.values()][0]?.note).toBe("because cheap");
	});

	test("n on the Submit tab captures one global note", () => {
		const { harness, last } = open(questionnaire(question({ header: "A" }), question({ header: "B" })));
		harness.press(KEY.enter, KEY.enter); // answer both, land on Submit
		harness.press(KEY.note);
		harness.press("overall", " ", "fine");
		harness.press(KEY.enter);
		expect(harness.lastText()).toContain("global note: overall fine");
		harness.press(KEY.enter);
		const outcome = last();
		expect(outcome?.kind === "answered" && outcome.globalNote).toBe("overall fine");
	});

	test("ctrl+] collapses the dialog and brings it back", () => {
		const { harness } = open(questionnaire(question()));
		harness.press(KEY.ctrlRightBracket);
		const collapsed = harness.lastText();
		expect(collapsed).toContain("ctrl+] to expand");
		expect(collapsed.split("\n")).toHaveLength(1);
		harness.press(KEY.ctrlRightBracket);
		expect(harness.lastText()).toContain("Which cache eviction policy");
	});
});

describe("countdown", () => {
	test("shows the remaining seconds when a timeout is configured", () => {
		const { dialog } = open(questionnaire(question()), 30);
		expect(dialog.render(80).map(stripAnsi).join("\n")).toContain("autopilot answers in 30s");
	});

	test("shows no countdown by default", () => {
		const { dialog } = open(questionnaire(question()));
		expect(dialog.render(80).map(stripAnsi).join("\n")).not.toContain("autopilot answers");
	});

	test("touching a key hands control back to the human", () => {
		const { harness, dialog, outcomes } = open(questionnaire(question()), 30);
		harness.press(KEY.down);
		expect(dialog.render(80).map(stripAnsi).join("\n")).not.toContain("autopilot answers");
		expect(outcomes).toHaveLength(0);
	});
});

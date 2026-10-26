/**
 * Layout invariants, swept over a grid of geometries.
 *
 * Every claim the README makes about fitting a small terminal is asserted here
 * against the renderer rather than trusted. The grid exists because the bugs
 * this catches (a clamp that widened past the host, a budget the component
 * quietly exceeded, an option list that windowed one row too tall) only show up
 * at particular sizes -- and the sizes that break are never the ones you think
 * to try by hand.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireDialog } from "../src/ui/dialog.ts";
import { MIN_HEIGHT } from "../src/ui/view.ts";
import { question, questionnaire } from "../test/fixtures.ts";
import { fakeTheme, KEY, stripAnsi } from "./harness.ts";

const COLUMNS = [20, 24, 30, 40, 56, 80, 100, 140];
const ROWS = [6, 8, 10, 14, 20, 30, 50];

interface Geometry {
	cols: number;
	rows: number;
	multi: boolean;
	options: number;
	questions: number;
	preview: boolean;
}

function build({ cols, rows, multi, options, questions, preview }: Geometry, keys: string[] = []) {
	const tui = { terminal: { rows, columns: cols }, requestRender: () => {} };
	const opts = Array.from({ length: options }, (_, index) => ({
		label: `Option ${index + 1}`,
		description: "a one sentence description of the choice",
		...(preview && index === 0 ? { preview: "client -> cache -> api\nsecond line" } : {}),
	}));
	const qs = Array.from({ length: questions }, (_, index) =>
		question({ header: `Q${index + 1}`, options: opts, multiSelect: multi, recommended: "Option 2" }),
	);
	const dialog = new QuestionnaireDialog({
		questionnaire: questionnaire(...qs),
		tui: tui as never,
		theme: fakeTheme(),
		keybindings: {} as never,
		done: () => {},
	});
	for (const key of keys) dialog.handleInput(key);
	const lines = dialog.render(cols);
	return {
		dialog,
		lines,
		plain: lines.map(stripAnsi),
		text: lines.map(stripAnsi).join("\n"),
		budget: Math.max(1, rows - Math.max(5, Math.floor(rows * 0.25))),
	};
}

describe("layout invariants across the geometry grid", () => {
	test("no rendered line is ever wider than the width it was given", () => {
		const failures: string[] = [];
		for (const cols of COLUMNS) {
			for (const rows of ROWS) {
				for (const multi of [false, true]) {
					const { lines } = build({ cols, rows, multi, options: 4, questions: 2, preview: false });
					for (const line of lines) {
						const width = visibleWidth(line);
						// A terminal hard-wraps an over-wide line and every row after it
						// shifts, so this is a frame-tearing bug, not cosmetic.
						if (width > cols) failures.push(`${cols}x${rows} multi=${multi}: ${width} > ${cols}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("the dialog never claims more rows than the host allotted it", () => {
		const failures: string[] = [];
		for (const cols of [24, 40, 80]) {
			for (const rows of ROWS) {
				for (const multi of [false, true]) {
					for (const questions of [1, 3, 6]) {
						const { lines, budget } = build({ cols, rows, multi, options: 6, questions, preview: true });
						if (lines.length > budget) failures.push(`${cols}x${rows} q=${questions}: ${lines.length} > ${budget}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("an expanded dialog always shows the question and the way out", () => {
		const failures: string[] = [];
		for (const cols of COLUMNS) {
			for (const rows of ROWS) {
				for (const multi of [false, true]) {
					const { lines, plain, text } = build({ cols, rows, multi, options: 3, questions: 2, preview: false });
					// One row means the dialog degraded to its collapsed summary: that
					// frame names its own toggle instead of the legend.
					if (lines.length <= 1) continue;
					if (!/Which\s+cache/.test(text)) failures.push(`${cols}x${rows} multi=${multi}: no question`);
					if (!/Esc/.test(text)) failures.push(`${cols}x${rows} multi=${multi}: no escape hint`);
					if (plain.some((line) => line.trim().length === 0 && plain.length > 1 && plain.indexOf(line) === 0)) {
						failures.push(`${cols}x${rows} multi=${multi}: blank first line`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("the highlighted row carries the marker its mode implies", () => {
		const failures: string[] = [];
		for (const cols of [30, 40, 56, 80, 140]) {
			for (const rows of [12, 20, 30, 50]) {
				for (const multi of [false, true]) {
					for (const keys of [[], [KEY.down], [KEY.down, KEY.down, KEY.down]]) {
						const { plain } = build({ cols, rows, multi, options: 5, questions: 1, preview: false }, [...keys]);
						const line = plain.find((candidate) => candidate.includes("❯"));
						if (line === undefined) {
							failures.push(`${cols}x${rows} multi=${multi}: no highlight`);
							continue;
						}
						// The appended action rows are not pickable and carry a blank
						// marker, so they are a legitimate highlight target.
						if (!/Option \d|Type something|Add a note|…/.test(line)) {
							failures.push(`${cols}x${rows} multi=${multi}: highlight on ${JSON.stringify(line)}`);
						}
						if (/Option \d/.test(line)) {
							if (multi && !/[✓▢]/.test(line)) failures.push(`${cols}x${rows}: multi row without a box`);
							if (!multi && !/\d\./.test(line)) failures.push(`${cols}x${rows}: single row without a number`);
						}
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("a collapsed dialog is exactly one self-describing row at every width", () => {
		for (const cols of COLUMNS) {
			const { lines, text } = build({ cols, rows: 30, multi: true, options: 4, questions: 2, preview: true }, ["c"]);
			expect(lines).toHaveLength(1);
			// The one thing that may never be lost: how to get the dialog back.
			// The product name and the answered count are dropped before this is.
			expect(text).toMatch(/expand/i);
			expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(cols);
		}
	});

	test("a terminal too short for a dialog degrades instead of showing a fragment", () => {
		// 20 rows of 5 lines cannot hold a title, a wrapped question and the hints.
		for (const [cols, rows] of [
			[20, 6],
			[20, 8],
			[24, 8],
		] as const) {
			const { lines, budget } = build({ cols, rows, multi: false, options: 2, questions: 1, preview: false });
			expect(lines.length).toBeLessThanOrEqual(budget);
			expect(budget).toBeLessThan(MIN_HEIGHT);
			expect(lines).toHaveLength(1);
			expect(stripAnsi(lines[0] ?? "")).toMatch(/expand/i);
		}
	});
});

describe("the Submit page under pressure", () => {
	function submitPage(cols: number, rows: number, questions: number) {
		const tui = { terminal: { rows, columns: cols }, requestRender: () => {} };
		const dialog = new QuestionnaireDialog({
			questionnaire: questionnaire(
				...Array.from({ length: questions }, (_, index) => question({ header: `Q${index + 1}` })),
			),
			tui: tui as never,
			theme: fakeTheme(),
			keybindings: {} as never,
			done: () => {},
		});
		dialog.handleInput(KEY.enter); // answer Q1
		for (let step = 0; step < questions + 2; step++) {
			if (dialog.render(cols).map(stripAnsi).join("\n").includes("Review before submitting")) break;
			dialog.handleInput(KEY.right);
		}
		const lines = dialog.render(cols);
		return {
			lines,
			text: lines.map(stripAnsi).join("\n"),
			budget: Math.max(1, rows - Math.max(5, Math.floor(rows * 0.25))),
		};
	}

	test("never exceeds its budget, at any number of questions", () => {
		for (const cols of [40, 60, 80]) {
			for (const rows of [10, 12, 14, 20, 30]) {
				for (const questions of [2, 4, 8]) {
					const { lines, budget } = submitPage(cols, rows, questions);
					expect(lines.length).toBeLessThanOrEqual(budget);
					expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(cols);
				}
			}
		}
	});

	test("keeps the blockers visible and says how many it hid", () => {
		const tight = submitPage(80, 12, 8);
		expect(tight.text).toContain("Review before submitting");
		// Q2..Q8 are unanswered and are the reason the page cannot submit.
		expect(tight.text).toContain("Q2 — unanswered");
		expect(tight.text).toMatch(/… \d+ more questions hidden/);

		const roomy = submitPage(80, 40, 8);
		expect(roomy.text).not.toContain("more questions hidden");
		expect(roomy.text).toContain("Q8 — unanswered");
		expect(roomy.text).toContain("Q1 LRU");
	});
});

describe("the collapsed row keeps what changes your next action", () => {
	function collapsedAt(cols: number, countdown?: number) {
		const tui = { terminal: { rows: 30, columns: cols }, requestRender: () => {} };
		const dialog = new QuestionnaireDialog({
			questionnaire: questionnaire(question({ header: "Cache" }), question({ header: "Scope" })),
			...(countdown === undefined ? {} : { timeoutSeconds: countdown }),
			tui: tui as never,
			theme: fakeTheme(),
			keybindings: {} as never,
			done: () => {},
		});
		dialog.handleInput("c");
		const line = stripAnsi(dialog.render(cols)[0] ?? "").replace(/\s+$/, "");
		dialog.dispose();
		return line;
	}

	test("a running countdown survives every width it can fit in", () => {
		// The countdown means "the autopilot is about to decide for you", so it
		// outranks the product name and the answered count when rows get tight.
		for (const cols of [20, 24, 30, 40, 56, 80, 140]) {
			expect(collapsedAt(cols, 30)).toMatch(/⏱\s*30s/);
		}
	});

	test("how to expand is the last thing to go", () => {
		for (const cols of [20, 24, 30, 40, 56, 80, 140]) {
			const line = collapsedAt(cols);
			expect(line).toMatch(/expand|c\b/);
			expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
		}
	});

	test("wide enough, it still reports the question and the progress", () => {
		const wide = collapsedAt(140);
		expect(wide).toContain("ask_user_question");
		expect(wide).toContain("Cache");
		expect(wide).toContain("0/2 answered");
	});
});

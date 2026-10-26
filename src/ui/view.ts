/**
 * Layout: turns dialog state into an array of styled terminal lines.
 *
 * This module is pure. It takes a plain `ViewState` and returns lines; it never
 * touches a TUI, a timer, or a key. That separation is what makes the hardest
 * part of this extension (does the thing on screen actually say the right
 * thing?) testable without a terminal.
 *
 * Two layout rules carry most of the weight:
 *
 * 1. **The dialog must never eat the transcript.** The question sits in the
 *    editor slot, so every row it takes is a row of agent output the user
 *    cannot read while deciding — and a question usually exists because
 *    something needs reading first. Hence a visible collapse button in the
 *    title bar, a `c` key, and a collapsed state that is exactly one line.
 * 2. **A dialog taller than the terminal must still be usable.** Rendering
 *    everything and letting the host clip it silently drops the key hints and
 *    the countdown off the bottom — the two rows that tell the user how to
 *    leave. `renderDialog` therefore takes a row budget and sheds the least
 *    useful rows first, never the tail.
 *
 * Every line is measured and padded to the requested width with `pi-tui`'s
 * helpers, which understand ANSI escapes and wide characters.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Palette } from "./palette.ts";

/** A selectable row inside the current tab. */
export type RowKind = "option" | "note" | "custom";

export interface ViewOption {
	kind: RowKind;
	label: string;
	description?: string;
	/** Markdown artifact rendered beside the option list when this row is focused. */
	preview?: string;
	/** From the model: mark it with a star. */
	recommended?: boolean;
	/** From the user: currently selected (multi-select). */
	checked?: boolean;
}

export interface ViewTab {
	header: string;
	category?: string;
	question: string;
	/** Set when this tab's answer is complete. */
	answered: boolean;
	/** Free-text answer stored for this question, if any. */
	text?: string;
	/** Note attached to this question's answer. */
	note?: string;
}

export type FocusMode = "browse" | "type" | "note";

export interface ViewState {
	tabs: ViewTab[];
	/** Index of the tab being answered; `tabs.length` is the Submit tab. */
	tab: number;
	options: ViewOption[];
	/** Highlighted row index. */
	index: number;
	focus: FocusMode;
	/** Whether the current question takes several answers; only affects the hint line. */
	multiSelect?: boolean;
	/** Lines of the free-text editor, already rendered by the caller's Editor. */
	editorLines?: string[];
	/** Seconds left before the autopilot answers; `undefined` = no countdown. */
	countdown?: number;
	/** Global note, shown on the Submit tab. */
	globalNote?: string;
	/** Why the countdown is running (shown in the countdown line). */
	autopilotHint?: string;
	/**
	 * `"auto"` is a delay the user asked for; `"deadline"` is the safety net on
	 * an `off` policy. They read differently on purpose: one is "I will answer
	 * soon", the other is "nobody answered, so I am taking over".
	 */
	deadlineKind?: "auto" | "deadline";
}

/**
 * Width below which the dialog gets genuinely unpleasant -- but not a floor.
 *
 * A component must never render a line wider than the width it was handed: the
 * terminal hard-wraps it, every row after it shifts, and the whole frame tears
 * apart. So this is advisory (the layout degrades through it) rather than a
 * clamp. A 20-column terminal gets a 20-column dialog.
 */
export const MIN_WIDTH = 24;

/** Smallest dialog worth rendering: title, one option, hints, rule. */
export const MIN_HEIGHT = 5;

/** The button drawn in the title bar. Kept exported so the mouse hit-box shares it. */
export const COLLAPSE_FULL = "[ − collapse ]";
export const COLLAPSE_SHORT = "[ − ]";
export const EXPAND_FULL = "[ + expand ]";
export const EXPAND_SHORT = "[ + ]";

const TITLE_LABEL = " ask_user_question ";

function pad(text: string, width: number): string {
	const overflow = width - visibleWidth(text);
	return overflow > 0 ? text + " ".repeat(overflow) : text;
}

/** Wrap a string to `width` and prefix every resulting line except the first. */
function withPrefix(palette: Palette, prefix: string, continuation: string, text: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const bodyWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(text, bodyWidth);
	return wrapped.map((line, index) => {
		const lead = index === 0 ? prefix : continuation;
		return palette.fg("dim", lead) + line;
	});
}

function rule(palette: Palette, width: number): string {
	return palette.fg("border", "─".repeat(width));
}

interface TitleLayout {
	label: string;
	button: string;
	fill: number;
	span?: { start: number; end: number };
}

/**
 * Choose the widest title bar that fits: full label + full button, then a
 * short button, then no label, then a plain rule. The button is the one thing
 * worth keeping — a dialog you cannot collapse is the bug this fixes.
 */
function titleLayout(width: number): TitleLayout {
	const candidates: Array<{ label: string; button: string }> = [
		{ label: TITLE_LABEL, button: COLLAPSE_FULL },
		{ label: TITLE_LABEL, button: COLLAPSE_SHORT },
		{ label: "", button: COLLAPSE_SHORT },
		{ label: "", button: "" },
	];
	for (const candidate of candidates) {
		const labelWidth = visibleWidth(candidate.label);
		const buttonWidth = visibleWidth(candidate.button);
		const fill = width - 1 - labelWidth - buttonWidth;
		if (fill < 1) continue;
		const start = 1 + labelWidth + fill;
		return {
			...candidate,
			fill,
			...(buttonWidth > 0 ? { span: { start, end: start + buttonWidth } } : {}),
		};
	}
	return { label: "", button: "", fill: Math.max(0, width - 1) };
}

function titleBar(palette: Palette, layout: TitleLayout): string {
	return (
		palette.fg("border", "─") +
		(layout.label.length > 0 ? palette.fg("muted", layout.label) : "") +
		palette.fg("border", "─".repeat(Math.max(0, layout.fill))) +
		(layout.button.length > 0 ? palette.fg("accent", layout.button) : "")
	);
}

/**
 * Columns covered by the collapse button on the dialog's first line, or
 * `undefined` when the terminal is too narrow for one. The mouse handler and
 * the renderer both read this, so a click can never land beside the label it
 * looks like it is clicking.
 */
export function collapseButtonSpan(width: number): { start: number; end: number } | undefined {
	return titleLayout(width).span;
}

/** Columns covered by the expand button on the collapsed one-line summary. */
export function expandButtonSpan(width: number): { start: number; end: number } {
	return { start: 0, end: visibleWidth(expandButton(width)) };
}

function expandButton(width: number | undefined): string {
	return width !== undefined && width < 34 ? EXPAND_SHORT : EXPAND_FULL;
}

/** The tab strip: one chip per question plus Submit, with answered marks. */
function tabStrip(state: ViewState, palette: Palette, width: number): string[] {
	const chips: string[] = [];
	state.tabs.forEach((tab, index) => {
		const active = index === state.tab;
		const mark = tab.answered ? "■" : "□";
		const label = ` ${mark} ${tab.header} `;
		if (active) {
			chips.push(palette.bg("selectedBg", palette.fg("text", palette.bold(label))));
		} else {
			chips.push(palette.fg(tab.answered ? "success" : "muted", label));
		}
	});
	const onSubmit = state.tab === state.tabs.length;
	const allAnswered = state.tabs.every((tab) => tab.answered);
	const submitLabel = " ✔ Submit ";
	chips.push(
		onSubmit
			? palette.bg("selectedBg", palette.fg("text", palette.bold(submitLabel)))
			: palette.fg(allAnswered ? "success" : "dim", submitLabel),
	);

	// Lay chips out on as many lines as needed; never truncate a chip in half.
	const lines: string[] = [];
	let current = "";
	for (const chip of chips) {
		const candidate = current.length === 0 ? chip : `${current} ${chip}`;
		if (current.length > 0 && visibleWidth(candidate) > width) {
			lines.push(current);
			current = chip;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

/**
 * One option row.
 *
 * Two shapes, because the two modes answer different questions:
 *
 * - single-select asks *which one*, so the rows are numbered; the number is
 *   also the key the user can type.
 * - multi-select asks *which of these*, so a number is noise — nobody picks
 *   "number 3", they pick a label. The row gets a checkbox instead, and the
 *   boxes are uniform width so labels stay aligned whether checked or not.
 *
 * `★` stays in both: it is the model's recommendation, which is a different
 * axis from "I checked this". One option is recommended; any number are checked.
 */
const CHECKED = "✓";
const UNCHECKED = "▢";

function optionRow(
	option: ViewOption,
	index: number,
	state: ViewState,
	palette: Palette,
	width: number,
	showDescription: boolean,
): string[] {
	const selected = index === state.index;
	const pointer = selected ? palette.fg("accent", "❯ ") : "  ";
	const star = option.recommended ? palette.fg("success", " ★") : "";
	const isOption = option.kind === "option";

	let marker: string;
	if (state.multiSelect === true && isOption) {
		marker = option.checked === true ? `${palette.fg("success", CHECKED)} ` : `${palette.fg("dim", UNCHECKED)} `;
	} else if (state.multiSelect === true) {
		// The appended rows are actions, not choices: keep the column aligned
		// without pretending they can be ticked.
		marker = "  ";
	} else {
		marker = `${index + 1}. `;
	}

	const labelColor = selected ? "accent" : isOption ? "text" : "muted";
	const label = marker + palette.fg(labelColor, option.label) + star;
	const lines = withPrefix(palette, pointer, "   ", label, width);
	if (showDescription && option.description !== undefined && option.description.length > 0) {
		lines.push(...withPrefix(palette, "     ", "     ", palette.fg("muted", option.description), width));
	}
	return lines;
}

function previewPane(option: ViewOption, palette: Palette, width: number): string[] {
	if (option.preview === undefined || option.preview.length === 0) return [];
	const inner = Math.max(1, width - 4);
	const lines = [palette.fg("borderMuted", `┌─ preview: ${option.label} ${"─".repeat(Math.max(0, inner - 12 - option.label.length))}`)];
	for (const raw of option.preview.split("\n")) {
		const wrapped = wrapTextWithAnsi(raw.length === 0 ? " " : raw, inner);
		for (const line of wrapped) {
			lines.push(`${palette.fg("borderMuted", "│ ")}${line}`);
		}
	}
	lines.push(palette.fg("borderMuted", `└${"─".repeat(Math.max(0, inner + 2))}`));
	return lines;
}

function countdownLine(state: ViewState, palette: Palette): string[] {
	if (state.countdown === undefined) return [];
	const seconds = Math.max(0, Math.floor(state.countdown));
	const deadline = state.deadlineKind === "deadline";
	const hint = state.autopilotHint ?? (deadline ? "nobody has answered" : "autopilot will answer");
	const lead = deadline ? "nobody answered — autopilot takes over in" : "autopilot answers in";
	return [palette.fg("warning", `⏱  ${lead} ${seconds}s — press any key to keep answering (${hint})`)];
}

function submitLines(state: ViewState, palette: Palette, width: number, air = true): string[] {
	const lines: string[] = [];
	const missing = state.tabs.filter((tab) => !tab.answered);
	const done = state.tabs.filter((tab) => tab.answered);

	lines.push(...withPrefix(palette, "  ", "  ", palette.fg("accent", "Review before submitting"), width));
	if (air) lines.push("");

	// Unanswered questions first. They are the whole reason this page exists, and
	// the dialog can be short enough to clip its own tail — a blocking row that
	// scrolled off the screen is a user stuck on a page that will not submit.
	for (const tab of missing) {
		const chip = palette.fg("accent", tab.header);
		const grouped = tab.category !== undefined ? palette.fg("dim", `(${tab.category}) `) : "";
		lines.push(
			...withPrefix(
				palette,
				"  ",
				"    ",
				`${chip} ${grouped}${palette.fg("warning", "— unanswered")}`,
				width,
			),
		);
	}

	for (const tab of done) {
		const chip = palette.fg("accent", tab.header);
		const grouped = tab.category !== undefined ? palette.fg("dim", `(${tab.category}) `) : "";
		const text = tab.text !== undefined && tab.text.length > 0 ? tab.text : "(selected)";
		lines.push(...withPrefix(palette, "  ", "    ", `${chip} ${grouped}${palette.fg("text", text)}`, width));
		if (tab.note !== undefined && tab.note.length > 0) {
			lines.push(...withPrefix(palette, "    ", "    ", palette.fg("muted", `note: ${tab.note}`), width));
		}
	}

	if (state.globalNote !== undefined && state.globalNote.length > 0) {
		lines.push(...withPrefix(palette, "  ", "    ", palette.fg("muted", `global note: ${state.globalNote}`), width));
	}

	if (air) lines.push("");
	lines.push(
		...withPrefix(
			palette,
			"  ",
			"  ",
			missing.length === 0
				? palette.fg("success", "Enter submits")
				: palette.fg("warning", "Enter jumps to the first unanswered question"),
			width,
		),
	);
	return lines;
}

/**
 * A Submit page shorter than its content, keeping the rows that block the
 * user. Unanswered questions are the reason the page cannot be submitted, so
 * they are drawn first and are the last thing to be elided; a count of what was
 * hidden follows, the same way the option list does it.
 */
function submitWindowed(
	state: ViewState,
	palette: Palette,
	width: number,
	air: boolean,
	budget: number,
): string[] {
	const fixed = submitLines({ ...state, tabs: [] }, palette, width, air);
	const room = budget - fixed.length;
	if (room >= state.tabs.length) return submitLines(state, palette, width, air);

	const missing = state.tabs.filter((tab) => !tab.answered);
	const done = state.tabs.filter((tab) => tab.answered);
	const rows = (tab: ViewState["tabs"][number]) =>
		tab.note !== undefined && tab.note.length > 0 ? 2 : 1;

	// Every unanswered row first: those are the blockers. One row is spent on the
	// hidden-count marker, so the budget for rows is one less than `room`.
	const reserve = done.length > 0 ? 1 : 0;
	const available = Math.max(0, room - reserve);
	const shownMissing = missing.slice(0, available);
	let used = shownMissing.reduce((sum, tab) => sum + rows(tab), 0);

	const shownDone: typeof done = [];
	for (const tab of done) {
		if (shownMissing.length + shownDone.length >= state.tabs.length) break;
		const next = rows(tab);
		if (used + next > available) break;
		shownDone.push(tab);
		used += next;
	}

	const hidden = state.tabs.length - shownMissing.length - shownDone.length;
	const window: ViewState = {
		...state,
		tabs: [...shownMissing, ...shownDone],
	};
	const lines = submitLines(window, palette, width, air);
	if (hidden > 0) {
		// Slot the marker just before the trailing hint so it reads as part of the
		// list rather than as a footer note.
		const hint = lines.pop();
		lines.push(palette.fg("dim", `  … ${hidden} more question${hidden === 1 ? "" : "s"} hidden`));
		if (hint !== undefined) lines.push(hint);
	}
	return lines;
}

/**
 * The key legend, in tiers from fullest to terse. The first tier that fits on
 * one row wins: the hint is the way out of the dialog, so it may not wrap and
 * push the bottom rule (and the rest of the layout) off a short terminal.
 */
function hintTiers(state: ViewState): string[] {
	if (state.focus === "type") {
		return [
			"Enter saves the answer · Shift+Enter newline · Esc back to the list",
			"Enter save · Shift+Enter line · Esc back",
			"Enter save · Esc back",
		];
	}
	if (state.focus === "note") {
		return ["Enter saves the note · Shift+Enter newline · Esc discards", "Enter save · Esc discard"];
	}
	if (state.tab >= state.tabs.length) {
		return [
			`Enter submit${state.tabs.length > 1 ? " · Tab/←→ tabs" : ""} · n global note · Esc cancel · c collapse`,
			`Enter submit · n note · Esc cancel · c collapse`,
			"Enter submit · Esc cancel",
		];
	}
	const parts = ["↑↓ move", "Enter pick"];
	if (state.multiSelect === true) parts.push("Space toggle");
	if (state.tabs.length > 1) parts.push("Tab/←→ tabs");
	parts.push("n note", "Esc cancel", "c collapse");
	const full = parts.join(" · ");
	const medium = `↑↓ move · Enter pick${state.multiSelect === true ? " · Space" : ""}${
		state.tabs.length > 1 ? " · Tab" : ""
	} · Esc · c`;
	return [full, medium, "↑↓ · Enter · Esc · c"];
}

/**
 * The hint is one row, always. It is not merely shortened to fit -- the tail's
 * height has to be predictable, or the row budget the caller gave us stops
 * meaning anything. So the tiers are tried first, and if even the terse one
 * overflows a genuinely narrow terminal it is cut with an ellipsis rather than
 * wrapped into a second row.
 */
function hintLine(state: ViewState, palette: Palette, width: number): string[] {
	const bodyWidth = Math.max(1, width - 2);
	const tiers = hintTiers(state);
	const tier = tiers.find((text) => visibleWidth(text) <= bodyWidth) ?? tiers[tiers.length - 1] ?? "";
	return [`  ${truncateToWidth(palette.fg("dim", tier), bodyWidth, "…", false)}`];
}

/**
 * How much of the verbose chrome to keep.
 *
 * Shedding order is deliberate. The rows a user needs to *decide* go last: a
 * preview is a nicety, the option list is not, and the hint line is the way
 * out of the dialog — which is why it is in the tail and never shrunk away.
 */
interface Density {
	preview: boolean;
	descriptions: boolean;
	/** Blank separator lines. */
	air: boolean;
	/** The `Cache · …` chip above the question (redundant with the tab strip). */
	header: boolean;
	tabs: boolean;
	/**
	 * Whether the option list is drawn at all. False only when the dialog is so
	 * short that a single option row would push the text editor off the screen —
	 * at that point one `… N options hidden` row says more than a one-row window
	 * out of eight.
	 */
	options: boolean;
}

const FULL_DENSITY: Density = {
	preview: true,
	descriptions: true,
	air: true,
	header: true,
	tabs: true,
	options: true,
};

/** Progressive shedding, cheapest loss first. */
const SPARSER: Density[] = [
	{ ...FULL_DENSITY, preview: false },
	{ ...FULL_DENSITY, preview: false, descriptions: false },
	{ ...FULL_DENSITY, preview: false, descriptions: false, air: false },
	{ ...FULL_DENSITY, preview: false, descriptions: false, air: false, header: false },
	{ ...FULL_DENSITY, preview: false, descriptions: false, air: false, header: false, tabs: false },
];

/**
 * The option list gives way before the question does: when a window of even one
 * row plus its marker will not fit, one line stating how many are hidden is
 * more use than a truncated list that looks complete.
 */
const VIEW_FIRST: Density = {
	...FULL_DENSITY,
	preview: false,
	descriptions: false,
	air: false,
	header: false,
	tabs: false,
	options: false,
};

/** The text editor is the last thing to give way, because it is being used. */
const EDITOR_FIRST: Density = {
	...FULL_DENSITY,
	preview: false,
	descriptions: false,
	air: false,
	header: false,
	tabs: false,
	options: false,
};

interface RowWindow {
	start: number;
	end: number;
	/**
	 * Whether the `… N more` markers are drawn at all.
	 *
	 * They are the first thing dropped when space runs out: a marker exists to
	 * tell the user the list is incomplete, and if there is not even room for the
	 * marker plus one row, showing the row unannounced still beats showing
	 * nothing. Defaults to true.
	 */
	markers?: boolean;
}

/** Height of every option block, preview included, under a given density. */
function blockHeights(state: ViewState, palette: Palette, width: number, density: Density): number[] {
	return state.options.map((option, index) => {
		let height = optionRow(option, index, state, palette, width, density.descriptions).length;
		if (density.preview && index === state.index) height += previewPane(option, palette, width).length;
		return height;
	});
}

/**
 * Pick the largest contiguous window of option blocks that fits `budget`,
 * preferring one that contains the highlighted row and sits as close to it as
 * possible. Elision markers cost one row each, so they are part of the budget.
 */
function chooseWindow(heights: number[], focus: number, budget: number): RowWindow {
	const total = heights.length;
	const sum = (start: number, end: number) => heights.slice(start, end).reduce((a, b) => a + b, 0);
	// One `… N more` row per hidden run.
	const cost = (start: number, end: number) => sum(start, end) + (start > 0 ? 1 : 0) + (end < total ? 1 : 0);

	// Widest window first, then the one centred closest to the highlight, so the
	// rows nearest what the user is looking at win the last remaining space.
	for (let size = total; size >= 1; size--) {
		const lowest = Math.max(0, Math.min(total - size, focus - size + 1));
		const highest = Math.min(total - size, focus);
		for (let start = lowest; start <= highest; start++) {
			const end = start + size;
			if (focus >= start && focus < end && cost(start, end) <= budget) return { start, end };
		}
	}

	// Even the focused block plus its markers does not fit. Drop the markers and
	// render one row unannounced -- the caller knows the budget, and a lone option
	// the user can still act on beats a list they cannot see. `markers: false`
	// is load-bearing: optionSection must honour it, or its output is one row
	// taller than the fit calculation assumed and every retry fails.
	return { start: focus, end: Math.min(total, focus + 1), markers: false };
}

function optionSection(
	state: ViewState,
	palette: Palette,
	width: number,
	density: Density,
	window: RowWindow | undefined,
): string[] {
	const lines: string[] = [];
	const hidden = (from: number, to: number) => to - from;
	const elide = (count: number, direction: "above" | "below") =>
		palette.fg(
			"dim",
			`  … ${count} more option${count === 1 ? "" : "s"} ${direction}${
				direction === "above" ? " (↑ to reach)" : " (↓ to reach)"
			}`,
		);

	if (!density.options) {
		const count = state.options.length;
		return [
			palette.fg(
				"dim",
				`  … ${count} option${count === 1 ? "" : "s"} hidden — resize the terminal or c to collapse this dialog`,
			),
		];
	}

	if (window === undefined) {
		state.options.forEach((option, index) => {
			lines.push(...optionRow(option, index, state, palette, width, density.descriptions));
			if (density.preview && index === state.index) lines.push(...previewPane(option, palette, width));
		});
		return lines;
	}

	const showMarkers = window.markers !== false;
	if (showMarkers && window.start > 0) lines.push(elide(hidden(0, window.start), "above"));
	for (let index = window.start; index < window.end; index++) {
		const option = state.options[index];
		if (option === undefined) continue;
		lines.push(...optionRow(option, index, state, palette, width, density.descriptions));
		if (density.preview && index === state.index) lines.push(...previewPane(option, palette, width));
	}
	if (showMarkers && window.end < state.options.length) {
		lines.push(elide(hidden(window.end, state.options.length), "below"));
	}
	return lines;
}

function bodyLines(
	state: ViewState,
	palette: Palette,
	width: number,
	density: Density,
	window: RowWindow | undefined,
	submitBudget: number | undefined,
): { lines: string[]; editor: number } {
	const lines: string[] = [];

	if (density.tabs && state.tabs.length > 1) {
		lines.push(...tabStrip(state, palette, width));
		if (density.air) lines.push("");
	}

	const isSubmit = state.tab >= state.tabs.length;
	const tab = state.tabs[state.tab];

	if (isSubmit) {
		lines.push(
			...(submitBudget === undefined
				? submitLines(state, palette, width, density.air)
				: submitWindowed(state, palette, width, density.air, submitBudget)),
		);
		return { lines, editor: 0 };
	}
	if (tab === undefined) return { lines, editor: 0 };

	if (density.header) {
		const chip = palette.fg("accent", tab.header);
		const category = tab.category !== undefined ? palette.fg("dim", ` · ${tab.category}`) : "";
		lines.push(...withPrefix(palette, " ", " ", `${chip}${category}`, width));
	}
	lines.push(...withPrefix(palette, " ", " ", palette.fg("text", palette.bold(tab.question)), width));
	if (density.air) lines.push("");

	lines.push(...optionSection(state, palette, width, density, window));

	if (tab.note !== undefined && tab.note.length > 0 && state.focus !== "note") {
		lines.push("");
		lines.push(...withPrefix(palette, " ", " ", palette.fg("muted", `note: ${tab.note}`), width));
	}

	if (state.focus === "type" || state.focus === "note") {
		lines.push("");
		lines.push(
			...withPrefix(
				palette,
				" ",
				" ",
				palette.fg("muted", state.focus === "type" ? "Your answer:" : "Note:"),
				width,
			),
		);
		const editorWidth = Math.max(1, width - 2);
		const start = lines.length;
		for (const line of state.editorLines ?? [""]) {
			lines.push(` ${truncateToWidth(line, editorWidth, "…", false)}`);
		}
		// The editor block is never elided: typing into an invisible box is worse
		// than losing an option row.
		return { lines, editor: lines.length - start };
	}

	return { lines, editor: 0 };
}

function assemble(
	state: ViewState,
	palette: Palette,
	width: number,
	density: Density,
	window: RowWindow | undefined,
	budget?: number,
): { head: string[]; tail: string[]; editor: number } {
	const layout = titleLayout(width);
	// The Submit page is windowed against whatever the head and tail leave over.
	const tailHeight = (density.air ? 1 : 0) + countdownLine(state, palette).length + hintLine({ ...state, focus: "browse" }, palette, width).length + 1;
	const submitBudget = budget === undefined ? undefined : budget - 1 - tailHeight;
	const body = bodyLines(state, palette, width, density, window, submitBudget);
	const head = [titleBar(palette, layout), ...body.lines];
	const tail = [
		...(density.air ? [""] : []),
		...countdownLine(state, palette),
		...hintLine(state, palette, width),
		rule(palette, width),
	];
	return { head, tail, editor: body.editor };
}

/**
 * Render the dialog. `maxHeight` is the number of rows the host can give the
 * dialog; when omitted the dialog renders at its natural height (what the
 * tests and non-terminal callers want).
 *
 * Rows are spent in a fixed priority order, because a dialog competing with the
 * transcript has to be honest about what it sacrifices:
 *
 *   1. key hints and the countdown (the way out of the dialog), never shed;
 *   2. the text editor while it is open (typing into a clipped box is a trap);
 *   3. the question itself;
 *   4. the option list;
 *   5. previews, descriptions, blank lines, the redundant header chip, tabs.
 *
 * The option list is windowed rather than truncated so the highlighted row is
 * always on screen, and every hidden run gets an explicit `… N more` marker so
 * a shortened list can never be mistaken for a complete one.
 */
export function renderDialog(state: ViewState, palette: Palette, width: number, maxHeight?: number): string[] {
	// Never widen past what the caller offered, and never claim a budget larger
	// than the one we were given: the host allocated those rows, not us.
	const w = Math.max(1, Math.floor(width));
	const budget = maxHeight === undefined ? undefined : Math.max(1, Math.floor(maxHeight));

	// Below the minimum a dialog cannot identify itself: title, question, one
	// option and the hints already exceed the space. The one-line summary spends
	// its single row on the two things that still matter -- what this is, and how
	// to get it back -- which beats a truncated "terminal too short" marker that
	// says neither.
	if (budget !== undefined && budget < MIN_HEIGHT) return [renderCollapsed(state, palette, w)];

	let view = state;
	const capped = capEditorLines(view, 1);
	let density = FULL_DENSITY;
	let window: RowWindow | undefined;
	let parts = assemble(view, palette, w, density, undefined, budget);
	const fits = (candidate: { head: string[]; tail: string[] }) =>
		budget === undefined || candidate.head.length + candidate.tail.length <= budget;

	if (budget !== undefined) {
		// 1. Shed chrome, cheapest loss first.
		for (const lean of SPARSER) {
			if (fits(parts)) break;
			density = lean;
			window = undefined;
			parts = assemble(view, palette, w, density, undefined, budget);
		}

		// 2. Shrink the option list itself, centred on the highlighted row.
		//    Everything that is not an option block is fixed overhead, so the
		//    window gets whatever the rest of the dialog leaves behind.
		if (!fits(parts) && view.options.length > 0) {
			const focus = Math.max(0, Math.min(view.options.length - 1, view.index));
			const attempt = (source: ViewState) => {
				const heights = blockHeights(source, palette, w, density);
				const base = assemble(source, palette, w, density, undefined, budget);
				const overhead = base.head.length - heights.reduce((sum, height) => sum + height, 0);
				const available = budget - overhead - base.tail.length;
				if (available < 1) return undefined;
				const slice = chooseWindow(heights, focus, available);
				const rendered = assemble(source, palette, w, density, slice, budget);
				return fits(rendered) ? { view: source, window: slice, parts: rendered } : undefined;
			};
			// A multi-line editor is a luxury when rows are short: prefer the
			// full-height one, otherwise trade its spare rows for options while
			// keeping the line the cursor is on.
			const chosen = attempt(view) ?? (capped === view ? undefined : attempt(capped));
			if (chosen !== undefined) {
				view = chosen.view;
				window = chosen.window;
				parts = chosen.parts;
			}
		}

		// 3. A one-row window out of a long list says nothing useful anyway, so
		//    when even a window will not fit, state the count in a single line and
		//    spend the rows on everything that identifies the dialog.
		if (!fits(parts) && view.options.length > 0) {
			density = VIEW_FIRST;
			window = undefined;
			parts = assemble(view, palette, w, density, window, budget);
		}

		// 4. The text editor is the last thing to give way: typing into a box the
		//    terminal clipped is worse than losing a hint. This can still leave the
		//    dialog too tall, in which case the caller's budget wins and the frame
		//    is cut -- but that only happens on terminals too short to be a dialog.
		if (!fits(parts) && view.focus !== "browse") {
			density = EDITOR_FIRST;
			view = capped;
			window = undefined;
			parts = assemble(view, palette, w, density, window, budget);
		}
	}

	// Still too tall after every density and the option list have given way. That
	// means the question itself cannot be shown with its title and its hints: the
	// terminal is simply too small for a dialog. A clipped frame would be a
	// fragment with no title and no way out; the one-line summary is at least
	// self-describing and tells the user how to get the real thing back.
	if (budget !== undefined && !fits(parts)) return [renderCollapsed(state, palette, w)];

	const lines = budget === undefined ? [...parts.head, ...parts.tail] : [...parts.head, ...parts.tail].slice(0, budget);

	// A terminal line must never exceed the width it was given.
	return lines.map((line) => pad(truncateToWidth(line, w, "…", false), w));
}

/**
 * Keep the row the cursor is on. `Editor.render` brackets its content with
 * border rows, so "the last line" would be the bottom border — the one row that
 * never contains what the user typed.
 */
function capEditorLines(state: ViewState, cap: number): ViewState {
	const lines = state.editorLines;
	if (lines === undefined || lines.length <= cap) return state;
	const content = lines.filter((line) => !/^[\s─]*(?:─[\s─]*)+$/u.test(line.replace(/\u001b\[[0-9;]*m/g, "")));
	const pool = content.length > 0 ? content : lines;
	return { ...state, editorLines: pool.slice(-cap) };
}

/**
 * One-line summary used when the dialog is collapsed.
 *
 * This is the whole point of the collapse button: one row instead of thirty,
 * with the question still visible, still counting down, and one click (or
 * `ctrl+]` / `c`) away from coming back.
 */
export function renderCollapsed(state: ViewState, palette: Palette, width?: number): string {
	const answered = state.tabs.filter((tab) => tab.answered).length;
	const name = state.tab >= state.tabs.length ? "submit" : (state.tabs[state.tab]?.header ?? "");
	const extra = state.countdown !== undefined ? ` · ⏱ ${Math.max(0, Math.floor(state.countdown))}s` : "";
	const button = expandButton(width);

	// Priority order while the row shrinks: the button, then how to expand, then
	// which question this is, then the counts. A collapsed dialog whose button
	// got truncated to "[ + ] ask_user_ques…" tells the user neither what it is
	// nor how to bring it back -- the one row it was given has to carry that.
	const primary = ` ask_user_question · ${name}`;
	const counts = ` · ${answered}/${state.tabs.length} answered${extra}`;
	// A running countdown is the one fact that changes what the user should do
	// *right now* (answer, or the autopilot decides for them), so it outranks
	// both the product name and the answered count when the row is tight.
	const full = `${primary}${counts} · ctrl+] or c to expand`;
	const seconds = Math.max(0, Math.floor(state.countdown ?? 0));
	const timed = ` ⏱ ${seconds}s · c to expand`;
	const timedTight = ` ⏱${seconds}s · c`;
	const terse = `${primary} · c to expand`;
	// Below ~26 columns the product name does not fit alongside the instruction,
	// and the instruction is the part that cannot be inferred from the screen.
	const minimal = " c to expand";
	const bare = "";

	const room = width === undefined ? undefined : Math.max(1, width) - visibleWidth(button);
	const tiers =
		state.countdown !== undefined
			? [full, timed, timedTight, minimal, bare]
			: [full, terse, minimal, bare];
	const body = room === undefined ? tiers[0] ?? full : tiers.find((text) => visibleWidth(text) <= room) ?? bare;

	const line = palette.fg("accent", button) + palette.fg("dim", body);
	return width === undefined ? line : pad(truncateToWidth(line, Math.max(1, width), "…", false), Math.max(1, width));
}

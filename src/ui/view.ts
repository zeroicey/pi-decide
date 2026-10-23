/**
 * Layout: turns dialog state into an array of styled terminal lines.
 *
 * This module is pure. It takes a plain `ViewState` and returns lines; it never
 * touches a TUI, a timer, or a key. That separation is what makes the hardest
 * part of this extension (does the thing on screen actually say the right
 * thing?) testable without a terminal.
 *
 * Every line is measured and padded to the requested width with
 * `pi-tui`'s helpers, which understand ANI escapes and wide characters.
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
	/** Lines of the free-text editor, already rendered by the caller's Editor. */
	editorLines?: string[];
	/** Seconds left before the autopilot answers; `undefined` = no countdown. */
	countdown?: number;
	/** Global note, shown on the Submit tab. */
	globalNote?: string;
	/** Why the countdown is running (shown in the countdown line). */
	autopilotHint?: string;
}

export const MIN_WIDTH = 24;

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

function optionRow(
	option: ViewOption,
	index: number,
	state: ViewState,
	palette: Palette,
	width: number,
): string[] {
	const selected = index === state.index;
	const pointer = selected ? palette.fg("accent", "❯ ") : "  ";
	const number = `${index + 1}. `;
	const check = option.kind === "option" ? (option.checked ? "◉ " : "") : "";
	const star = option.recommended ? palette.fg("success", " ★") : "";
	const labelColor = selected ? "accent" : option.kind === "option" ? "text" : "muted";
	const label = palette.fg(labelColor, `${number}${check}${option.label}`) + star;
	const lines = withPrefix(palette, pointer, "   ", label, width);
	if (option.description !== undefined && option.description.length > 0) {
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
	const hint = state.autopilotHint ?? "autopilot will answer";
	return [
		palette.fg(
			"warning",
			`⏱  autopilot answers in ${seconds}s — press any key to take over (${hint})`,
		),
	];
}

function submitLines(state: ViewState, palette: Palette, width: number): string[] {
	const lines: string[] = [];
	const allAnswered = state.tabs.every((tab) => tab.answered);
	lines.push(...withPrefix(palette, "  ", "  ", palette.fg("accent", "Review before submitting"), width));
	lines.push("");

	for (const tab of state.tabs) {
		const chip = palette.fg("accent", tab.header);
		const grouped = tab.category !== undefined ? palette.fg("dim", `(${tab.category}) `) : "";
		if (!tab.answered) {
			lines.push(...withPrefix(palette, "  ", "    ", `${chip} ${grouped}${palette.fg("warning", "— unanswered")}`, width));
			continue;
		}
		const text = tab.text !== undefined && tab.text.length > 0 ? tab.text : "(selected)";
		lines.push(...withPrefix(palette, "  ", "    ", `${chip} ${grouped}${palette.fg("text", text)}`, width));
		if (tab.note !== undefined && tab.note.length > 0) {
			lines.push(...withPrefix(palette, "    ", "    ", palette.fg("muted", `note: ${tab.note}`), width));
		}
	}

	if (state.globalNote !== undefined && state.globalNote.length > 0) {
		lines.push(...withPrefix(palette, "  ", "    ", palette.fg("muted", `global note: ${state.globalNote}`), width));
	}

	lines.push("");
	lines.push(
		...withPrefix(
			palette,
			"  ",
			"  ",
			allAnswered ? palette.fg("success", "Enter submits") : palette.fg("warning", "Fill every question, or press n to add a note"),
			width,
		),
	);
	return lines;
}

function hintLine(state: ViewState, palette: Palette, width: number): string[] {
	let hint: string;
	if (state.focus === "type") {
		hint = "Enter saves the answer · Shift+Enter newline · Esc back to the list";
	} else if (state.focus === "note") {
		hint = "Enter saves the note · Shift+Enter newline · Esc discards";
	} else if (state.tab === state.tabs.length) {
		hint = "Enter submit · Tab/←→ questions · n global note · Esc cancel";
	} else {
		hint = "↑↓ move · Enter pick · Space toggle · Tab/←→ questions · n note · Esc cancel";
	}
	return withPrefix(palette, "  ", "  ", palette.fg("dim", hint), width);
}

export function renderDialog(state: ViewState, palette: Palette, width: number): string[] {
	const w = Math.max(MIN_WIDTH, width);
	const lines: string[] = [];

	lines.push(rule(palette, w));
	if (state.tabs.length > 1) {
		lines.push(...tabStrip(state, palette, w));
		lines.push("");
	}

	const isSubmit = state.tab >= state.tabs.length;
	const tab = state.tabs[state.tab];

	if (isSubmit) {
		lines.push(...submitLines(state, palette, w));
	} else if (tab !== undefined) {
		const chip = palette.fg("accent", tab.header);
		const category = tab.category !== undefined ? palette.fg("dim", ` · ${tab.category}`) : "";
		lines.push(...withPrefix(palette, " ", " ", `${chip}${category}`, w));
		lines.push(...withPrefix(palette, " ", " ", palette.fg("text", palette.bold(tab.question)), w));
		lines.push("");

		state.options.forEach((option, index) => {
			lines.push(...optionRow(option, index, state, palette, w));
		});

		const focused = state.options[state.index];
		if (focused !== undefined) lines.push(...previewPane(focused, palette, w));

		if (tab.note !== undefined && tab.note.length > 0 && state.focus !== "note") {
			lines.push("");
			lines.push(...withPrefix(palette, " ", " ", palette.fg("muted", `note: ${tab.note}`), w));
		}

		if (state.focus === "type" || state.focus === "note") {
			lines.push("");
			lines.push(
				...withPrefix(
					palette,
					" ",
					" ",
					palette.fg("muted", state.focus === "type" ? "Your answer:" : "Note:"),
					w,
				),
			);
			const editorWidth = Math.max(1, w - 2);
			for (const line of state.editorLines ?? [""]) {
				lines.push(` ${truncateToWidth(line, editorWidth, "…", false)}`);
			}
		}
	}

	lines.push("");
	lines.push(...countdownLine(state, palette));
	lines.push(...hintLine(state, palette, w));
	lines.push(rule(palette, w));

	// A terminal line must never exceed the width it was given.
	return lines.map((line) => pad(truncateToWidth(line, w, "…", false), w));
}

/** One-line summary used when the dialog is collapsed. */
export function renderCollapsed(state: ViewState, palette: Palette): string {
	const answered = state.tabs.filter((tab) => tab.answered).length;
	const name = state.tab >= state.tabs.length ? "submit" : (state.tabs[state.tab]?.header ?? "");
	const extra = state.countdown !== undefined ? ` · ⏱ ${Math.max(0, Math.floor(state.countdown))}s` : "";
	return palette.fg(
		"dim",
		`ask_user_question · ${answered}/${state.tabs.length} answered · ${name}${extra} · ctrl+] to expand`,
	);
}

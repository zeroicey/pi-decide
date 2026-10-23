/**
 * The interactive dialog: keyboard, focus, notes, free-text answers, and the
 * autopilot countdown.
 *
 * Nothing here decides policy. The dialog either produces answers from a human,
 * or reports that the countdown expired — the judge call happens outside the
 * render path, in the tool, so a slow model can never freeze the UI.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type KeybindingsManager, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Palette, Token } from "./palette.ts";
import type { Question, Questionnaire } from "../types.ts";
import { renderCollapsed, renderDialog, type ViewOption, type ViewState } from "./view.ts";

/** Rows the runtime appends to every question. */
export const CUSTOM_ROW_LABEL = "Type something.";
export const NOTE_ROW_LABEL = "Add a note";

export interface DialogAnswer {
	selected: string[];
	text?: string;
	note?: string;
}

export type DialogOutcome =
	| { kind: "answered"; answers: Map<number, DialogAnswer>; globalNote?: string }
	| { kind: "cancelled" }
	| { kind: "autopilot"; waitedSeconds: number };

export interface DialogOptions {
	questionnaire: Questionnaire;
	/** Seconds before the autopilot takes over. `0`/undefined disables the countdown. */
	timeoutSeconds?: number;
	autopilotHint?: string;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: (outcome: DialogOutcome) => void;
}

interface TabState {
	question: Question;
	selected: Set<string>;
	text?: string;
	note?: string;
}

function toPalette(theme: Theme): Palette {
	return {
		fg: (token: Token, text: string) => theme.fg(token, text),
		bg: (token, text) => theme.bg(token, text),
		bold: (text) => theme.bold(text),
	};
}

export class QuestionnaireDialog {
	private readonly palette: Palette;
	private readonly tabs: TabState[];
	private readonly editor: Editor;
	private readonly timeoutSeconds: number;
	private tab = 0;
	private index = 0;
	private focus: "browse" | "type" | "note" = "browse";
	/** What an open note editor writes into: the current question, or the whole questionnaire. */
	private noteTarget: "question" | "global" = "question";
	private collapsed = false;
	private countdown?: number;
	private timer?: ReturnType<typeof setInterval>;
	private deadline?: number;
	private globalNote?: string;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private settled = false;

	constructor(private readonly options: DialogOptions) {
		this.palette = toPalette(options.theme);
		this.tabs = options.questionnaire.questions.map((question) => ({
			question,
			selected: new Set<string>(),
		}));
		this.editor = new Editor(options.tui, {
			borderColor: (text) => options.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => options.theme.fg("accent", text),
				selectedText: (text) => options.theme.fg("accent", text),
				description: (text) => options.theme.fg("muted", text),
				scrollInfo: (text) => options.theme.fg("dim", text),
				noMatch: (text) => options.theme.fg("warning", text),
			},
		});
		this.editor.onSubmit = (value) => this.commitEditor(value);
		this.timeoutSeconds = options.timeoutSeconds ?? 0;
		if (this.timeoutSeconds > 0) this.startCountdown();
	}

	// --- countdown ---------------------------------------------------------

	private startCountdown(): void {
		this.countdown = this.timeoutSeconds;
		this.deadline = Date.now() + this.timeoutSeconds * 1000;
		this.timer = setInterval(() => {
			if (this.deadline === undefined) return;
			const left = Math.max(0, Math.round((this.deadline - Date.now()) / 1000));
			this.countdown = left;
			if (left <= 0) {
				this.settle({ kind: "autopilot", waitedSeconds: this.timeoutSeconds });
				return;
			}
			this.refresh();
		}, 1000);
		// Do not keep a headless embedder's process alive for a timer.
		(this.timer as unknown as { unref?: () => void }).unref?.();
	}

	/** Any real interaction means a human is here: stop counting down. */
	private takeOver(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.deadline = undefined;
		this.countdown = undefined;
	}

	private settle(outcome: DialogOutcome): void {
		if (this.settled) return;
		this.settled = true;
		this.takeOver();
		this.options.done(outcome);
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	// --- state helpers -----------------------------------------------------

	private get onSubmitTab(): boolean {
		return this.tab >= this.tabs.length;
	}

	private current(): TabState | undefined {
		return this.tabs[this.tab];
	}

	private isAnswered(state: TabState): boolean {
		return state.selected.size > 0 || (state.text !== undefined && state.text.trim().length > 0);
	}

	private rows(): ViewOption[] {
		const state = this.current();
		if (state === undefined) return [];
		const question = state.question;
		const rows: ViewOption[] = question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
			...(option.preview !== undefined ? { preview: option.preview } : {}),
			...(question.recommended === option.label ? { recommended: true } : {}),
			...(question.multiSelect === true ? { checked: state.selected.has(option.label) } : {}),
		}));
		rows.push({
			kind: "custom",
			label: state.text !== undefined && state.text.length > 0 ? `${CUSTOM_ROW_LABEL} ${state.text}` : CUSTOM_ROW_LABEL,
			description: state.text !== undefined && state.text.length > 0 ? "press Enter to edit your answer" : undefined,
		});
		rows.push({
			kind: "note",
			label: state.note !== undefined && state.note.length > 0 ? `${NOTE_ROW_LABEL} — ${state.note}` : NOTE_ROW_LABEL,
		});
		return rows;
	}

	private buildView(): ViewState {
		return {
			tabs: this.tabs.map((state) => {
				// Show what was actually chosen: a free-text answer as typed, otherwise
				// the picked labels in authored order. "(selected)" tells the user
				// nothing on the Submit tab.
				const picked = state.question.options
					.map((option) => option.label)
					.filter((label) => state.selected.has(label));
				const summary = state.text ?? (picked.length > 0 ? picked.join(", ") : undefined);
				return {
					header: state.question.header,
					...(state.question.category !== undefined ? { category: state.question.category } : {}),
					question: state.question.question,
					answered: this.isAnswered(state),
					...(summary !== undefined ? { text: summary } : {}),
					...(state.note !== undefined ? { note: state.note } : {}),
				};
			}),
			tab: this.tab,
			options: this.rows(),
			index: this.index,
			focus: this.focus,
			...(this.focus !== "browse" ? { editorLines: this.editor.render(Math.max(1, 60)) } : {}),
			...(this.countdown !== undefined ? { countdown: this.countdown } : {}),
			...(this.globalNote !== undefined ? { globalNote: this.globalNote } : {}),
			...(this.options.autopilotHint !== undefined ? { autopilotHint: this.options.autopilotHint } : {}),
		};
	}

	private refresh(): void {
		this.cachedLines = undefined;
		this.options.tui.requestRender();
	}

	private moveTab(direction: 1 | -1): void {
		const total = this.tabs.length + 1;
		this.tab = (this.tab + direction + total) % total;
		this.index = 0;
		this.focus = "browse";
		this.editor.setText("");
		this.refresh();
	}

	/** After an answer, move to the next unanswered question, else the Submit tab. */
	private advance(): void {
		// One question means there is nothing to review: submitting the pick is the
		// whole interaction, and an extra Submit tab would be pure ceremony.
		if (this.tabs.length === 1) {
			this.submitAnswers();
			return;
		}
		for (let offset = 1; offset <= this.tabs.length; offset++) {
			const candidate = (this.tab + offset) % this.tabs.length;
			const state = this.tabs[candidate];
			if (state !== undefined && !this.isAnswered(state)) {
				this.tab = candidate;
				this.index = 0;
				return;
			}
		}
		this.tab = this.tabs.length;
		this.index = 0;
	}

	/** Close the dialog with everything answered so far. */
	private submitAnswers(): void {
		const answers = new Map<number, DialogAnswer>();
		this.tabs.forEach((state, index) => {
			answers.set(index, {
				selected: state.question.options.map((option) => option.label).filter((label) => state.selected.has(label)),
				...(state.text !== undefined ? { text: state.text } : {}),
				...(state.note !== undefined ? { note: state.note } : {}),
			});
		});
		this.settle({
			kind: "answered",
			answers,
			...(this.globalNote !== undefined ? { globalNote: this.globalNote } : {}),
		});
	}

	// --- input -------------------------------------------------------------

	private openEditor(initial: string, mode: "type" | "note", target: "question" | "global" = "question"): void {
		this.focus = mode;
		this.noteTarget = target;
		this.editor.setText(initial);
		this.refresh();
	}

	private commitEditor(value: string): void {
		const state = this.current();
		const trimmed = value.trim();
		if (this.focus === "note") {
			if (this.noteTarget === "global") {
				this.globalNote = trimmed.length > 0 ? trimmed : undefined;
			} else if (state !== undefined) {
				state.note = trimmed.length > 0 ? trimmed : undefined;
			}
			this.focus = "browse";
			this.editor.setText("");
			this.refresh();
			return;
		}
		if (state === undefined) {
			this.focus = "browse";
			this.editor.setText("");
			this.refresh();
			return;
		}
		if (this.focus === "type") {
			state.text = trimmed.length > 0 ? trimmed : undefined;
			if (trimmed.length > 0) {
				state.selected.clear();
				this.advance();
			}
		}
		this.focus = "browse";
		this.editor.setText("");
		this.refresh();
	}

	handleInput(data: string): void {
		// A collapsed dialog only listens for the toggle and for Escape.
		if (this.collapsed) {
			if (matchesKey(data, Key.ctrl("]"))) {
				this.collapsed = false;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) this.settle({ kind: "cancelled" });
			return;
		}

		if (this.focus !== "browse") {
			if (matchesKey(data, Key.escape)) {
				this.focus = "browse";
				this.editor.setText("");
				this.takeOver();
				this.refresh();
				return;
			}
			this.takeOver();
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.ctrl("]"))) {
			this.collapsed = true;
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.settle({ kind: "cancelled" });
			return;
		}

		// From here on the human is present; stop any autopilot countdown.
		this.takeOver();

		if (this.tabs.length > 1) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				this.moveTab(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.moveTab(-1);
				return;
			}
		}

		if (this.onSubmitTab) {
			if (matchesKey(data, Key.enter)) {
				const missing = this.tabs.filter((state) => !this.isAnswered(state));
				if (missing.length === 0) {
					this.submitAnswers();
				} else {
					// Jump to the first unanswered question instead of doing nothing.
					const first = missing[0];
					this.tab = first === undefined ? 0 : this.tabs.indexOf(first);
					this.index = 0;
					this.refresh();
				}
				return;
			}
			if (matchesKey(data, "n")) {
				this.openEditor(this.globalNote ?? "", "note", "global");
				return;
			}
			return;
		}

		const rows = this.rows();
		if (matchesKey(data, Key.up)) {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = Math.min(rows.length - 1, this.index + 1);
			this.refresh();
			return;
		}

		const state = this.current();
		const row = rows[this.index];
		if (state === undefined || row === undefined) return;

		if (matchesKey(data, "n")) {
			this.openEditor(state.note ?? "", "note");
			return;
		}

		if (row.kind === "custom") {
			if (matchesKey(data, Key.enter)) this.openEditor(state.text ?? "", "type");
			return;
		}

		if (row.kind === "note") {
			if (matchesKey(data, Key.enter)) this.openEditor(state.note ?? "", "note");
			return;
		}

		const label = row.label;
		if (state.question.multiSelect === true) {
			if (matchesKey(data, Key.space)) {
				if (state.selected.has(label)) state.selected.delete(label);
				else state.selected.add(label);
				state.text = undefined;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (state.selected.size > 0) this.advance();
				else {
					state.selected.add(label);
					this.advance();
				}
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			state.selected.clear();
			state.selected.add(label);
			state.text = undefined;
			this.advance();
			this.refresh();
		}
	}

	// --- rendering ---------------------------------------------------------

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.collapsed) return [renderCollapsed(this.buildView(), this.palette)];
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const lines = renderDialog(this.buildView(), this.palette, width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

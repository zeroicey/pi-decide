/**
 * TUI doubles.
 *
 * The dialog is driven here with a fake TUI, a fake theme and a fake keybinding
 * manager, so keyboard behaviour is tested without a terminal — the same
 * approach `pi-unstall` uses for its engine.
 */

import { Editor } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ansiPalette, type Palette } from "../src/ui/palette.ts";

export interface Harness {
	/** Every screen drawn so far, as plain text lines. */
	screens: string[][];
	/** Deliver a raw key sequence. */
	press(...keys: string[]): void;
	/** The most recent rendered frame, with ANSI stripped. */
	lastScreen(): string[];
	/** The whole most recent frame as one string. */
	lastText(): string;
}

/** A `TUI` good enough for `new Editor()` and `requestRender()`. */
export function fakeTui() {
	return {
		terminal: { rows: 40, columns: 100 },
		requestRender: () => {},
	};
}

/** A `Theme` whose styling is observable but whose text stays readable. */
export function fakeTheme(): Theme {
	const palette = ansiPalette();
	return {
		fg: (token: keyof typeof TOKEN_ALIAS, text: string) => palette.fg(TOKEN_ALIAS[token] ?? "text", text),
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

const TOKEN_ALIAS: Record<string, Parameters<Palette["fg"]>[0]> = {
	accent: "accent",
	border: "border",
	borderAccent: "borderAccent",
	borderMuted: "borderMuted",
	success: "success",
	warning: "warning",
	error: "error",
	muted: "muted",
	dim: "dim",
	text: "text",
};

/** Strip ANSI so assertions can look at the words, not the escape codes. */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Patch the Editor onto a synchronous, keybindings-free clock. */
export function makeHarness(component: { render(width: number): string[]; handleInput(data: string): void }): Harness {
	const screens: string[][] = [];
	const draw = () => {
		screens.push(component.render(80).map(stripAnsi));
	};
	// Draw once up front so `lastScreen()` works before any key.
	draw();
	return {
		screens,
		press(...keys: string[]) {
			for (const key of keys) {
				component.handleInput(key);
				draw();
			}
		},
		lastScreen: () => screens[screens.length - 1] ?? [],
		lastText: () => (screens[screens.length - 1] ?? []).join("\n"),
	};
}

/** Key aliases for readability in tests. */
export const KEY = {
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	enter: "\r",
	esc: "\u001b",
	tab: "\t",
	shiftTab: "\u001b[Z",
	space: " ",
	note: "n",
	ctrlRightBracket: "\u001d",
};

/** Silence the unused-import lint for the type-only Editor reference. */
export type EditorCtor = typeof Editor;

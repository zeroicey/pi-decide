/**
 * A minimal styling surface.
 *
 * The view renders through this interface instead of Pi's `Theme` directly, so
 * the whole layout can be tested as plain strings (no ANSI, no terminal) while
 * the real dialog keeps the active theme's colours.
 */

export type Token =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "warning"
	| "error"
	| "muted"
	| "dim"
	| "text"
	| "mdHeading"
	| "mdCode"
	| "mdLink";

export type Background = "selectedBg" | "userMessageBg" | "toolPendingBg";

export interface Palette {
	fg(token: Token, text: string): string;
	bg(token: Background, text: string): string;
	bold(text: string): string;
}

/** Identity palette: everything is plain text. Used by tests and non-TTY hosts. */
export const PLAIN_PALETTE: Palette = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
};

/** ANSI palette for tests that need to prove styling is applied, not just called. */
export function ansiPalette(): Palette {
	return {
		fg: (token, text) => `\u001b[38;5;${(TOKEN_CODES[token] ?? 7).toString()}m${text}\u001b[0m`,
		bg: (_token, text) => `\u001b[48;5;236m${text}\u001b[0m`,
		bold: (text) => `\u001b[1m${text}\u001b[0m`,
	};
}

const TOKEN_CODES: Record<Token, number> = {
	accent: 39,
	border: 244,
	borderAccent: 39,
	borderMuted: 240,
	success: 41,
	warning: 214,
	error: 203,
	muted: 246,
	dim: 240,
	text: 15,
	mdHeading: 111,
	mdCode: 179,
	mdLink: 75,
};

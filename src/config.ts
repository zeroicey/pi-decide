/**
 * Configuration: defaults, tolerant merging, and file lookup.
 *
 * A malformed or unreadable config never throws. Every invalid field falls
 * back to its default, so a typo can never take the extension down — the
 * failure mode we cannot afford is "the dialog stopped working and the agent
 * is now blocked forever".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyMode } from "./types.ts";

export const CONFIG_FILE = "pi-decide.json";

/** Upper bounds on what a single call may declare. Generous, but bounded. */
export interface Limits {
	maxQuestions: number;
	maxOptions: number;
}

export interface JudgeConfig {
	/** `null` uses the session's current model. */
	model: { provider: string; model: string } | null;
	/** How many trailing conversation messages the judge sees. */
	tailMessages: number;
	/** Hard cap on the transcript excerpt handed to the judge. */
	maxTailChars: number;
	/** Abort the judge call after this long. */
	timeoutMs: number;
}

export interface DecideConfig {
	enabled: boolean;
	autopilot: {
		/** `off` always asks; `on` never asks; `auto` asks then self-answers. */
		mode: PolicyMode;
		/** Seconds before an `auto` dialog answers itself. `0` = wait forever. */
		timeoutSeconds: number;
	};
	ui: {
		/** Terminal BEL when the dialog starts waiting on a human. */
		bell: boolean;
	};
	judge: JudgeConfig;
	limits: Limits;
	/** Notify on autopilot resolution so the transcript shows what happened. */
	notify: boolean;
	debug: boolean;
}

export function defaultConfig(): DecideConfig {
	return {
		enabled: true,
		autopilot: { mode: "off", timeoutSeconds: 180 },
		ui: { bell: true },
		judge: { model: null, tailMessages: 10, maxTailChars: 8000, timeoutMs: 90_000 },
		limits: { maxQuestions: 8, maxOptions: 8 },
		notify: true,
		debug: false,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: fallback;
}

export function parsePolicyMode(value: unknown): PolicyMode | undefined {
	return value === "off" || value === "on" || value === "auto" ? value : undefined;
}

/** Merge an untrusted parsed value over a base config. Never throws. */
export function mergeConfig(base: DecideConfig, raw: unknown): DecideConfig {
	if (!isPlainObject(raw)) return base;
	const autopilot = isPlainObject(raw.autopilot) ? raw.autopilot : {};
	const ui = isPlainObject(raw.ui) ? raw.ui : {};
	const judge = isPlainObject(raw.judge) ? raw.judge : {};
	const limits = isPlainObject(raw.limits) ? raw.limits : {};
	const judgeModel = isPlainObject(judge.model) ? judge.model : null;
	const model =
		judgeModel !== null &&
		typeof judgeModel.provider === "string" &&
		judgeModel.provider.length > 0 &&
		typeof judgeModel.model === "string" &&
		judgeModel.model.length > 0
			? { provider: judgeModel.provider, model: judgeModel.model }
			: null;

	return {
		enabled: bool(raw.enabled, base.enabled),
		autopilot: {
			mode: parsePolicyMode(autopilot.mode) ?? base.autopilot.mode,
			// 0 means "no countdown"; anything above a day is a typo, not a wish.
			timeoutSeconds: int(autopilot.timeoutSeconds, base.autopilot.timeoutSeconds, 0, 86_400),
		},
		ui: { bell: bool(ui.bell, base.ui.bell) },
		judge: {
			model,
			tailMessages: int(judge.tailMessages, base.judge.tailMessages, 1, 60),
			maxTailChars: int(judge.maxTailChars, base.judge.maxTailChars, 500, 200_000),
			timeoutMs: int(judge.timeoutMs, base.judge.timeoutMs, 1_000, 600_000),
		},
		limits: {
			maxQuestions: int(limits.maxQuestions, base.limits.maxQuestions, 1, 32),
			maxOptions: int(limits.maxOptions, base.limits.maxOptions, 2, 32),
		},
		notify: bool(raw.notify, base.notify),
		debug: bool(raw.debug, base.debug),
	};
}

export interface LoadedConfig {
	config: DecideConfig;
	/** Absolute path of the config file, whether or not it exists. */
	path: string;
	/** Set when the file exists but could not be used as written. */
	warning?: string;
}

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE);
}

/** Read the config file for `agentDir`. Missing file = defaults, no warning. */
export function loadConfig(agentDir: string): LoadedConfig {
	const path = configPath(agentDir);
	const base = defaultConfig();
	if (!existsSync(path)) return { config: base, path };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			config: base,
			path,
			warning: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return {
			config: base,
			path,
			warning: `malformed JSON in ${path} (using defaults): ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
	return { config: mergeConfig(base, raw), path };
}

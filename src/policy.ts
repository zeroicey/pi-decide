/**
 * Policy resolution: who answers a questionnaire — the human, the model, or a
 * countdown that falls back to the model.
 *
 * Precedence is deliberate and asymmetric. Three rules carry all the weight:
 *
 * 1. **An unattended run must never block.** No UI at all (headless `json` /
 *    `print`) forces autopilot, because the alternative is a run that hangs
 *    until someone notices.
 * 2. **The user's "never ask me" outranks the model's request to ask.** A model
 *    that could upgrade an `on` policy back to a blocking dialog would be able
 *    to stall the very run the policy exists to keep moving.
 * 3. **The countdown never kills a dialog that is not actually being used.**
 *    `auto` only counts down when `timeoutSeconds > 0`; with `0` it is a plain
 *    question. Silently deciding after a fixed delay is opt-in.
 */

import type { DecideConfig } from "./config.ts";
import type { Policy, PolicyMode } from "./types.ts";

/** Which rendering primitive the host actually has. */
export type HostKind = "tui" | "rpc" | "none";

export interface PolicyInput {
	config: DecideConfig;
	/** Session override set by `/decide off|on|auto`. */
	sessionMode?: PolicyMode;
	/** Per-call override supplied by the model. */
	perCallMode?: "ask" | "auto";
	host: HostKind;
}

export interface Resolved {
	policy: Policy;
	/** The effective mode, after every override has been applied. */
	mode: PolicyMode;
	/** Whether a dialog should be shown at all. */
	ask: boolean;
	/** Why this resolution happened — surfaced in the transcript on autopilot. */
	why: string;
}

/** Resolve the effective policy for one invocation. */
export function resolvePolicy(input: PolicyInput): Resolved {
	const configured = input.sessionMode ?? input.config.autopilot.mode;
	const source: Policy["source"] = input.sessionMode
		? "flag"
		: input.perCallMode
			? "per-call"
			: "config";

	let mode: PolicyMode = configured;
	let why = `policy: ${configured}${input.sessionMode ? " (session override)" : " (config)"}`;

	if (input.host === "none") {
		mode = "on";
		why = "no interactive UI in this mode — autopilot answers so the run cannot block";
	} else if (input.perCallMode === "auto" && configured !== "off") {
		mode = "on";
		why = "per-call mode:auto — autopilot answers";
	} else if (input.perCallMode === "auto") {
		why = "per-call mode:auto ignored — the session policy is `off` (always ask)";
	} else if (input.perCallMode === "ask" && configured === "on") {
		why = "per-call mode:ask ignored — the session policy is `on` (never ask)";
	} else if (input.perCallMode === "ask") {
		mode = "off";
		why = "per-call mode:ask — the dialog always waits for the human";
	}

	const timeoutSeconds = mode === "auto" ? Math.max(0, input.config.autopilot.timeoutSeconds) : 0;

	return {
		policy: { mode, timeoutSeconds, bell: input.config.ui.bell, source },
		mode,
		ask: mode !== "on",
		why,
	};
}

/** Human-readable one-liner for the footer status and `/decide` output. */
export function describePolicy(mode: PolicyMode, timeoutSeconds: number): string {
	switch (mode) {
		case "off":
			return "ask";
		case "on":
			return "auto (never ask)";
		case "auto":
			return timeoutSeconds > 0 ? `auto after ${timeoutSeconds}s` : "auto (no countdown)";
	}
}

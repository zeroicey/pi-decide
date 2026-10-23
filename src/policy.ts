/**
 * Policy resolution: who answers a questionnaire — the human, the model, or a
 * countdown that falls back to the model.
 *
 * Precedence is deliberately asymmetric. Four rules carry all the weight:
 *
 * 1. **An unattended run must never hang.** That is a *system* invariant, not a
 *    policy outcome, so it cannot depend on which mode happens to be selected:
 *    - headless (`json` / `print`) has no UI at all, so it forces autopilot;
 *    - every asking mode carries a **deadline**. `off` means "prefer to ask me",
 *      not "wait for me forever" — a run that waits forever is exactly the bug
 *      this extension exists to fix. `deadlineSeconds: 0` (or `/decide hold`)
 *      is the explicit, non-default "I accept the risk" escape hatch.
 * 2. **The user's "never ask me" outranks the model's request to ask.** A model
 *    that could upgrade an `on` policy back to a blocking dialog would be able
 *    to stall the very run the policy exists to keep moving.
 * 3. **The model cannot escalate itself into autonomy either.** `mode: "auto"`
 *    is ignored when the policy is `off`; only the deadline — not the model —
 *    can shorten the user's patience.
 * 4. **A deliberate delay and a safety net are different things.** `auto` says
 *    "answer after N seconds"; `off` says "wait, and only answer at the very
 *    end". They get different countdown labels so the user can tell which one
 *    is about to happen.
 */

import type { DecideConfig } from "./config.ts";
import type { Policy, PolicyMode } from "./types.ts";

/** Which rendering primitive the host actually has. */
export type HostKind = "tui" | "rpc" | "none";

export interface PolicyInput {
	config: DecideConfig;
	/** Session override set by `/decide off|on|auto`. */
	sessionMode?: PolicyMode;
	/** Session override of the deadline, in seconds. `0` means unbounded. */
	sessionDeadline?: number;
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
	/**
	 * Why the countdown is running: `"auto"` is a deliberate delay the user
	 * asked for, `"deadline"` is the safety net on an `off` policy.
	 */
	deadlineKind: "auto" | "deadline";
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

	const deadlineSeconds =
		input.sessionDeadline !== undefined
			? Math.max(0, input.sessionDeadline)
			: Math.max(0, input.config.autopilot.deadlineSeconds);

	// `on` asks nothing, so it has no countdown. Everything that asks gets one:
	// `auto` uses its own delay, `off` uses the safety-net deadline.
	const deadlineKind: "auto" | "deadline" = mode === "auto" ? "auto" : "deadline";
	const timeoutSeconds =
		mode === "on"
			? 0
			: mode === "auto"
				? Math.max(0, input.config.autopilot.timeoutSeconds)
				: deadlineSeconds;

	if (mode === "off" && timeoutSeconds === 0) {
		why += " — deadline disabled, this dialog will wait indefinitely";
	}

	return {
		policy: { mode, timeoutSeconds, bell: input.config.ui.bell, source },
		mode,
		ask: mode !== "on",
		deadlineKind,
		why,
	};
}

/** Human-readable one-liner for the footer status and `/decide` output. */
export function describePolicy(mode: PolicyMode, timeoutSeconds: number): string {
	const minutes = (seconds: number) =>
		seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
	switch (mode) {
		case "off":
			return timeoutSeconds > 0 ? `ask (autopilot after ${minutes(timeoutSeconds)})` : "ask (waits forever)";
		case "on":
			return "auto (never ask)";
		case "auto":
			return timeoutSeconds > 0 ? `auto after ${minutes(timeoutSeconds)}` : "auto (no countdown → waits)";
	}
}

/** Short footer badge, or undefined when there is nothing worth showing. */
export function statusBadge(mode: PolicyMode, activeSeconds: number, override: boolean): string | undefined {
	if (mode === "on") return `🤖 auto${override ? "*" : ""}`;
	const suffix = override ? "*" : "";
	if (mode === "auto") {
		const window = activeSeconds > 0 ? `${activeSeconds}s` : "∞";
		return `🤖 auto:${window}${suffix}`;
	}
	// `off` is the default; only mark it when the deadline is disabled, because
	// that is the one state where the run really can block.
	return activeSeconds === 0 ? `🤖 hold${suffix}` : undefined;
}

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { describePolicy, resolvePolicy, statusBadge } from "../src/policy.ts";

function config(mode: "off" | "on" | "auto", timeoutSeconds = 30, deadlineSeconds = 900) {
	return { ...defaultConfig(), autopilot: { mode, timeoutSeconds, deadlineSeconds } };
}

describe("resolvePolicy", () => {
	test("off asks, but is still capped by the deadline", () => {
		// The system invariant: "an unattended run never hangs". `off` means
		// "prefer to ask me", not "wait for me forever".
		const resolved = resolvePolicy({ config: config("off", 30, 900), host: "tui" });
		expect(resolved.mode).toBe("off");
		expect(resolved.ask).toBe(true);
		expect(resolved.deadlineKind).toBe("deadline");
		expect(resolved.policy.timeoutSeconds).toBe(900);
	});

	test("off with deadlineSeconds 0 is the explicit unbounded escape hatch", () => {
		const resolved = resolvePolicy({ config: config("off", 30, 0), host: "tui" });
		expect(resolved.mode).toBe("off");
		expect(resolved.ask).toBe(true);
		expect(resolved.policy.timeoutSeconds).toBe(0);
		expect(resolved.why).toContain("wait indefinitely");
	});

	test("a session deadline override beats the configured one", () => {
		const resolved = resolvePolicy({ config: config("off", 30, 900), host: "tui", sessionDeadline: 0 });
		expect(resolved.policy.timeoutSeconds).toBe(0);
		const shorter = resolvePolicy({ config: config("off", 30, 900), host: "tui", sessionDeadline: 60 });
		expect(shorter.policy.timeoutSeconds).toBe(60);
	});

	test("on never asks and carries no countdown", () => {
		const resolved = resolvePolicy({ config: config("on"), host: "tui" });
		expect(resolved.mode).toBe("on");
		expect(resolved.ask).toBe(false);
		expect(resolved.policy.timeoutSeconds).toBe(0);
	});

	test("no mode with a dialog can hang, whatever the config", () => {
		// The invariant, stated as a test: every asking resolution has either a
		// countdown or an explicit user-chosen unbounded deadline.
		for (const mode of ["off", "auto"] as const) {
			for (const host of ["tui", "rpc"] as const) {
				const resolved = resolvePolicy({ config: config(mode, 30, 900), host });
				expect(resolved.ask).toBe(true);
				expect(resolved.policy.timeoutSeconds).toBeGreaterThan(0);
			}
		}
	});

	test("auto asks and carries its own countdown, not the deadline", () => {
		const resolved = resolvePolicy({ config: config("auto", 45, 900), host: "tui" });
		expect(resolved.mode).toBe("auto");
		expect(resolved.ask).toBe(true);
		expect(resolved.deadlineKind).toBe("auto");
		expect(resolved.policy.timeoutSeconds).toBe(45);
	});

	test("auto with a zero countdown still asks, and never self-answers on a timer", () => {
		const resolved = resolvePolicy({ config: config("auto", 0), host: "tui" });
		expect(resolved.ask).toBe(true);
		expect(resolved.policy.timeoutSeconds).toBe(0);
	});

	test("no interactive UI forces autopilot whatever the config says", () => {
		const resolved = resolvePolicy({ config: config("off"), host: "none" });
		expect(resolved.mode).toBe("on");
		expect(resolved.ask).toBe(false);
		expect(resolved.why).toContain("no interactive UI");
	});

	test("per-call mode:auto upgrades a countdown, but cannot overrule the user's `off`", () => {
		// The model asking for autonomy is not the user granting it: `off` means
		// "always ask me", and only the user can lift that.
		expect(resolvePolicy({ config: config("off"), host: "tui", perCallMode: "auto" }).mode).toBe("off");
		expect(resolvePolicy({ config: config("auto", 10), host: "tui", perCallMode: "auto" }).mode).toBe("on");
		// A session override outranks the config, and `off` means off.
		expect(
			resolvePolicy({ config: config("auto", 10), host: "tui", sessionMode: "off", perCallMode: "auto" }).mode,
		).toBe("off");
	});

	test("per-call mode:ask always waits — it is the only escape from a session override", () => {
		const resolved = resolvePolicy({ config: config("auto", 10), host: "tui", perCallMode: "ask" });
		expect(resolved.mode).toBe("off");
		expect(resolved.ask).toBe(true);
	});

	test("per-call mode:ask is ignored when the session policy is on", () => {
		const resolved = resolvePolicy({ config: config("off"), host: "tui", sessionMode: "on", perCallMode: "ask" });
		expect(resolved.mode).toBe("on");
		expect(resolved.ask).toBe(false);
		expect(resolved.why).toContain("ignored");
	});

	test("a session override outranks the config and records its source", () => {
		const resolved = resolvePolicy({ config: config("off"), host: "tui", sessionMode: "on" });
		expect(resolved.mode).toBe("on");
		expect(resolved.policy.source).toBe("flag");
	});

	test("per-call mode records its source when it is doing the work", () => {
		expect(resolvePolicy({ config: config("auto", 10), host: "tui", perCallMode: "auto" }).policy.source).toBe(
			"per-call",
		);
		expect(resolvePolicy({ config: config("auto", 10), host: "tui" }).policy.source).toBe("config");
	});
});

describe("describePolicy", () => {
	test("reads as a sentence a user can act on", () => {
		expect(describePolicy("off", 900)).toBe("ask (autopilot after 15m)");
		expect(describePolicy("off", 0)).toBe("ask (waits forever)");
		expect(describePolicy("on", 0)).toBe("auto (never ask)");
		expect(describePolicy("auto", 30)).toBe("auto after 30s");
		expect(describePolicy("auto", 0)).toBe("auto (no countdown → waits)");
	});
});

describe("statusBadge", () => {
	test("stays invisible for the default capped `off` policy", () => {
		expect(statusBadge("off", 900, false)).toBeUndefined();
	});

	test("warns when the deadline is disabled", () => {
		expect(statusBadge("off", 0, false)).toBe("🤖 hold");
		expect(statusBadge("off", 0, true)).toBe("🤖 hold*");
	});

	test("marks the mode and override", () => {
		expect(statusBadge("on", 0, false)).toBe("🤖 auto");
		expect(statusBadge("auto", 180, true)).toBe("🤖 auto:180s*");
		expect(statusBadge("auto", 0, false)).toBe("🤖 auto:∞");
	});
});

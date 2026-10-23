import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { describePolicy, resolvePolicy } from "../src/policy.ts";

function config(mode: "off" | "on" | "auto", timeoutSeconds = 30) {
	return { ...defaultConfig(), autopilot: { mode, timeoutSeconds } };
}

describe("resolvePolicy", () => {
	test("off always asks", () => {
		const resolved = resolvePolicy({ config: config("off"), host: "tui" });
		expect(resolved.mode).toBe("off");
		expect(resolved.ask).toBe(true);
		expect(resolved.policy.timeoutSeconds).toBe(0);
	});

	test("on never asks", () => {
		const resolved = resolvePolicy({ config: config("on"), host: "tui" });
		expect(resolved.mode).toBe("on");
		expect(resolved.ask).toBe(false);
	});

	test("auto asks and carries the countdown", () => {
		const resolved = resolvePolicy({ config: config("auto", 45), host: "tui" });
		expect(resolved.mode).toBe("auto");
		expect(resolved.ask).toBe(true);
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
		expect(describePolicy("off", 0)).toBe("ask");
		expect(describePolicy("on", 0)).toBe("auto (never ask)");
		expect(describePolicy("auto", 30)).toBe("auto after 30s");
		expect(describePolicy("auto", 0)).toBe("auto (no countdown)");
	});
});

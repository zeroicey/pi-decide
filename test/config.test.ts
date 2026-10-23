import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig, parsePolicyMode } from "../src/config.ts";

describe("mergeConfig", () => {
	test("returns the base config for non-objects", () => {
		const base = defaultConfig();
		for (const raw of [null, undefined, 42, "x", []]) {
			expect(mergeConfig(base, raw)).toEqual(base);
		}
	});

	test("applies valid overrides", () => {
		const config = mergeConfig(defaultConfig(), {
			enabled: false,
			autopilot: { mode: "auto", timeoutSeconds: 45, deadlineSeconds: 600 },
			ui: { bell: false },
			judge: { tailMessages: 4, maxTailChars: 2000, timeoutMs: 5000 },
			limits: { maxQuestions: 3, maxOptions: 5 },
		});
		expect(config.enabled).toBe(false);
		expect(config.autopilot).toEqual({ mode: "auto", timeoutSeconds: 45, deadlineSeconds: 600 });
		expect(config.ui.bell).toBe(false);
		expect(config.judge.tailMessages).toBe(4);
		expect(config.judge.maxTailChars).toBe(2000);
		expect(config.judge.timeoutMs).toBe(5000);
		expect(config.limits).toEqual({ maxQuestions: 3, maxOptions: 5 });
	});

	test("drops every invalid field instead of failing", () => {
		const defaults = defaultConfig();
		const config = mergeConfig(defaults, {
			enabled: "yes",
			autopilot: { mode: "maybe", timeoutSeconds: -3, deadlineSeconds: -1 },
			judge: { tailMessages: 0, maxTailChars: "big", timeoutMs: 1.5 },
			limits: { maxQuestions: 999, maxOptions: 1 },
		});
		expect(config.enabled).toBe(defaults.enabled);
		expect(config.autopilot.mode).toBe(defaults.autopilot.mode);
		expect(config.autopilot.timeoutSeconds).toBe(defaults.autopilot.timeoutSeconds);
		expect(config.autopilot.deadlineSeconds).toBe(defaults.autopilot.deadlineSeconds);
		expect(config.judge.tailMessages).toBe(defaults.judge.tailMessages);
		expect(config.judge.maxTailChars).toBe(defaults.judge.maxTailChars);
		expect(config.judge.timeoutMs).toBe(defaults.judge.timeoutMs);
		expect(config.limits.maxQuestions).toBe(defaults.limits.maxQuestions);
		expect(config.limits.maxOptions).toBe(defaults.limits.maxOptions);
	});

	test("accepts a pinned judge model only when both halves are present", () => {
		expect(mergeConfig(defaultConfig(), { judge: { model: { provider: "magpie", model: "x" } } }).judge.model)
			.toEqual({ provider: "magpie", model: "x" });
		expect(mergeConfig(defaultConfig(), { judge: { model: { provider: "magpie" } } }).judge.model).toBeNull();
		expect(mergeConfig(defaultConfig(), { judge: { model: { provider: "", model: "x" } } }).judge.model).toBeNull();
	});

	test("timeoutSeconds accepts 0 (countdown disabled) and rejects > 1 day", () => {
		expect(mergeConfig(defaultConfig(), { autopilot: { timeoutSeconds: 0 } }).autopilot.timeoutSeconds).toBe(0);
		const day = 86_400;
		expect(mergeConfig(defaultConfig(), { autopilot: { timeoutSeconds: day } }).autopilot.timeoutSeconds).toBe(day);
		expect(
			mergeConfig(defaultConfig(), { autopilot: { timeoutSeconds: day + 1 } }).autopilot.timeoutSeconds,
		).toBe(defaultConfig().autopilot.timeoutSeconds);
	});
});

describe("parsePolicyMode", () => {
	test("accepts exactly the three modes", () => {
		expect(parsePolicyMode("off")).toBe("off");
		expect(parsePolicyMode("on")).toBe("on");
		expect(parsePolicyMode("auto")).toBe("auto");
		for (const raw of ["OFF", "ask", "", null, 1, {}]) expect(parsePolicyMode(raw)).toBeUndefined();
	});
});

describe("defaults", () => {
	test("ship with autopilot off so nothing changes silently", () => {
		const config = defaultConfig();
		expect(config.enabled).toBe(true);
		expect(config.autopilot.mode).toBe("off");
		expect(config.autopilot.timeoutSeconds).toBeGreaterThan(0);
		expect(config.ui.bell).toBe(true);
		expect(config.judge.model).toBeNull();
	});
});

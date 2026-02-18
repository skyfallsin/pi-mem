import { describe, it } from "node:test";
import assert from "node:assert";
import { todayStr, yesterdayStr, nowTimestamp, shortSessionId, dailyPath } from "../lib.ts";

describe("todayStr", () => {
	it("returns YYYY-MM-DD format", () => {
		const result = todayStr();
		assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
	});

	it("matches current date", () => {
		const expected = new Date().toISOString().slice(0, 10);
		assert.strictEqual(todayStr(), expected);
	});
});

describe("yesterdayStr", () => {
	it("returns YYYY-MM-DD format", () => {
		const result = yesterdayStr();
		assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
	});

	it("is exactly one day before today", () => {
		const today = new Date(todayStr());
		const yesterday = new Date(yesterdayStr());
		const diffMs = today.getTime() - yesterday.getTime();
		assert.strictEqual(diffMs, 24 * 60 * 60 * 1000);
	});
});

describe("nowTimestamp", () => {
	it("returns space-separated date and time", () => {
		const ts = nowTimestamp();
		assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("does not contain T or Z", () => {
		const ts = nowTimestamp();
		assert.ok(!ts.includes("T"));
		assert.ok(!ts.includes("Z"));
	});
});

describe("shortSessionId", () => {
	it("returns first 8 characters", () => {
		assert.strictEqual(shortSessionId("abcdefghijklmnop"), "abcdefgh");
	});

	it("handles UUID-style IDs", () => {
		assert.strictEqual(shortSessionId("550e8400-e29b-41d4-a716-446655440000"), "550e8400");
	});

	it("handles short input gracefully", () => {
		assert.strictEqual(shortSessionId("abc"), "abc");
	});

	it("returns empty string for empty input", () => {
		assert.strictEqual(shortSessionId(""), "");
	});
});

describe("dailyPath", () => {
	it("builds correct path for a date", () => {
		const result = dailyPath("/mem/daily", "2026-02-18");
		assert.strictEqual(result, "/mem/daily/2026-02-18.md");
	});

	it("handles trailing slash in dir", () => {
		const result = dailyPath("/mem/daily/", "2026-01-01");
		assert.ok(result.endsWith("2026-01-01.md"));
	});
});

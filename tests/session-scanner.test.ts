import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanSession, isHousekeeping } from "../lib.ts";
import { makeTempDir, cleanup } from "./helpers.ts";

let tmpDir: string;

beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

function writeSessionFile(dir: string, name: string, lines: any[]): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf-8");
	return filePath;
}

describe("scanSession", () => {
	it("extracts title from session_info entry", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString(), cwd: "/project" },
			{ type: "session_info", name: "Fix memory bug" },
			{ type: "message", message: { role: "user", content: "hello" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title, "Fix memory bug");
		assert.strictEqual(result.cwd, "/project");
	});

	it("falls back to first user message when no session_info", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "assistant", content: "Hi" } },
			{ type: "message", message: { role: "user", content: "Can you fix the tests?" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title, "Can you fix the tests?");
	});

	it("handles array content in user message fallback", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Array content message" }] } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title, "Array content message");
	});

	it("truncates long titles to 80 chars", async () => {
		const longMsg = "A".repeat(200);
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "user", content: longMsg } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title.length, 80);
	});

	it("returns (untitled) when no title or user messages", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "assistant", content: "response" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title, "(untitled)");
	});

	it("sums costs from assistant messages", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "assistant", content: "r1", usage: { cost: { total: 0.05 } } } },
			{ type: "message", message: { role: "assistant", content: "r2", usage: { cost: { total: 0.10 } } } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.ok(Math.abs(result.cost - 0.15) < 0.001);
	});

	it("detects child sessions", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString(), parentSession: "parent-123" },
			{ type: "message", message: { role: "user", content: "sub-task" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.isChild, true);
		assert.strictEqual(result.parentSession, "parent-123");
	});

	it("detects root sessions (no parent)", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "user", content: "root task" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.isChild, false);
		assert.strictEqual(result.parentSession, undefined);
	});

	it("returns null for old sessions outside lookback window", async () => {
		const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: oldDate },
			{ type: "message", message: { role: "user", content: "old stuff" } },
		]);
		const result = await scanSession(filePath);
		assert.strictEqual(result, null);
	});

	it("returns null for invalid JSON header", async () => {
		const filePath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(filePath, "not json\n", "utf-8");
		const result = await scanSession(filePath);
		assert.strictEqual(result, null);
	});

	it("returns null for header without timestamp", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ cwd: "/project" },
		]);
		const result = await scanSession(filePath);
		assert.strictEqual(result, null);
	});

	it("returns null for non-existent file", async () => {
		const result = await scanSession(path.join(tmpDir, "nope.jsonl"));
		assert.strictEqual(result, null);
	});

	it("handles lines with invalid JSON gracefully (skips them)", async () => {
		const filePath = path.join(tmpDir, "mixed.jsonl");
		const header = JSON.stringify({ timestamp: new Date().toISOString() });
		const good = JSON.stringify({ type: "session_info", name: "Good Title" });
		fs.writeFileSync(filePath, `${header}\ngarbage line\n${good}\n`, "utf-8");
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.title, "Good Title");
	});

	it("defaults cost to 0 when no usage data", async () => {
		const filePath = writeSessionFile(tmpDir, "session.jsonl", [
			{ timestamp: new Date().toISOString() },
			{ type: "message", message: { role: "assistant", content: "no cost" } },
		]);
		const result = await scanSession(filePath);
		assert.ok(result);
		assert.strictEqual(result.cost, 0);
	});
});

describe("isHousekeeping", () => {
	it("detects 'clear done' titles", () => {
		assert.ok(isHousekeeping("Clear done items"));
		assert.ok(isHousekeeping("clear scratchpad"));
	});

	it("detects 'review scratchpad' titles", () => {
		assert.ok(isHousekeeping("Review scratchpad items"));
		assert.ok(isHousekeeping("Read daily log"));
	});

	it("detects '(untitled)' as housekeeping", () => {
		assert.ok(isHousekeeping("(untitled)"));
	});

	it("detects bare slash commands", () => {
		assert.ok(isHousekeeping("/reload"));
		assert.ok(isHousekeeping("/new"));
	});

	it("detects 'write daily log'", () => {
		assert.ok(isHousekeeping("Write daily log for today"));
	});

	it("detects scratchpad management titles", () => {
		assert.ok(isHousekeeping("Scratchpad maintenance"));
		assert.ok(isHousekeeping("Scratchpad reviewed"));
		assert.ok(isHousekeeping("scratchpad items update"));
	});

	it("detects dash-prefixed housekeeping", () => {
		assert.ok(isHousekeeping("- no done items left"));
		assert.ok(isHousekeeping("- scratchpad cleaned up"));
		assert.ok(isHousekeeping("- cleared all items"));
	});

	it("does not flag real work titles", () => {
		assert.ok(!isHousekeeping("Fix memory bug"));
		assert.ok(!isHousekeeping("Deploy trading bot"));
		assert.ok(!isHousekeeping("Write tests for pi-mem"));
		assert.ok(!isHousekeeping("Review PR #42"));
		assert.ok(!isHousekeeping("Debug WebSocket connection"));
	});

	it("is case insensitive", () => {
		assert.ok(isHousekeeping("CLEAR DONE"));
		assert.ok(isHousekeeping("Clear Done Items"));
	});
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import { searchMemory, ensureDirs } from "../lib.ts";
import { makeTempDir, cleanup, makeConfig, writeFile } from "./helpers.ts";

let tmpDir: string;

beforeEach(() => { tmpDir = makeTempDir(); });
afterEach(() => { cleanup(tmpDir); });

describe("searchMemory", () => {
	it("finds content in MEMORY.md", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "Important decision: use PostgreSQL", "utf-8");
		const result = searchMemory(config, "postgresql");
		assert.strictEqual(result.lineResults.length, 1);
		assert.ok(result.lineResults[0].text.includes("PostgreSQL"));
		assert.strictEqual(result.lineResults[0].file, "MEMORY.md");
		assert.strictEqual(result.lineResults[0].line, 1);
	});

	it("finds content in daily logs", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/2026-02-18.md`, "line one\nDeployed trading bot\nline three");
		const result = searchMemory(config, "trading bot");
		assert.strictEqual(result.lineResults.length, 1);
		assert.strictEqual(result.lineResults[0].file, "daily/2026-02-18.md");
		assert.strictEqual(result.lineResults[0].line, 2);
	});

	it("finds content in notes", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.notesDir}/lessons.md`, "Lesson learned: always test");
		const result = searchMemory(config, "lesson");
		assert.strictEqual(result.lineResults.length, 1);
		assert.strictEqual(result.lineResults[0].file, "notes/lessons.md");
	});

	it("is case-insensitive", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "PostgreSQL is great", "utf-8");
		const result = searchMemory(config, "POSTGRESQL");
		assert.strictEqual(result.lineResults.length, 1);
	});

	it("matches filenames", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "some content", "utf-8");
		const result = searchMemory(config, "memory");
		assert.ok(result.fileMatches.includes("MEMORY.md"));
	});

	it("respects maxResults limit", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const lines = Array.from({ length: 50 }, (_, i) => `match line ${i}`).join("\n");
		fs.writeFileSync(config.memoryFile, lines, "utf-8");
		const result = searchMemory(config, "match", 5);
		assert.strictEqual(result.lineResults.length, 5);
	});

	it("returns empty results for no matches", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "nothing relevant here", "utf-8");
		const result = searchMemory(config, "xyznonexistent");
		assert.strictEqual(result.fileMatches.length, 0);
		assert.strictEqual(result.lineResults.length, 0);
	});

	it("returns empty results when no files exist", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		const result = searchMemory(config, "anything");
		assert.strictEqual(result.fileMatches.length, 0);
		assert.strictEqual(result.lineResults.length, 0);
	});

	it("searches across all directories", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "target in memory", "utf-8");
		writeFile(`${config.dailyDir}/2026-02-18.md`, "target in daily");
		writeFile(`${config.notesDir}/work.md`, "target in notes");
		const result = searchMemory(config, "target");
		assert.strictEqual(result.lineResults.length, 3);
		const files = result.lineResults.map(r => r.file);
		assert.ok(files.includes("MEMORY.md"));
		assert.ok(files.some(f => f.startsWith("daily/")));
		assert.ok(files.some(f => f.startsWith("notes/")));
	});

	it("does not deduplicate filename matches", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.dailyDir}/2026-02-18.md`, "some content");
		// Searching for "2026-02-18" matches the filename
		const result = searchMemory(config, "2026-02-18");
		assert.ok(result.fileMatches.includes("daily/2026-02-18.md"));
	});

	it("trims trailing whitespace from matched lines", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		fs.writeFileSync(config.memoryFile, "match with trailing spaces   \n", "utf-8");
		const result = searchMemory(config, "match");
		assert.strictEqual(result.lineResults[0].text, "match with trailing spaces");
	});

	it("only searches .md files", () => {
		const config = makeConfig(tmpDir);
		ensureDirs(config);
		writeFile(`${config.memoryDir}/data.json`, '{"target": true}');
		writeFile(`${config.memoryDir}/notes.md`, "target in md");
		// json file should not be content-searched (searchDir filters to .md)
		const result = searchMemory(config, "target");
		assert.strictEqual(result.lineResults.length, 1);
		assert.strictEqual(result.lineResults[0].file, "notes.md");
	});
});

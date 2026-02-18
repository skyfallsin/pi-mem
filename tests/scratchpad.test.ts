import { describe, it } from "node:test";
import assert from "node:assert";
import { parseScratchpad, serializeScratchpad, type ScratchpadItem } from "../lib.ts";

describe("parseScratchpad", () => {
	it("parses open items", () => {
		const items = parseScratchpad("- [ ] Fix the bug\n- [ ] Write tests");
		assert.strictEqual(items.length, 2);
		assert.strictEqual(items[0].done, false);
		assert.strictEqual(items[0].text, "Fix the bug");
		assert.strictEqual(items[1].text, "Write tests");
	});

	it("parses done items", () => {
		const items = parseScratchpad("- [x] Done task\n- [X] Also done");
		assert.strictEqual(items.length, 2);
		assert.strictEqual(items[0].done, true);
		assert.strictEqual(items[1].done, true);
	});

	it("parses mixed open and done items", () => {
		const items = parseScratchpad("- [ ] Open\n- [x] Done\n- [ ] Another open");
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items[0].done, false);
		assert.strictEqual(items[1].done, true);
		assert.strictEqual(items[2].done, false);
	});

	it("captures meta comment from preceding line", () => {
		const content = "<!-- 2026-02-18 10:00:00 [abc12345] -->\n- [ ] Task with meta";
		const items = parseScratchpad(content);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].meta, "<!-- 2026-02-18 10:00:00 [abc12345] -->");
		assert.strictEqual(items[0].text, "Task with meta");
	});

	it("does not capture non-comment preceding lines as meta", () => {
		const content = "Some random text\n- [ ] Task without meta";
		const items = parseScratchpad(content);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].meta, "");
	});

	it("ignores non-checklist lines", () => {
		const content = "# Scratchpad\n\nSome preamble\n- [ ] Real item\n\nMore text";
		const items = parseScratchpad(content);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].text, "Real item");
	});

	it("handles empty content", () => {
		assert.deepStrictEqual(parseScratchpad(""), []);
	});

	it("handles content with only headers and whitespace", () => {
		assert.deepStrictEqual(parseScratchpad("# Scratchpad\n\n"), []);
	});

	it("handles items with special characters", () => {
		const items = parseScratchpad("- [ ] Fix `regex` in $PATH (urgent!)");
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].text, "Fix `regex` in $PATH (urgent!)");
	});

	it("requires space after checkbox bracket", () => {
		const items = parseScratchpad("- []No space\n- [ ] Has space");
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].text, "Has space");
	});

	it("parses realistic scratchpad with header and meta", () => {
		const content = `# Scratchpad

<!-- 2026-02-16 18:16:01 [12950572] -->
- [ ] Kill sniper module
<!-- 2026-02-17 17:27:00 [b54e290c] -->
- [x] Add integration tests
<!-- 2026-02-18 01:37:44 [3b717a40] -->
- [ ] Conditional delivery`;

		const items = parseScratchpad(content);
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items[0].done, false);
		assert.strictEqual(items[0].text, "Kill sniper module");
		assert.ok(items[0].meta.includes("12950572"));
		assert.strictEqual(items[1].done, true);
		assert.strictEqual(items[1].text, "Add integration tests");
		assert.strictEqual(items[2].done, false);
		assert.strictEqual(items[2].text, "Conditional delivery");
	});
});

describe("serializeScratchpad", () => {
	it("serializes empty list", () => {
		const result = serializeScratchpad([]);
		assert.strictEqual(result, "# Scratchpad\n\n");
	});

	it("serializes open items", () => {
		const items: ScratchpadItem[] = [
			{ done: false, text: "First", meta: "" },
			{ done: false, text: "Second", meta: "" },
		];
		const result = serializeScratchpad(items);
		assert.ok(result.includes("- [ ] First"));
		assert.ok(result.includes("- [ ] Second"));
	});

	it("serializes done items", () => {
		const items: ScratchpadItem[] = [{ done: true, text: "Completed", meta: "" }];
		const result = serializeScratchpad(items);
		assert.ok(result.includes("- [x] Completed"));
	});

	it("includes meta comments before items", () => {
		const items: ScratchpadItem[] = [
			{ done: false, text: "Task", meta: "<!-- 2026-02-18 [abc] -->" },
		];
		const result = serializeScratchpad(items);
		const lines = result.split("\n");
		const metaIdx = lines.findIndex(l => l.includes("<!-- 2026-02-18"));
		const taskIdx = lines.findIndex(l => l.includes("- [ ] Task"));
		assert.ok(metaIdx >= 0);
		assert.ok(taskIdx >= 0);
		assert.strictEqual(taskIdx, metaIdx + 1);
	});

	it("skips meta when empty string", () => {
		const items: ScratchpadItem[] = [{ done: false, text: "No meta", meta: "" }];
		const result = serializeScratchpad(items);
		assert.ok(!result.includes("<!--"));
	});

	it("starts with # Scratchpad header", () => {
		const result = serializeScratchpad([{ done: false, text: "X", meta: "" }]);
		assert.ok(result.startsWith("# Scratchpad\n"));
	});

	it("ends with newline", () => {
		const result = serializeScratchpad([{ done: false, text: "X", meta: "" }]);
		assert.ok(result.endsWith("\n"));
	});
});

describe("parseScratchpad + serializeScratchpad round-trip", () => {
	it("round-trips a simple list", () => {
		const items: ScratchpadItem[] = [
			{ done: false, text: "Open item", meta: "<!-- ts [sid] -->" },
			{ done: true, text: "Done item", meta: "<!-- ts2 [sid2] -->" },
		];
		const serialized = serializeScratchpad(items);
		const parsed = parseScratchpad(serialized);
		assert.strictEqual(parsed.length, 2);
		assert.strictEqual(parsed[0].done, false);
		assert.strictEqual(parsed[0].text, "Open item");
		assert.strictEqual(parsed[0].meta, "<!-- ts [sid] -->");
		assert.strictEqual(parsed[1].done, true);
		assert.strictEqual(parsed[1].text, "Done item");
	});

	it("round-trips items without meta", () => {
		const items: ScratchpadItem[] = [
			{ done: false, text: "No meta here", meta: "" },
		];
		const serialized = serializeScratchpad(items);
		const parsed = parseScratchpad(serialized);
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].text, "No meta here");
		assert.strictEqual(parsed[0].meta, "");
	});

	it("round-trips empty list", () => {
		const serialized = serializeScratchpad([]);
		const parsed = parseScratchpad(serialized);
		assert.strictEqual(parsed.length, 0);
	});

	it("round-trips complex content with special chars", () => {
		const items: ScratchpadItem[] = [
			{ done: false, text: "Fix `regex` in $PATH (urgent!) — ref #123", meta: "<!-- 2026-02-18 01:37:44 [3b717a40] -->" },
			{ done: true, text: "Deploy v2.0.1 to prod", meta: "<!-- 2026-02-17 09:00:00 [deadbeef] -->" },
			{ done: false, text: "Check if BTC < $90K", meta: "" },
		];
		const serialized = serializeScratchpad(items);
		const parsed = parseScratchpad(serialized);
		assert.strictEqual(parsed.length, 3);
		assert.strictEqual(parsed[0].text, items[0].text);
		assert.strictEqual(parsed[1].done, true);
		assert.strictEqual(parsed[2].meta, "");
	});
});

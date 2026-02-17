/**
 * Memory Extension
 *
 * Plain-Markdown memory system inspired by OpenClaw's approach.
 * No embeddings, no vector search — just files on disk injected into context.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *
 * Tools:
 *   memory_write  — write to MEMORY.md or daily log
 *   memory_read   — read any memory file or list daily logs
 *   scratchpad    — add/check/uncheck/clear items on the scratchpad checklist
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 *
 * Dashboard widget:
 *   - Auto-generated "Last 24h" summary from session metadata (titles, timestamps, costs)
 *   - Rebuilt every 15 minutes in the background
 *   - Shown on session_start and session_switch (so /new gets it too)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum, completeSimple, getModel } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const MEMORY_DIR = process.env.PI_MEMORY_DIR ?? path.join(process.env.HOME ?? "~", ".pi", "agent", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
const DAILY_DIR = process.env.PI_DAILY_DIR ?? path.join(MEMORY_DIR, "daily");
const NOTES_DIR = path.join(MEMORY_DIR, "notes");

// Extra files to inject into context alongside MEMORY.md/SCRATCHPAD.md/daily.
// Comma-separated list of filenames resolved relative to MEMORY_DIR.
// These should be small, always-needed identity/behavioral files.
// Example: PI_CONTEXT_FILES=SOUL.md,AGENTS.md,HEARTBEAT.md
const CONTEXT_FILES = (process.env.PI_CONTEXT_FILES ?? "")
	.split(",")
	.map(f => f.trim())
	.filter(Boolean);

// Auto-commit changes to git after every write. Off by default.
const AUTOCOMMIT = process.env.PI_AUTOCOMMIT === "1" || process.env.PI_AUTOCOMMIT === "true";

import { execFileSync } from "node:child_process";

function gitCommit(message: string) {
	if (!AUTOCOMMIT) return;
	try {
		execFileSync("git", ["add", "-A"], { cwd: MEMORY_DIR, stdio: "ignore", timeout: 5000 });
		execFileSync("git", ["commit", "-m", message, "--allow-empty-message", "--no-verify"], { cwd: MEMORY_DIR, stdio: "ignore", timeout: 5000 });
	} catch {
		// git not available or not a repo — silently skip
	}
}

function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function todayStr(): string {
	const d = new Date();
	return d.toISOString().slice(0, 10);
}

function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

function nowTimestamp(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function dailyPath(date: string): string {
	return path.join(DAILY_DIR, `${date}.md`);
}

// --- Scratchpad helpers ---

interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			// Look for a meta comment on the preceding line
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return lines.join("\n") + "\n";
}

function buildMemoryContext(): string {
	ensureDirs();
	const sections: string[] = [];

	// Configurable context files (SOUL.md, AGENTS.md, HEARTBEAT.md, etc.)
	for (const fileName of CONTEXT_FILES) {
		const filePath = path.join(MEMORY_DIR, fileName);
		const content = readFileSafe(filePath);
		if (content?.trim()) {
			sections.push(`## ${fileName}\n\n${content.trim()}`);
		}
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		sections.push(`## MEMORY.md (long-term)\n\n${longTerm.trim()}`);
	}

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			sections.push(`## SCRATCHPAD.md (working context)\n\n${serializeScratchpad(openItems)}`);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		sections.push(`## Daily log: ${today} (today)\n\n${todayContent.trim()}`);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		sections.push(`## Daily log: ${yesterday} (yesterday)\n\n${yesterdayContent.trim()}`);
	}

	if (sections.length === 0) {
		return "";
	}

	return `# Memory\n\n${sections.join("\n\n---\n\n")}`;
}

// --- Session scanner for "Last 24h" dashboard ---

const SESSIONS_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
const SUMMARY_CACHE = path.join(DAILY_DIR, "cache.json");
const REBUILD_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionInfo {
	file: string;
	timestamp: string;
	title: string;
	isChild: boolean;
	parentSession?: string;
	cwd: string;
	cost: number;
}

/** Read first line + scan for session_info and cost from a jsonl file */
async function scanSession(filePath: string): Promise<SessionInfo | null> {
	try {
		const cutoffTime = Date.now() - LOOKBACK_MS;
		const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
		let lineNum = 0;
		let header: any = null;
		let title = "";
		let totalCost = 0;

		for await (const line of rl) {
			lineNum++;
			if (lineNum === 1) {
				try {
					header = JSON.parse(line);
				} catch { return null; }
				// Skip sessions whose timestamp is older than the lookback window
				if (header.timestamp && new Date(header.timestamp).getTime() < cutoffTime) {
					rl.close();
					return null;
				}
				continue;
			}
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info" && entry.name) {
					title = entry.name;
				}
				if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage?.cost?.total) {
					totalCost += entry.message.usage.cost.total;
				}
			} catch { continue; }
		}

		if (!header?.timestamp) return null;

		// Fall back to first user message text if no title
		if (!title) {
			const rl2 = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
			for await (const line of rl2) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message?.role === "user") {
						const content = entry.message.content;
						if (typeof content === "string") {
							title = content.slice(0, 80);
						} else if (Array.isArray(content)) {
							const textPart = content.find((c: any) => c.type === "text");
							if (textPart) title = textPart.text.slice(0, 80);
						}
						break;
					}
				} catch { continue; }
			}
		}

		return {
			file: filePath,
			timestamp: header.timestamp,
			title: title || "(untitled)",
			isChild: !!header.parentSession,
			parentSession: header.parentSession || undefined,
			cwd: header.cwd || "",
			cost: totalCost,
		};
	} catch { return null; }
}

// Store model registry ref so buildSessionSummary can call LLM
let modelRegistryRef: any = null;

async function collectSessions(): Promise<{ roots: SessionInfo[]; childCountMap: Map<string, number>; totalCost: number }> {
	const cutoff = new Date(Date.now() - LOOKBACK_MS);
	const sessionDirs: string[] = [];

	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.startsWith("--Users-") && !dir.includes("-T-pi-")) {
				sessionDirs.push(path.join(SESSIONS_DIR, dir));
			}
		}
	} catch { return { roots: [], childCountMap: new Map(), totalCost: 0 }; }

	const recentFiles: string[] = [];
	for (const dir of sessionDirs) {
		try {
			for (const file of fs.readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = path.join(dir, file);
				try {
					if (fs.statSync(filePath).mtime >= cutoff) recentFiles.push(filePath);
				} catch { continue; }
			}
		} catch { continue; }
	}

	if (recentFiles.length === 0) return { roots: [], childCountMap: new Map(), totalCost: 0 };

	const results = await Promise.all(recentFiles.map(scanSession));
	const sessions = results.filter((s): s is SessionInfo => s !== null);

	const roots = sessions.filter(s => !s.isChild);
	const children = sessions.filter(s => s.isChild);

	const childCountMap = new Map<string, number>();
	for (const child of children) {
		if (child.parentSession) {
			childCountMap.set(child.parentSession, (childCountMap.get(child.parentSession) || 0) + 1);
		}
	}

	const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
	return { roots, childCountMap, totalCost };
}

function isHousekeeping(title: string): boolean {
	const lower = title.toLowerCase();
	const patterns = [
		/^(clear|review|read)\s+(done|scratchpad|today|daily)/,
		/^-\s+(no done|scratchpad|cleared|reviewed|task is)/,
		/^scratchpad\s+(content|management|maintenance|reviewed|items)/,
		/^\(untitled\)$/,
		/^\/\w+$/, // bare slash commands like /reload
		/^write daily log/,
	];
	return patterns.some(p => p.test(lower));
}

/** Ask LLM to produce a concise grouped narrative summary */
async function summarizeWithLLM(sessions: SessionInfo[], childCountMap: Map<string, number>, totalCost: number): Promise<string> {
	if (!modelRegistryRef) return "";

	const candidates = [
		getModel("openai", "gpt-4.1-mini"),
		getModel("openai", "gpt-4o-mini"),
		modelRegistryRef.find("jo-proxy", "jo-gpt-4.1-mini"),
	];

	let model: any = null;
	let apiKey: string | undefined;
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = await modelRegistryRef.getApiKey(candidate);
		if (key) { model = candidate; apiKey = key; break; }
	}
	if (!model || !apiKey) return "";

	// Build rich listing with metadata
	const listing = sessions.map((s, i) => {
		const childCount = childCountMap.get(s.file) || 0;
		const parts = [`${s.title}`];
		if (childCount > 0) parts.push(`[${childCount} sub-agents]`);
		if (s.cost > 0.05) parts.push(`[$${s.cost.toFixed(2)}]`);
		return parts.join(" ");
	}).join("\n");

	const response = await completeSimple(model, {
		systemPrompt: [
			"You are summarizing a developer's last 24 hours of coding sessions for a dashboard.",
			"Write a concise grouped summary in markdown. Rules:",
			"",
			"- Group by TOPIC (not time). 3-7 groups. Short bold header per group (2-4 words).",
			"- Under each header, write 1-3 bullet points summarizing WHAT WAS ACCOMPLISHED.",
			"  Synthesize multiple related sessions into a single clear statement.",
			"  e.g. 10 sessions about 'Run eval suite X' → '**Eval suite runs**: ran all 10 suites in sprite mode across weather, routing, memory, calendar, email, browser, and security'",
			"- Be specific about outcomes: fixes applied, features built, bugs found, tools created.",
			"- Collapse repetitive runs (eval runs, debugging attempts) into one line with the count.",
			"- Mention sub-agent counts where relevant — it shows parallel work.",
			"- Keep total output under 25 lines. Dense and useful, not a laundry list.",
			"- Order: oldest topic first, most recent topic last.",
			"- Do NOT include a header line — the caller adds that.",
			"- Do NOT repeat session titles verbatim. Summarize.",
		].join("\n"),
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: `${sessions.length} sessions, $${totalCost.toFixed(2)} total cost:\n\n${listing}` }],
			timestamp: Date.now(),
		}],
	}, { apiKey });

	return response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();
}

async function buildSessionSummary(): Promise<string> {
	const { roots, childCountMap, totalCost } = await collectSessions();
	if (roots.length === 0) return "";

	// Sort oldest first, filter housekeeping
	const sorted = [...roots]
		.filter(s => !isHousekeeping(s.title))
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	if (sorted.length === 0) return "";

	const header = `## Last 24h — ${sorted.length} sessions, $${totalCost.toFixed(2)}`;

	try {
		const summary = await summarizeWithLLM(sorted, childCountMap, totalCost);
		if (summary) return `${header}\n\n${summary}`;
	} catch {}

	// Fallback: flat list
	const lines = [header, ""];
	for (const s of sorted) {
		const childCount = childCountMap.get(s.file) || 0;
		const childTag = childCount > 0 ? ` (+${childCount} sub-agents)` : "";
		lines.push(`- ${s.title}${childTag}`);
	}
	return lines.join("\n");
}

// Cached summary + rebuild timer
let cachedSummary = "";
let lastRebuildTime = 0;

async function getOrRebuildSummary(): Promise<string> {
	const now = Date.now();
	if (now - lastRebuildTime < REBUILD_INTERVAL_MS && cachedSummary) {
		return cachedSummary;
	}

	// Try loading from disk cache first
	if (!cachedSummary) {
		try {
			const cache = JSON.parse(fs.readFileSync(SUMMARY_CACHE, "utf-8"));
			if (cache.summary && now - cache.timestamp < REBUILD_INTERVAL_MS) {
				cachedSummary = cache.summary;
				lastRebuildTime = cache.timestamp;
				return cachedSummary;
			}
		} catch {}
	}

	cachedSummary = await buildSessionSummary();
	lastRebuildTime = now;

	// Persist to disk so other pi instances see it
	try {
		ensureDirs();
		fs.writeFileSync(SUMMARY_CACHE, JSON.stringify({ summary: cachedSummary, timestamp: now }), "utf-8");
	} catch {}

	return cachedSummary;
}

export default function (pi: ExtensionAPI) {
	let rebuildTimer: ReturnType<typeof setInterval> | null = null;

	async function showDashboard(ctx: any) {
		if (!ctx.hasUI) return;

		const summary = await getOrRebuildSummary();
		const scratchContent = readFileSafe(SCRATCHPAD_FILE);

		const sections: string[] = [];

		if (summary) {
			sections.push(summary);
		}

		if (scratchContent?.trim()) {
			const items = scratchContent
				.trim()
				.split("\n")
				.filter((l: string) => l.match(/^- \[ \]/))
				.filter((l: string) => !l.match(/^<!--.*-->$/))
				.map((l: string) => l.replace(/^- /, ""));
			if (items.length > 0) {
				sections.push(`## Scratchpad\n\n${items.join("\n")}`);
			}
		}

		if (sections.length === 0) return;

		const md = sections.join("\n\n---\n\n");

		ctx.ui.setWidget("memory-dashboard", (_tui: any, _theme: any) => {
			const mdTheme = getMarkdownTheme();
			const markdown = new Markdown(md, 1, 0, mdTheme);
			return markdown;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
		await showDashboard(ctx);

		// Start background rebuild timer
		if (!rebuildTimer) {
			rebuildTimer = setInterval(async () => {
				cachedSummary = await buildSessionSummary();
				lastRebuildTime = Date.now();
				try {
					ensureDirs();
					fs.writeFileSync(SUMMARY_CACHE, JSON.stringify({ summary: cachedSummary, timestamp: lastRebuildTime }), "utf-8");
				} catch {}
			}, REBUILD_INTERVAL_MS);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
		await showDashboard(ctx);
	});

	// Clear widget once agent starts working
	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setWidget("memory-dashboard", undefined);
	});

	pi.on("session_shutdown", async () => {
		if (rebuildTimer) { clearInterval(rebuildTimer); rebuildTimer = null; }
	});

	// Inject memory context before every agent turn
	pi.on("before_agent_start", async (event, _ctx) => {
		const memoryContext = buildMemoryContext();
		if (!memoryContext) return;

		const memoryInstructions = [
			"\n\n## Memory",
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts \u2192 MEMORY.md",
			"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind \u2192 scratchpad tool",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + memoryInstructions,
		};
	});

	// Pre-compaction memory flush
	pi.on("session_before_compact", async (_event, ctx) => {
		const memoryContext = buildMemoryContext();
		const hasMemory = memoryContext.length > 0;

		if (hasMemory) {
			ctx.ui.notify("Memory files available \u2014 consider persisting important context before compaction", "info");
		}
	});

	// memory_write tool
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Three targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"- 'note': Create or update a file in notes/ (e.g. lessons.md, self-review.md). Pass filename. Mode: 'append' or 'overwrite'.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily", "note"] as const, {
				description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log, 'note' for notes/<filename>",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode. Default: 'append'. Daily always appends.",
				}),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'note' target (e.g. 'lessons.md')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { target, content, mode } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(NOTES_DIR, safe);
				const existing = readFileSafe(filePath) ?? "";

				if (mode === "overwrite") {
					const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
					fs.writeFileSync(filePath, stamped, "utf-8");
					gitCommit(`note: ${safe}`);
					return {
						content: [{ type: "text", text: `Wrote notes/${safe}` }],
						details: { path: filePath, target, mode: "overwrite", sessionId: sid, timestamp: ts },
					};
				}

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				gitCommit(`note: ${safe}`);
				return {
					content: [{ type: "text", text: `Appended to notes/${safe}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";

				const existingSnippet = existing.trim()
					? `\n\nExisting daily log content:\n${existing.trim()}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				gitCommit(`daily: ${todayStr()}`);
				return {
					content: [{ type: "text", text: `Appended to daily log: ${filePath}${existingSnippet}` }],
					details: { path: filePath, target, mode: "append", sessionId: sid, timestamp: ts },
				};
			}

			// long_term
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			const existingSnippet = existing.trim()
				? `\n\nExisting MEMORY.md content:\n${existing.trim()}`
				: "\n\nMEMORY.md was empty.";

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(MEMORY_FILE, stamped, "utf-8");
				gitCommit("memory: overwrite");
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: { path: MEMORY_FILE, target, mode: "overwrite", sessionId: sid, timestamp: ts },
				};
			}

			// append (default)
			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
			gitCommit("memory: append");
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: { path: MEMORY_FILE, target, mode: "append", sessionId: sid, timestamp: ts },
			};
		},
	});

	// scratchpad tool
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({ description: "Item text for add, or substring to match for done/undo" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			let items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return { content: [{ type: "text", text: "Scratchpad is empty." }], details: {} };
				}
				return {
					content: [{ type: "text", text: serializeScratchpad(items) }],
					details: { count: items.length, open: items.filter((i) => !i.done).length },
				};
			}

			if (action === "add") {
				if (!text) {
					return { content: [{ type: "text", text: "Error: 'text' is required for add." }], details: {} };
				}
				items.push({ done: false, text, meta: `<!-- ${ts} [${sid}] -->` });
				fs.writeFileSync(SCRATCHPAD_FILE, serializeScratchpad(items), "utf-8");
				gitCommit(`scratchpad: add`);
				return {
					content: [{ type: "text", text: `Added: - [ ] ${text}\n\n${serializeScratchpad(items)}` }],
					details: { action, sessionId: sid, timestamp: ts },
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return { content: [{ type: "text", text: `Error: 'text' is required for ${action}.` }], details: {} };
				}
				const needle = text.toLowerCase();
				const targetDone = action === "done";
				let matched = false;
				for (const item of items) {
					if (item.done !== targetDone && item.text.toLowerCase().includes(needle)) {
						item.done = targetDone;
						matched = true;
						break;
					}
				}
				if (!matched) {
					return {
						content: [{ type: "text", text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"` }],
						details: {},
					};
				}
				fs.writeFileSync(SCRATCHPAD_FILE, serializeScratchpad(items), "utf-8");
				gitCommit(`scratchpad: ${action}`);
				return {
					content: [{ type: "text", text: `Updated.\n\n${serializeScratchpad(items)}` }],
					details: { action, sessionId: sid, timestamp: ts },
				};
			}

			if (action === "clear_done") {
				const before = items.length;
				items = items.filter((i) => !i.done);
				const removed = before - items.length;
				fs.writeFileSync(SCRATCHPAD_FILE, serializeScratchpad(items), "utf-8");
				gitCommit("scratchpad: clear_done");
				return {
					content: [{ type: "text", text: `Cleared ${removed} done item(s).\n\n${serializeScratchpad(items)}` }],
					details: { action, removed },
				};
			}

			return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {} };
		},
	});

	// memory_read tool
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'file': Read any file by name (e.g. 'SOUL.md'). Pass filename.",
			"- 'note': Read a file from notes/ (e.g. 'lessons.md'). Pass filename.",
			"- 'list': List all files in the memory directory.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "file", "note", "list"] as const, {
				description: "What to read",
			}),
			date: Type.Optional(
				Type.String({ description: "Date for daily log (YYYY-MM-DD). Default: today." }),
			),
			filename: Type.Optional(
				Type.String({ description: "Filename for 'file' target (e.g. 'lessons.md', 'SOUL.md')" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const { target, date, filename } = params;

			if (target === "list") {
				const sections: string[] = [];
				try {
					const rootFiles = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") || f.endsWith(".json")).sort();
					if (rootFiles.length > 0) sections.push(`Files:\n${rootFiles.map(f => `- ${f}`).join("\n")}`);
				} catch {}
				try {
					const noteFiles = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(".md")).sort();
					if (noteFiles.length > 0) sections.push(`Notes:\n${noteFiles.map(f => `- notes/${f}`).join("\n")}`);
				} catch {}
				try {
					const dailyFiles = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith(".md")).sort().reverse();
					if (dailyFiles.length > 0) sections.push(`Daily logs (${dailyFiles.length}):\n${dailyFiles.slice(0, 10).map(f => `- daily/${f}`).join("\n")}${dailyFiles.length > 10 ? `\n  ... and ${dailyFiles.length - 10} more` : ""}`);
				} catch {}
				if (sections.length === 0) {
					return { content: [{ type: "text", text: "Memory directory is empty." }], details: {} };
				}
				return { content: [{ type: "text", text: sections.join("\n\n") }], details: {} };
			}

			if (target === "file") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'file'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(MEMORY_DIR, safe);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `File not found: ${safe}` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, filename: safe } };
			}

			if (target === "note") {
				if (!filename) {
					return { content: [{ type: "text", text: "Error: 'filename' is required for target 'note'." }], details: {} };
				}
				const safe = path.basename(filename);
				const filePath = path.join(NOTES_DIR, safe);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `Note not found: notes/${safe}` }], details: {} };
				}
				return { content: [{ type: "text", text: content }], details: { path: filePath, filename: `notes/${safe}` } };
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return { content: [{ type: "text", text: `No daily log for ${d}.` }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) {
					return { content: [{ type: "text", text: "SCRATCHPAD.md is empty or does not exist." }], details: {} };
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: SCRATCHPAD_FILE },
				};
			}

			// long_term
			const content = readFileSafe(MEMORY_FILE);
			if (!content) {
				return { content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }], details: {} };
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: MEMORY_FILE },
			};
		},
	});

	// memory_search tool
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs, notes/, and any other .md files).",
			"Matches filenames and file contents. Case-insensitive keyword search.",
			"Returns matching files and lines with paths.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String({ description: "Search query (case-insensitive substring match)" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 20)", default: 20 }),
			),
		}),
		async execute(_toolCallId, params) {
			ensureDirs();
			const { query, max_results } = params;
			const limit = max_results ?? 20;
			const needle = query.toLowerCase();

			const fileMatches: string[] = [];
			const lineResults: { file: string; line: number; text: string }[] = [];

			function searchFile(filePath: string, displayName: string) {
				// Check filename match
				if (displayName.toLowerCase().includes(needle) && !fileMatches.includes(displayName)) {
					fileMatches.push(displayName);
				}
				// Check content
				const content = readFileSafe(filePath);
				if (!content) return;
				const lines = content.split("\n");
				for (let i = 0; i < lines.length && lineResults.length < limit; i++) {
					if (lines[i].toLowerCase().includes(needle)) {
						lineResults.push({ file: displayName, line: i + 1, text: lines[i].trimEnd() });
					}
				}
			}

			function searchDir(dir: string, prefix: string) {
				try {
					const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort();
					for (const f of files) {
						if (lineResults.length >= limit) break;
						searchFile(path.join(dir, f), prefix ? `${prefix}/${f}` : f);
					}
				} catch {}
			}

			// Search root, daily/, notes/
			searchDir(MEMORY_DIR, "");
			searchDir(DAILY_DIR, "daily");
			searchDir(NOTES_DIR, "notes");

			if (fileMatches.length === 0 && lineResults.length === 0) {
				return { content: [{ type: "text", text: `No results for "${query}".` }], details: {} };
			}

			const parts: string[] = [];
			if (fileMatches.length > 0) {
				parts.push(`Files matching "${query}":\n${fileMatches.map(f => `- ${f}`).join("\n")}`);
			}
			if (lineResults.length > 0) {
				parts.push(`Content matches:\n${lineResults.map(r => `${r.file}:${r.line}: ${r.text}`).join("\n")}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { query, fileMatches: fileMatches.length, lineMatches: lineResults.length },
			};
		},
	});
}

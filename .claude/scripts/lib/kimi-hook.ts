/**
 * Kimi Code's observation hooks discard stdout. Only UserPromptSubmit
 * consumes nonblocking feedback, so startup context is computed there and
 * write/checklist feedback is delivered on the next user prompt.
 *
 * Protocol: MoonshotAI/kimi-code, externalHooks/internal/userPrompt.ts and
 * externalHooks/agent/agentExternalHooksService.ts (checked 2026-09-30).
 * We intentionally never block Stop and never invent a transcript path.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
	renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type RecordValue = Record<string, unknown>;
export type SharedHook = "session-start.ts" | "classify-message.ts" | "validate-write.ts" | "stop-checklist.ts";
export type HookRunner = (script: SharedHook, payload: RecordValue, vaultRoot: string, timeoutMs?: number) => string;
export const KIMI_PROMPT_BUDGET_MS = 45_000;
export const KIMI_MAX_PENDING_WRITES = 4;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve symlinks and reject both prefix siblings and nested Git repos. */
export function isKimiVaultCwd(cwd: unknown, vaultRoot: string): boolean {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
	try {
		const root = realpathSync(vaultRoot);
		let current = realpathSync(cwd);
		const rel = relative(root, current);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
		while (current !== root) {
			if (existsSync(join(current, ".git"))) return false;
			current = dirname(current);
		}
		return true;
	} catch {
		return false;
	}
}

/** Current Kimi sends ContentPart[]; older versions may send a string. */
export function kimiPromptText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	if (!Array.isArray(prompt)) return "";
	return prompt.filter(isRecord)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string).join("\n");
}

/** Unwrap the shared Claude-style result before handing text to Kimi. */
export function sharedHookText(output: string): string {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!isRecord(parsed)) return "";
		const hook = parsed.hookSpecificOutput;
		if (isRecord(hook) && typeof hook.additionalContext === "string") {
			return hook.additionalContext.trim();
		}
		return typeof parsed.systemMessage === "string" ? parsed.systemMessage.trim() : "";
	} catch {
		return "";
	}
}

export const runSharedKimiHook: HookRunner = (script, payload, vaultRoot, timeoutMs = 8_000) => {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: vaultRoot };
	// Never let a Kimi hook append to another harness's environment file.
	delete env["CLAUDE_ENV_FILE"];
	env["CLASSIFY_HINT_STATE"] = join(vaultRoot, ".kimi-code", ".mind-hook-state", "hints.json");
	const result = spawnSync(process.execPath, [
		"--disable-warning=ExperimentalWarning", "--experimental-strip-types",
		join(vaultRoot, ".claude", "scripts", script),
	], {
		cwd: vaultRoot, env, input: JSON.stringify(payload), encoding: "utf-8",
		timeout: timeoutMs,
		maxBuffer: 2 * 1024 * 1024, windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`Kimi shared hook failed or timed out: ${script}`);
	return result.stdout;
};

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function readText(path: string): string {
	try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function removeIfUnchanged(path: string, expected: string): void {
	if (readText(path) === expected) rmSync(path, { force: true });
}

function save(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function vaultFile(path: unknown, cwd: string, root: string): string | null {
	if (typeof path !== "string" || !path) return null;
	try {
		const canonical = realpathSync(resolve(cwd, path));
		return isKimiVaultCwd(dirname(canonical), root) ? canonical : null;
	} catch { return null; }
}

/** Global hooks must not write through a linked cache into another project. */
function safeCache(root: string, state: string): boolean {
	const cache = join(root, ".kimi-code", ".mind-hook-state");
	try {
		for (const directory of [join(root, ".kimi-code"), cache, state, join(state, "writes")]) {
			try {
				const info = lstatSync(directory);
				if (info.isSymbolicLink() || !info.isDirectory()) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
		}
		const files = [join(cache, "hints.json")];
		for (const directory of [state, join(state, "writes")]) {
			try { files.push(...readdirSync(directory).map((name) => join(directory, name))); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
		}
		for (const file of files) {
			try { if (lstatSync(file).isSymbolicLink()) return false; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
		}
		return true;
	} catch { return false; }
}

/** Returns plain text only for UserPromptSubmit; all other events are silent. */
export function handleKimiHook(
	payload: unknown,
	vaultRoot: string,
	run: HookRunner = runSharedKimiHook,
	now: () => number = Date.now,
): string {
	if (!isRecord(payload) || !isKimiVaultCwd(payload.cwd, vaultRoot)) return "";
	const session = payload.session_id;
	if (typeof session !== "string" || !session || session.length > 1024) return "";
	const root = realpathSync(vaultRoot);
	const cwd = realpathSync(payload.cwd as string);
	const state = join(root, ".kimi-code", ".mind-hook-state", digest(session));
	if (!safeCache(root, state)) return "";
	const sourceFile = join(state, "source.txt");
	const delivered = join(state, "context-delivered");
	const stopFile = join(state, "stop.txt");
	const warnings = join(state, "writes");
	const normalized = { ...payload, cwd: root };

	switch (payload.hook_event_name) {
		case "SessionStart":
			// Lightweight marker only. The first prompt must not race a slow
			// startup subprocess, nor depend on this event having been received.
			save(sourceFile, payload.source === "resume" ? "resume" : "startup");
			rmSync(delivered, { force: true });
			return "";
		case "PostToolUse": {
			if (payload.tool_name !== "Write" && payload.tool_name !== "Edit") return "";
			if (!isRecord(payload.tool_input)) return "";
			const file = vaultFile(payload.tool_input.path, cwd, root);
			if (file === null) return "";
			const pending = join(warnings, `${digest(file)}.json`);
			// Queue before invoking validation: even its first attempt can
			// time out. A generation also protects a newer concurrent write
			// from being acknowledged by an older validation result.
			const record = JSON.stringify({ path: file, generation: randomUUID() });
			save(pending, record);
			try {
				const feedback = sharedHookText(run("validate-write.ts", {
					...normalized, tool_input: { ...payload.tool_input, file_path: file },
				}, root));
				if (!feedback) removeIfUnchanged(pending, record);
			} catch { /* keep this path for the next prompt */ }
			return "";
		}
		case "Stop": {
			if (payload.stop_hook_active === true) return "";
			const checklist = sharedHookText(run("stop-checklist.ts", normalized, root));
			if (checklist) save(stopFile, checklist);
			return "";
		}
		case "SessionEnd":
			rmSync(state, { recursive: true, force: true });
			return "";
		case "UserPromptSubmit": {
			mkdirSync(state, { recursive: true, mode: 0o700 });
			const blocks: string[] = [];
			const acknowledge: (() => void)[] = [];
			const deadline = now() + KIMI_PROMPT_BUDGET_MS;
			const budgeted: HookRunner = (script, body, directory, limit = 5_000) => {
				const remaining = deadline - now() - 500;
				if (remaining <= 0) throw new Error("Kimi prompt hook budget exhausted");
				return run(script, body, directory, Math.min(limit, remaining));
			};
			if (!existsSync(delivered)) {
				try {
					const context = budgeted("session-start.ts", {
						...normalized, source: readText(sourceFile) || "startup",
					}, root, 35_000).trim();
					if (context) {
						blocks.push(context);
						acknowledge.push(() => save(delivered, "1"));
					}
				} catch { /* retry startup on the next prompt */ }
			}
			// Give the current message priority over earlier queued findings.
			try {
				const hints = sharedHookText(budgeted("classify-message.ts", {
					...normalized, prompt: kimiPromptText(payload.prompt),
				}, root, 3_000));
				if (hints) blocks.push(hints);
			} catch { /* optional routing must not lose other context */ }
			// Revalidate queued paths: a later edit may already have fixed a
			// finding, and cached prose would otherwise report a stale problem.
			let entries: string[] = [];
			try { entries = readdirSync(warnings); } catch { /* no pending writes */ }
			for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, KIMI_MAX_PENDING_WRITES)) {
				const pending = join(warnings, entry);
				const raw = readText(pending);
				let file: string | null = null;
				try {
					const record: unknown = JSON.parse(raw);
					if (isRecord(record)) file = vaultFile(record.path, root, root);
				} catch { /* corrupt cache is optional context */ }
				if (file === null) {
					acknowledge.push(() => removeIfUnchanged(pending, raw));
					continue;
				}
				try {
					const feedback = sharedHookText(budgeted("validate-write.ts", {
						...normalized, hook_event_name: "PostToolUse", tool_input: { file_path: file },
					}, root));
					if (feedback) blocks.push(feedback);
					acknowledge.push(() => removeIfUnchanged(pending, raw));
				} catch { /* keep failed/deferred paths for the next prompt */ }
			}
			const checklist = readText(stopFile);
			if (checklist) {
				blocks.push("Reminder from the previous turn:\n" + checklist);
				acknowledge.push(() => rmSync(stopFile, { force: true }));
			}
			// Computation is capped below the installed 60s hook timeout. Do
			// not mark startup or queued feedback delivered before that work.
			for (const commit of acknowledge) {
				try { commit(); } catch { /* duplicate feedback beats dropped output */ }
			}
			return blocks.join("\n\n");
		}
		default:
			// In particular, PreCompact carries no transcript_path. Arbitrary
			// event names must never become script filenames or shell commands.
			return "";
	}
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { after, before, describe, test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	handleKimiHook, isKimiVaultCwd, kimiPromptText, sharedHookText, runSharedKimiHook,
	KIMI_MAX_PENDING_WRITES, KIMI_PROMPT_BUDGET_MS,
	type HookRunner, type SharedHook,
} from "../lib/kimi-hook.ts";
import { runScript, rmTemp } from "./_helpers.ts";

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let temporary = "";
let root = "";
let sibling = "";
let nested = "";
let external = "";

before(() => {
	temporary = realpathSync(mkdtempSync(join(tmpdir(), "kimi-hook-")));
	root = join(temporary, "vault");
	sibling = join(temporary, "vault-sibling");
	nested = join(root, "other-repo");
	external = join(temporary, "elsewhere");
	for (const folder of [root, sibling, nested, external, join(root, "brain")]) mkdirSync(folder, { recursive: true });
	mkdirSync(join(root, ".git"));
	// Worktrees have a .git FILE, which is a repository boundary too.
	writeFileSync(join(nested, ".git"), "gitdir: /elsewhere/git");
	writeFileSync(join(root, "brain", "Note.md"), "# note");
});
after(() => rmTemp(temporary));

function input(event: string, session: string, extra: Record<string, unknown> = {}) {
	return { hook_event_name: event, session_id: session, cwd: root, ...extra };
}

function stateDirectory(session: string, vault = root): string {
	return join(vault, ".kimi-code", ".mind-hook-state", createHash("sha256").update(session).digest("hex"));
}

/** Schedule a real writer process exactly at the acknowledgement boundary. */
function replaceDuringAcknowledgement(path: string, value: string, act: () => void): void {
	let replaced = false;
	const replaceFromAnotherProcess = () => {
		if (replaced) return;
		replaced = true;
		const writer = spawnSync(process.execPath, ["-e", `
const fs = require("node:fs");
const path = process.argv[1];
fs.writeFileSync(path + ".concurrent", process.argv[2]);
fs.renameSync(path + ".concurrent", path);
`, path, value], { encoding: "utf8", timeout: 5_000 });
		assert.equal(writer.status, 0, writer.stderr);
	};
	const originalRemove = fs.rmSync;
	const originalRename = fs.renameSync;
	try {
		fs.rmSync = ((target, options) => {
			if (String(target) === path) replaceFromAnotherProcess();
			return originalRemove(target, options);
		}) as typeof fs.rmSync;
		fs.renameSync = ((from, to) => {
			if (String(to) === path + ".ack") replaceFromAnotherProcess();
			return originalRename(from, to);
		}) as typeof fs.renameSync;
		syncBuiltinESMExports();
		act();
	} finally {
		fs.rmSync = originalRemove;
		fs.renameSync = originalRename;
		syncBuiltinESMExports();
	}
	assert.equal(replaced, true, "the concurrent writer must have run");
}

function stub() {
	const calls: { script: SharedHook; payload: Record<string, unknown>; root: string }[] = [];
	let warning = "Missing wikilinks";
	const run: HookRunner = (script, payload, vaultRoot) => {
		calls.push({ script, payload, root: vaultRoot });
		if (script === "session-start.ts") return "### North Star\nA goal";
		if (script === "stop-checklist.ts") return JSON.stringify({ systemMessage: "Session end checklist" });
		if (script === "validate-write.ts") return warning ? JSON.stringify({ hookSpecificOutput: { additionalContext: warning } }) : "";
		return payload.prompt ? JSON.stringify({ hookSpecificOutput: { additionalContext: "Routing hints" } }) : "";
	};
	return { calls, run, clearWarning: () => { warning = ""; } };
}

describe("Kimi vault scope", () => {
	test("accepts vault root and note subdirectories", () => {
		assert.equal(isKimiVaultCwd(root, root), true);
		assert.equal(isKimiVaultCwd(join(root, "brain"), root), true);
	});
	test("rejects siblings, outside projects, nested Git repos, and invalid cwd", () => {
		for (const cwd of [sibling, external, nested, "brain", undefined, 4]) {
			assert.equal(isKimiVaultCwd(cwd, root), false, String(cwd));
			const fake = stub();
			assert.equal(handleKimiHook(input("UserPromptSubmit", "outside", { cwd, prompt: "decision" }), root, fake.run), "");
			assert.equal(fake.calls.length, 0);
		}
	});
	test("resolves symlinks before accepting a cwd or a written file", (t) => {
		const link = join(root, "escape");
		try { symlinkSync(external, link, "junction"); }
		catch { t.skip("symlink creation unavailable on this platform"); return; }
		assert.equal(isKimiVaultCwd(link, root), false);
		writeFileSync(join(external, "Outside.md"), "outside");
		const fake = stub();
		handleKimiHook(input("PostToolUse", "symlink", { tool_name: "Write", tool_input: { path: join(link, "Outside.md") } }), root, fake.run);
		assert.equal(fake.calls.length, 0);
	});
	test("refuses a symlinked state directory instead of writing outside the vault", (t) => {
		const isolated = join(temporary, "linked-cache-vault");
		mkdirSync(join(isolated, ".kimi-code"), { recursive: true });
		try { symlinkSync(external, join(isolated, ".kimi-code", ".mind-hook-state"), "junction"); }
		catch { t.skip("symlink creation unavailable on this platform"); return; }
		const fake = stub();
		assert.equal(handleKimiHook(input("UserPromptSubmit", "linked", { cwd: isolated, prompt: "hello" }), isolated, fake.run), "");
		assert.equal(fake.calls.length, 0);
	});
	test("refuses non-regular cache entries before invoking any shared hook", () => {
		const session = "invalid-state";
		mkdirSync(join(stateDirectory(session), "source.txt"), { recursive: true });
		const fake = stub();
		assert.equal(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), "");
		assert.equal(fake.calls.length, 0);
	});
	test("a hardlinked hint cache cannot overwrite an external file through the real classifier", (t) => {
		const isolated = join(temporary, "hardlinked-cache-vault");
		const cache = join(isolated, ".kimi-code", ".mind-hook-state");
		const directory = join(isolated, ".claude", "scripts");
		mkdirSync(cache, { recursive: true });
		mkdirSync(join(directory, "lib"), { recursive: true });
		for (const file of ["classify-message.ts", "lib/hook-io.ts", "lib/matcher.ts", "lib/hint-state.ts", "lib/regex.ts", "lib/signals.ts"]) {
			copyFileSync(join(scripts, file), join(directory, file));
		}
		writeFileSync(join(directory, "package.json"), '{"type":"module"}');
		const sentinel = join(external, "hardlink-sentinel.json");
		writeFileSync(sentinel, "external data must stay unchanged");
		try { fs.linkSync(sentinel, join(cache, "hints.json")); }
		catch { t.skip("hardlink creation unavailable on this platform"); return; }
		const output = handleKimiHook(input("UserPromptSubmit", "hardlinked-hints", { cwd: isolated, prompt: "decision" }), isolated);
		assert.equal(readFileSync(sentinel, "utf8"), "external data must stay unchanged");
		assert.equal(output, "");
	});
});

describe("Kimi output protocol and lifecycle", () => {
	test("extracts text content parts without treating images as prompt strings", () => {
		assert.equal(kimiPromptText([{ type: "text", text: "one" }, { type: "image", text: "ignore" }, { type: "text", text: "two" }]), "one\ntwo");
		assert.equal(kimiPromptText("old version"), "old version");
		assert.equal(kimiPromptText({ text: "invalid" }), "");
	});
	test("unwraps shared envelopes instead of forwarding ignored Claude JSON", () => {
		assert.equal(sharedHookText('{"hookSpecificOutput":{"additionalContext":"hint"}}'), "hint");
		assert.equal(sharedHookText('{"systemMessage":"checklist"}'), "checklist");
		assert.equal(sharedHookText("{}"), "");
		assert.equal(sharedHookText("invalid output"), "");
	});
	test("startup is deferred until the first prompt, only once per session", () => {
		const fake = stub();
		assert.equal(handleKimiHook(input("SessionStart", "start", { source: "startup" }), root, fake.run), "");
		assert.equal(fake.calls.length, 0);
		const first = handleKimiHook(input("UserPromptSubmit", "start", { prompt: [{ type: "text", text: "decision" }] }), root, fake.run);
		assert.match(first, /North Star/);
		assert.match(first, /Routing hints/);
		assert.doesNotMatch(first, /hookSpecificOutput/);
		assert.equal(fake.calls.find((call) => call.script === "classify-message.ts")?.payload.prompt, "decision");
		const second = handleKimiHook(input("UserPromptSubmit", "start", { prompt: "next" }), root, fake.run);
		assert.doesNotMatch(second, /North Star/);
		assert.equal(fake.calls.filter((call) => call.script === "session-start.ts").length, 1);
	});
	test("first prompt works when SessionStart was never delivered; resume refreshes context", () => {
		const fake = stub();
		assert.match(handleKimiHook(input("UserPromptSubmit", "no-start"), root, fake.run), /North Star/);
		handleKimiHook(input("SessionStart", "no-start", { source: "resume" }), root, fake.run);
		assert.match(handleKimiHook(input("UserPromptSubmit", "no-start"), root, fake.run), /North Star/);
		assert.equal(fake.calls.filter((call) => call.script === "session-start.ts")[1]?.payload.source, "resume");
	});
	test("Write and Edit resolve relative paths and deliver warnings only on next prompt", () => {
		for (const tool of ["Write", "Edit"]) {
			const fake = stub();
			const session = `write-${tool}`;
			const output = handleKimiHook(input("PostToolUse", session, { cwd: join(root, "brain"), tool_name: tool, tool_input: { path: "Note.md" } }), root, fake.run);
			assert.equal(output, "");
			assert.deepEqual(fake.calls[0]?.payload.tool_input, { path: "Note.md", file_path: join(root, "brain", "Note.md") });
			assert.equal(fake.calls[0]?.root, root);
			assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Missing wikilinks/);
			assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Missing wikilinks/);
		}
	});
	test("Write and Edit expand home-relative paths before checking vault scope", (t) => {
		const mockedHome = t.mock.method(os, "homedir", () => temporary);
		syncBuiltinESMExports();
		try {
			for (const tool of ["Write", "Edit"]) {
				const fake = stub();
				const session = `home-relative-${tool}`;
				handleKimiHook(input("PostToolUse", session, { tool_name: tool, tool_input: { path: "~/vault/brain/Note.md" } }), root, fake.run);
				assert.deepEqual(fake.calls[0]?.payload.tool_input, { path: "~/vault/brain/Note.md", file_path: join(root, "brain", "Note.md") });
				assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Missing wikilinks/);
			}
		} finally {
			mockedHome.mock.restore();
			syncBuiltinESMExports();
		}
	});
	test("home-relative writes outside the vault never validate an unrelated same-spelled local path", (t) => {
		writeFileSync(join(external, "Home outside.md"), "external note");
		// Kimi resolves ~/elsewhere against the OS home, never a literal ~ folder.
		const misleading = join(root, "~", "elsewhere", "Home outside.md");
		mkdirSync(dirname(misleading), { recursive: true });
		writeFileSync(misleading, "unrelated local note");
		const mockedHome = t.mock.method(os, "homedir", () => temporary);
		syncBuiltinESMExports();
		try {
			for (const tool of ["Write", "Edit"]) {
				const fake = stub();
				handleKimiHook(input("PostToolUse", `home-outside-${tool}`, { tool_name: tool, tool_input: { path: "~/elsewhere/Home outside.md" } }), root, fake.run);
				assert.equal(fake.calls.length, 0);
			}
		} finally {
			mockedHome.mock.restore();
			syncBuiltinESMExports();
		}
	});
	test("revalidates pending writes and suppresses findings already fixed", () => {
		const fake = stub();
		handleKimiHook(input("PostToolUse", "fixed", { tool_name: "Edit", tool_input: { path: "brain/Note.md" } }), root, fake.run);
		fake.clearWarning();
		assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", "fixed"), root, fake.run), /Missing wikilinks/);
	});
	test("batches pending writes and leaves the remainder for later prompts", () => {
		const fake = stub();
		for (let index = 0; index < KIMI_MAX_PENDING_WRITES + 1; index++) {
			const path = `brain/Batch ${index}.md`;
			writeFileSync(join(root, path), "# note");
			handleKimiHook(input("PostToolUse", "batch", { tool_name: "Write", tool_input: { path } }), root, fake.run);
		}
		fake.calls.length = 0;
		handleKimiHook(input("UserPromptSubmit", "batch"), root, fake.run);
		assert.equal(fake.calls.filter((call) => call.script === "validate-write.ts").length, KIMI_MAX_PENDING_WRITES);
		fake.calls.length = 0;
		assert.match(handleKimiHook(input("UserPromptSubmit", "batch"), root, fake.run), /Missing wikilinks/);
		assert.equal(fake.calls.filter((call) => call.script === "validate-write.ts").length, 1);
	});
	test("failed startup and validation remain pending, while available context still emits", () => {
		const fake = stub();
		handleKimiHook(input("PostToolUse", "retry", { tool_name: "Write", tool_input: { path: "brain/Note.md" } }), root, fake.run);
		const failing: HookRunner = (script, payload, directory) => {
			if (script !== "classify-message.ts") throw new Error("simulated timeout");
			return fake.run(script, payload, directory);
		};
		assert.equal(handleKimiHook(input("UserPromptSubmit", "retry", { prompt: "message" }), root, failing), "Routing hints");
		const retried = handleKimiHook(input("UserPromptSubmit", "retry"), root, fake.run);
		assert.match(retried, /North Star/);
		assert.match(retried, /Missing wikilinks/);
	});
	test("retrying failures cannot starve later queued writes", () => {
		const fake = stub();
		const session = "fair-retry";
		for (let index = 0; index < KIMI_MAX_PENDING_WRITES + 1; index++) {
			const path = `brain/Fair retry ${index}.md`;
			writeFileSync(join(root, path), "# note");
			handleKimiHook(input("PostToolUse", session, { tool_name: "Write", tool_input: { path } }), root, fake.run);
		}
		const failed = new Set<string>();
		handleKimiHook(input("UserPromptSubmit", session), root, (script, payload) => {
			if (script === "validate-write.ts") {
				failed.add((payload.tool_input as { file_path: string }).file_path);
				throw new Error("this file keeps timing out");
			}
			return "";
		});
		assert.equal(failed.size, KIMI_MAX_PENDING_WRITES);
		const result = handleKimiHook(input("UserPromptSubmit", session), root, (script, payload) => {
			if (script !== "validate-write.ts") return "";
			if (failed.has((payload.tool_input as { file_path: string }).file_path)) {
				throw new Error("still timing out");
			}
			return JSON.stringify({ systemMessage: "Finding from the remaining file" });
		});
		assert.match(result, /Finding from the remaining file/);
	});
	test("an initial PostToolUse validation failure still queues its path", () => {
		const fake = stub();
		assert.equal(handleKimiHook(input("PostToolUse", "first-failure", { tool_name: "Edit", tool_input: { path: "brain/Note.md" } }), root, () => { throw new Error("timeout"); }), "");
		assert.match(handleKimiHook(input("UserPromptSubmit", "first-failure"), root, fake.run), /Missing wikilinks/);
	});
	test("a concurrent process replacing a queued write during acknowledgement is not lost", () => {
		const fake = stub();
		const session = "concurrent-ack";
		const note = join(root, "brain", "Note.md");
		const hash = createHash("sha256").update(note).digest("hex");
		const pending = join(stateDirectory(session), "writes", `${hash}.json`);
		handleKimiHook(input("PostToolUse", session, { tool_name: "Write", tool_input: { path: note } }), root, fake.run);
		const newer = JSON.stringify({ path: note, generation: "newer-concurrent-write" });
		// Put the other process exactly at the acknowledgement boundary.
		// A compare-then-unlink implementation deletes the newer generation;
		// an immutable acknowledgement records only what it actually read.
		replaceDuringAcknowledgement(pending, newer, () => {
			handleKimiHook(input("UserPromptSubmit", session), root, fake.run);
		});
		assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Missing wikilinks/);
	});
	test("repeated writes retain bounded cache files and skip acknowledged generations", () => {
		const fake = stub();
		const session = "bounded-cache";
		fake.clearWarning();
		for (let index = 0; index < 20; index++) {
			handleKimiHook(input("PostToolUse", session, { tool_name: "Edit", tool_input: { path: "brain/Note.md" } }), root, fake.run);
		}
		assert.equal(readdirSync(join(stateDirectory(session), "writes")).length, 2);
		fake.calls.length = 0;
		handleKimiHook(input("UserPromptSubmit", session), root, fake.run);
		assert.equal(fake.calls.filter((call) => call.script === "validate-write.ts").length, 0);
		handleKimiHook(input("SessionEnd", session), root, fake.run);
		assert.equal(existsSync(stateDirectory(session)), false);
	});
	test("bounds aggregate work and preserves paths deferred by the deadline", () => {
		const fake = stub();
		for (let index = 0; index < 3; index++) {
			const path = `brain/Budget ${index}.md`;
			writeFileSync(join(root, path), "# note");
			handleKimiHook(input("PostToolUse", "budget", { tool_name: "Write", tool_input: { path } }), root, fake.run);
		}
		let elapsed = 0;
		const limits: number[] = [];
		const slow: HookRunner = (script, payload, directory, timeoutMs) => {
			assert.ok(timeoutMs !== undefined && timeoutMs > 0);
			limits.push(timeoutMs);
			elapsed += timeoutMs;
			return fake.run(script, payload, directory);
		};
		const result = handleKimiHook(input("UserPromptSubmit", "budget"), root, slow, () => elapsed);
		assert.match(result, /North Star/);
		assert.ok(elapsed < KIMI_PROMPT_BUDGET_MS);
		assert.deepEqual(limits, [35_000, 3_000, 5_000, 1_500]);
		fake.calls.length = 0;
		assert.match(handleKimiHook(input("UserPromptSubmit", "budget"), root, fake.run), /Missing wikilinks/);
		assert.equal(fake.calls.filter((call) => call.script === "validate-write.ts").length, 1);
	});
	test("only registered write tools and in-vault paths can invoke validation", () => {
		writeFileSync(join(nested, "Note.md"), "nested");
		const fake = stub();
		for (const extra of [
			{ tool_name: "Bash", tool_input: { path: "brain/Note.md" } },
			{ tool_name: "Write", tool_input: { path: join(nested, "Note.md") } },
			{ tool_name: "Write", tool_input: { path: "missing.md" } },
			{ tool_name: "Write", tool_input: { file_path: "brain/Note.md" } },
		]) handleKimiHook(input("PostToolUse", "bad-write", extra), root, fake.run);
		assert.equal(fake.calls.length, 0);
	});
	test("Stop never blocks or prints discarded output; checklist is queued per session", () => {
		const fake = stub();
		assert.equal(handleKimiHook(input("Stop", "stop"), root, fake.run), "");
		assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", "another"), root, fake.run), /checklist/);
		assert.match(handleKimiHook(input("UserPromptSubmit", "stop"), root, fake.run), /Reminder from the previous turn:\nSession end checklist/);
		const count = fake.calls.length;
		assert.equal(handleKimiHook(input("Stop", "stop", { stop_hook_active: true }), root, fake.run), "");
		assert.equal(fake.calls.length, count);
	});
	test("SessionEnd clears queued context and reminders", () => {
		const fake = stub();
		handleKimiHook(input("Stop", "ended"), root, fake.run);
		assert.equal(handleKimiHook(input("SessionEnd", "ended"), root, fake.run), "");
		assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", "ended"), root, fake.run), /checklist/);
	});
	test("a concurrently replaced Stop checklist survives acknowledgement of the previous one", () => {
		const fake = stub();
		const session = "concurrent-stop";
		handleKimiHook(input("Stop", session), root, fake.run);
		replaceDuringAcknowledgement(join(stateDirectory(session), "stop.txt"), "Newer checklist", () => {
			assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Session end checklist/);
		});
		assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Newer checklist/);
		assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /checklist/);
		// Repeated identical text is a new turn, so it must still be delivered.
		handleKimiHook(input("Stop", session), root, fake.run);
		assert.match(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Session end checklist/);
	});
	test("a Stop hook finishing after SessionEnd cannot recreate its checklist", () => {
		const fake = stub();
		const session = "end-during-stop";
		handleKimiHook(input("Stop", session), root, () => {
			handleKimiHook(input("SessionEnd", session), root, fake.run);
			return JSON.stringify({ systemMessage: "Expired checklist" });
		});
		assert.doesNotMatch(handleKimiHook(input("UserPromptSubmit", session), root, fake.run), /Expired checklist/);
	});
	test("prompt acknowledgements cannot recreate state removed by SessionEnd", () => {
		const fake = stub();
		const session = "end-during-prompt";
		handleKimiHook(input("UserPromptSubmit", session), root, (script, payload, directory) => {
			if (script === "classify-message.ts") handleKimiHook(input("SessionEnd", session), root, fake.run);
			return fake.run(script, payload, directory);
		});
		assert.equal(existsSync(stateDirectory(session)), false);
	});
	test("malformed input, missing session IDs, PreCompact, and arbitrary events are no-ops", () => {
		const fake = stub();
		for (const value of [null, [], false, {}, input("UserPromptSubmit", ""), input("PreCompact", "ignored"), input("../../arbitrary-script.ts", "ignored")]) {
			assert.equal(handleKimiHook(value, root, fake.run), "");
		}
		assert.equal(fake.calls.length, 0);
	});
});

describe("Kimi entrypoint subprocess", () => {
	test("fixed script dispatch, environment isolation, and actual stdin/stdout contract", () => {
		const directory = join(root, ".claude", "scripts");
		mkdirSync(join(directory, "lib"), { recursive: true });
		for (const file of ["kimi-hook.ts", "lib/kimi-hook.ts", "lib/hook-io.ts"]) copyFileSync(join(scripts, file), join(directory, file));
		writeFileSync(join(directory, "package.json"), '{"type":"module"}');
		writeFileSync(join(directory, "session-start.ts"), 'console.log("Actual startup context");');
		writeFileSync(join(directory, "classify-message.ts"), `
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({hookSpecificOutput:{additionalContext: JSON.stringify({prompt:payload.prompt,root:process.env.CLAUDE_PROJECT_DIR,hasEnvFile:!!process.env.CLAUDE_ENV_FILE})}}));
`);
		const foreignEnvFile = join(temporary, "foreign-env");
		writeFileSync(foreignEnvFile, "unchanged");
		const hook = join(directory, "kimi-hook.ts");
		const result = runScript(hook, input("UserPromptSubmit", "subprocess", { prompt: [{ type: "text", text: "hello" }] }), { CLAUDE_PROJECT_DIR: external, CLAUDE_ENV_FILE: foreignEnvFile });
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /^Actual startup context\n/);
		assert.match(result.stdout, /"prompt":"hello"/);
		assert.match(result.stdout, /"hasEnvFile":false/);
		assert.equal(readFileSync(foreignEnvFile, "utf-8"), "unchanged");
		assert.equal(existsSync(join(external, ".kimi-code")), false);
		for (const malformed of ["not-json", "null", "[]"]) {
			const invalid = runScript(hook, malformed);
			assert.equal(invalid.code, 0);
			assert.equal(invalid.stdout, "");
		}
		writeFileSync(join(directory, "validate-write.ts"), 'process.exitCode = 1;');
		assert.throws(() => runSharedKimiHook("validate-write.ts", {}, root), /failed or timed out/);
		writeFileSync(join(directory, "validate-write.ts"), 'setInterval(() => {}, 1000);');
		assert.throws(() => runSharedKimiHook("validate-write.ts", {}, root, 40), /failed or timed out/);
	});
});

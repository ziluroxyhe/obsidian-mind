import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { buildHooks, mergeHooks, setupKimi } from "../../../.scripts/kimi-setup.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skill = "---\nname: notes\ndescription: Note conventions\n---\nSee references/rules.md.\n";
const command = "---\ndescription: Capture notes\n---\nCapture $ARGUMENTS using [[Home]].\n";
const agent = "---\nname: review\ndescription: Read notes\ntools: Read, Grep, Glob, Bash\nmodel: sonnet\n---\nReview the notes.\n";

function put(path: string, value: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value);
}

function fixture(t: TestContext): { root: string; home: string; base: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kimi-setup-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const root = join(base, "a vault's notes");
	put(join(root, "vault-manifest.json"), "{}");
	put(join(root, ".claude/scripts/kimi-hook.ts"), "process.stdout.write(JSON.stringify(process.argv));\n");
	put(join(root, ".claude/scripts/qmd-mcp.mjs"), "// fixture\n");
	put(join(root, ".claude/skills/notes/SKILL.md"), skill);
	put(join(root, ".claude/skills/notes/references/rules.md"), "Keep every reference.\n");
	put(join(root, ".claude/commands/om-capture.md"), command);
	put(join(root, ".claude/agents/review.md"), agent);
	return { root, home: join(base, "isolated-kimi-home"), base };
}

test("default setup materializes skill references, flat commands and agents without touching home", (t) => {
	const { root, home } = fixture(t);
	const config = '# Existing config\n[models.test]\nmodel = "example"\n';
	put(join(home, "config.toml"), config);
	const result = setupKimi({ vaultRoot: root, kimiHome: home, platform: "darwin" });
	assert.equal(result.configPath, null);
	assert.equal(readFileSync(join(home, "config.toml"), "utf8"), config);
	assert.deepEqual(readdirSync(home), ["config.toml"]);
	assert.equal(readFileSync(join(root, ".kimi-code/skills/notes/SKILL.md"), "utf8"), skill);
	assert.equal(readFileSync(join(root, ".kimi-code/skills/notes/references/rules.md"), "utf8"), "Keep every reference.\n");
	assert.equal(readFileSync(join(root, ".kimi-code/skills/om-capture.md"), "utf8"), command);
	assert.equal(readFileSync(join(root, ".kimi-code/agents/review.md"), "utf8"), agent);
	const mcp = JSON.parse(readFileSync(join(root, ".kimi-code/mcp.json"), "utf8"));
	assert.equal(mcp.mcpServers.qmd.command, process.execPath);
	assert.deepEqual(mcp.mcpServers.qmd.args, [join(root, ".claude/scripts/qmd-mcp.mjs")]);
	assert.equal(mcp.mcpServers.qmd.env.CLAUDE_PROJECT_DIR, root);
	assert.deepEqual(setupKimi({ vaultRoot: root, kimiHome: home, platform: "darwin" }).changed, []);
});

test("generated hook command executes literally when its path contains spaces and apostrophes", { skip: process.platform === "win32" }, (t) => {
	const { root } = fixture(t);
	const nodePath = join(root, "node's binary");
	symlinkSync(process.execPath, nodePath);
	const result = setupKimi({ vaultRoot: root, nodePath, platform: "darwin" });
	const hooks = readFileSync(result.hooksPath, "utf8");
	assert.deepEqual([...hooks.matchAll(/^event = "(.*)"$/gm)].map((match) => match[1]), ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
	assert.ok(hooks.includes('matcher = "^(Write|Edit)$"'));
	assert.ok(!hooks.includes("PreCompact"));
	const shellCommand = JSON.parse(hooks.match(/^command = (.+)$/m)![1]!);
	const run = spawnSync("/bin/sh", ["-c", shellCommand], { cwd: tmpdir(), encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout)[1], join(root, ".claude/scripts/kimi-hook.ts"));
});

test("hook install preserves unrelated bytes, backs up first, and replaces only this vault's block", (t) => {
	const { root, home } = fixture(t);
	const path = join(home, "config.toml");
	const original = '# Personal formatting\r\ndefault_model="my-model"\r\n\r\n[[hooks]]\r\nevent="Stop"\r\ncommand="echo custom"\r\n\r\n[providers.mine]\r\ntype="kimi"';
	put(path, original);
	const options = { vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" as const };
	const first = setupKimi(options);
	const installed = readFileSync(path, "utf8");
	assert.ok(installed.startsWith(original + "\n\n# BEGIN"));
	assert.equal(first.backups.length, 1);
	assert.equal(readFileSync(first.backups[0]!, "utf8"), original);
	assert.deepEqual(setupKimi(options).backups, []);
	assert.equal(readFileSync(path, "utf8"), installed);
	const otherVault = join(root, "other-vault");
	const withOther = mergeHooks(installed, otherVault, buildHooks(otherVault, process.execPath));
	writeFileSync(path, withOther);
	const before = withOther.slice(withOther.indexOf("# BEGIN", withOther.indexOf("# END")));
	const updated = setupKimi({ ...options, nodePath: join(root, "new node") });
	assert.ok(updated.backups.includes(updated.backups.find((item) => item.startsWith(path + ".bak-"))!));
	const after = readFileSync(path, "utf8");
	assert.ok(after.startsWith(original));
	assert.ok(after.endsWith(before));
	assert.equal([...after.matchAll(/^# BEGIN obsidian-mind/gm)].length, 2);
	assert.equal([...after.matchAll(/new node/g)].length, 5);
});

test("only untouched managed files are refreshed; user files and edits survive", (t) => {
	const { root } = fixture(t);
	const userCommand = join(root, ".kimi-code/skills/om-capture.md");
	const custom = join(root, ".kimi-code/skills/custom.md");
	put(userCommand, "My own command.\n");
	put(custom, "Unrelated user skill.\n");
	let result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.includes(userCommand));
	const managed = join(root, ".kimi-code/skills/notes/SKILL.md");
	writeFileSync(managed, "User modified the generated skill.\n");
	put(join(root, ".claude/skills/notes/SKILL.md"), skill + "Upstream changed.\n");
	put(join(root, ".claude/skills/notes/references/rules.md"), "Updated reference.\n");
	result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.includes(managed));
	assert.equal(readFileSync(managed, "utf8"), "User modified the generated skill.\n");
	assert.equal(readFileSync(userCommand, "utf8"), "My own command.\n");
	assert.equal(readFileSync(custom, "utf8"), "Unrelated user skill.\n");
	assert.equal(readFileSync(join(root, ".kimi-code/skills/notes/references/rules.md"), "utf8"), "Updated reference.\n");
});

test("MCP merge retains other servers and never overwrites an existing qmd registration", (t) => {
	const { root } = fixture(t);
	const path = join(root, ".kimi-code/mcp.json");
	const original = '{"mcpServers":{"personal":{"command":"my-server","env":{"TOKEN":"fixture"}}},"custom":true}\n';
	put(path, original);
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	const merged = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(merged.mcpServers.personal, { command: "my-server", env: { TOKEN: "fixture" } });
	assert.equal(merged.custom, true);
	assert.equal(readFileSync(result.backups[0]!, "utf8"), original);
	const conflict = '{"mcpServers":{"qmd":{"command":"my-qmd"},"personal":{"command":"my-server"}}}\n';
	writeFileSync(path, conflict);
	const second = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(second.conflicts.some((item) => item.includes("existing qmd")));
	assert.equal(readFileSync(path, "utf8"), conflict);
	assert.deepEqual(second.backups, []);
});

test("moving a prepared vault refreshes owned absolute paths without duplicating global hooks", (t) => {
	const { root, home, base } = fixture(t);
	setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	const moved = join(base, "moved vault");
	renameSync(root, moved);
	const result = setupKimi({ vaultRoot: moved, kimiHome: home, installHooks: true, platform: "darwin" });
	assert.deepEqual(result.conflicts, []);
	const mcp = JSON.parse(readFileSync(join(moved, ".kimi-code/mcp.json"), "utf8"));
	assert.deepEqual(mcp.mcpServers.qmd.args, [join(moved, ".claude/scripts/qmd-mcp.mjs")]);
	assert.equal(mcp.mcpServers.qmd.env.CLAUDE_PROJECT_DIR, moved);
	const global = readFileSync(join(home, "config.toml"), "utf8");
	assert.equal([...global.matchAll(/^# BEGIN obsidian-mind/gm)].length, 1);
	assert.ok(!global.includes(root));
	assert.ok(global.includes(moved));
	assert.deepEqual(setupKimi({ vaultRoot: moved, kimiHome: home, installHooks: true, platform: "darwin" }).changed, []);
});

test("destination symlinks cannot redirect managed skill writes outside the vault", { skip: process.platform === "win32" }, (t) => {
	const { root, base } = fixture(t);
	const outside = join(base, "outside");
	put(join(outside, "notes/SKILL.md"), "Do not overwrite.\n");
	mkdirSync(join(root, ".kimi-code"));
	symlinkSync(outside, join(root, ".kimi-code/skills"));
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.length > 0);
	assert.equal(readFileSync(join(outside, "notes/SKILL.md"), "utf8"), "Do not overwrite.\n");
	assert.deepEqual(readdirSync(outside), ["notes"]);
});

test("root hooks shorthand is handled safely and nested unrelated hooks keys are untouched", (t) => {
	const { root, home } = fixture(t);
	const path = join(home, "config.toml");
	const incompatible = 'hooks = [{ event="Stop", command="custom" }]\n[providers.mine]\ntype="kimi"\n';
	put(path, incompatible);
	assert.throws(() => setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" }), /root hooks/);
	assert.equal(readFileSync(path, "utf8"), incompatible);
	assert.deepEqual(readdirSync(home), ["config.toml"]);
	const empty = 'default_model="mine"\nhooks = [] # keep comment\n[providers.mine]\ntype="kimi"\n';
	const merged = mergeHooks(empty, root, buildHooks(root, process.execPath));
	assert.ok(merged.startsWith('default_model="mine"\n# keep comment\n[providers.mine]\ntype="kimi"\n'));
	const nested = '[providers.mine]\nhooks = ["unrelated"]\n';
	assert.ok(mergeHooks(nested, root, buildHooks(root, process.execPath)).startsWith(nested));
});

test("broken or duplicated managed markers are refused", () => {
	const complete = mergeHooks("", "/fixture", buildHooks("/fixture", "/usr/bin/node"));
	assert.throws(() => mergeHooks(complete.replace(/^# END.*\n/m, ""), "/fixture", ""), /Ambiguous/);
	assert.throws(() => mergeHooks(complete + complete, "/fixture", ""), /Ambiguous/);
});

test("native Windows setup reports unsupported shells before writing any project files", (t) => {
	const { root } = fixture(t);
	assert.throws(() => setupKimi({ vaultRoot: root, platform: "win32" }), /macOS\/Linux/);
	assert.equal(existsSync(join(root, ".kimi-code")), false);
});

test("CLI honors KIMI_CODE_HOME only with explicit --install-hooks", { skip: process.platform === "win32" }, (t) => {
	const { root, home, base } = fixture(t);
	const script = join(root, ".scripts/kimi-setup.ts");
	put(join(root, ".scripts/package.json"), '{"type":"module"}');
	copyFileSync(join(repository, ".scripts/kimi-setup.ts"), script);
	put(join(root, ".claude/scripts/lib/main-guard.ts"), readFileSync(join(repository, ".claude/scripts/lib/main-guard.ts"), "utf8"));
	const options = { cwd: base, encoding: "utf8" as const, env: { ...process.env, HOME: join(base, "fake-home"), KIMI_CODE_HOME: home } };
	const prepared = spawnSync(process.execPath, ["--experimental-strip-types", script], options);
	assert.equal(prepared.status, 0, prepared.stderr);
	assert.equal(existsSync(home), false);
	assert.match(prepared.stdout, /Home config unchanged/);
	const installed = spawnSync(process.execPath, ["--experimental-strip-types", script, "--install-hooks"], options);
	assert.equal(installed.status, 0, installed.stderr);
	assert.ok(readFileSync(join(home, "config.toml"), "utf8").includes("[[hooks]]"));
	assert.equal(existsSync(join(base, "fake-home/.kimi-code")), false);
});

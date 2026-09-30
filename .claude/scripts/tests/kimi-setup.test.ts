import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

test("updates retire unchanged managed commands, agents and skill files removed from the source", (t) => {
	const { root } = fixture(t);
	put(join(root, ".claude/skills/retired/SKILL.md"), skill);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const generated = join(root, ".kimi-code");
	put(join(generated, "skills/personal.md"), "Keep this personal skill.\n");
	renameSync(join(root, ".claude/commands/om-capture.md"), join(root, ".claude/commands/om-new.md"));
	rmSync(join(root, ".claude/agents/review.md"));
	rmSync(join(root, ".claude/skills/notes/references/rules.md"));
	rmSync(join(root, ".claude/skills/retired"), { recursive: true });
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	for (const path of ["skills/om-capture.md", "agents/review.md", "skills/notes/references/rules.md", "skills/retired/SKILL.md"]) {
		assert.equal(existsSync(join(generated, path)), false, `Retired file remains discoverable: ${path}`);
		assert.ok(result.changed.includes(join(generated, path)));
		assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(generated, ".mind-setup.json"), "utf8")).files, path), false);
	}
	assert.equal(readFileSync(join(generated, "skills/om-new.md"), "utf8"), command);
	assert.equal(readFileSync(join(generated, "skills/personal.md"), "utf8"), "Keep this personal skill.\n");
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(setupKimi({ vaultRoot: root, platform: "darwin" }).changed, []);
});

test("retired modified files remain conflicts while missing files relinquish ownership", (t) => {
	const { root } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const generated = join(root, ".kimi-code");
	const edited = join(generated, "skills/om-capture.md");
	writeFileSync(edited, "My edited command.\n");
	rmSync(join(generated, "skills/notes"), { recursive: true });
	rmSync(join(root, ".claude/commands/om-capture.md"));
	rmSync(join(root, ".claude/skills/notes"), { recursive: true });
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.includes(edited));
	assert.equal(readFileSync(edited, "utf8"), "My edited command.\n");
	const state = JSON.parse(readFileSync(join(generated, ".mind-setup.json"), "utf8"));
	assert.ok(Object.hasOwn(state.files, "skills/om-capture.md"));
	assert.equal(Object.keys(state.files).some((path) => path.startsWith("skills/notes/")), false);
	assert.equal(existsSync(join(generated, "skills/notes")), false);
});

test("retirement preserves linked destinations and skipped source subtrees", { skip: process.platform === "win32" }, (t) => {
	const { root, base } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const generated = join(root, ".kimi-code");
	const outsideCommand = join(base, "outside.md");
	put(outsideCommand, command);
	rmSync(join(generated, "skills/om-capture.md"));
	symlinkSync(outsideCommand, join(generated, "skills/om-capture.md"));
	renameSync(join(generated, "agents"), join(base, "outside-agents"));
	symlinkSync(join(base, "outside-agents"), join(generated, "agents"));
	rmSync(join(root, ".claude/commands/om-capture.md"));
	rmSync(join(root, ".claude/agents/review.md"));
	renameSync(join(root, ".claude/skills/notes"), join(base, "source-notes"));
	symlinkSync(join(base, "source-notes"), join(root, ".claude/skills/notes"));
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.includes(join(generated, "skills/om-capture.md")));
	assert.ok(result.conflicts.includes(join(generated, "agents/review.md")));
	assert.ok(result.conflicts.includes(join(root, ".claude/skills/notes")));
	assert.equal(lstatSync(join(generated, "skills/om-capture.md")).isSymbolicLink(), true);
	assert.equal(readFileSync(outsideCommand, "utf8"), command);
	assert.equal(readFileSync(join(base, "outside-agents/review.md"), "utf8"), agent);
	assert.equal(readFileSync(join(generated, "skills/notes/SKILL.md"), "utf8"), skill);
	assert.equal(readFileSync(join(generated, "skills/notes/references/rules.md"), "utf8"), "Keep every reference.\n");
});

test("unreadable or dangling skill sources cannot be mistaken for retired files", { skip: process.platform === "win32" }, (t) => {
	const { root, base } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const sourceSkill = join(root, ".claude/skills/notes/SKILL.md");
	const generated = join(root, ".kimi-code");
	rmSync(join(root, ".claude/commands/om-capture.md"));
	const originalLstat = fs.lstatSync;
	const mocked = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof originalLstat>) => {
		if (String(args[0]) === sourceSkill) throw Object.assign(new Error("simulated unreadable source"), { code: "EACCES" });
		return originalLstat(...args);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }), /simulated unreadable source/);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal(readFileSync(join(generated, "skills/om-capture.md"), "utf8"), command);
	rmSync(sourceSkill);
	symlinkSync(join(base, "missing-skill.md"), sourceSkill);
	const result = setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.ok(result.conflicts.includes(sourceSkill));
	assert.equal(readFileSync(join(generated, "skills/notes/SKILL.md"), "utf8"), skill);
	assert.equal(existsSync(join(generated, "skills/om-capture.md")), false);
});

test("invalid ownership paths cannot retire files outside generated directories", (t) => {
	const { root } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const path = join(root, ".kimi-code/.mind-setup.json");
	const original = JSON.parse(readFileSync(path, "utf8"));
	put(join(root, "sentinel.md"), command);
	for (const file of ["skills/../../sentinel.md", "skills/..\\..\\sentinel.md", "../sentinel.md", "hooks.toml"]) {
		const state = structuredClone(original);
		state.files[file] = state.files["skills/om-capture.md"];
		const invalid = JSON.stringify(state);
		writeFileSync(path, invalid);
		assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }), /Invalid setup state/);
		assert.equal(readFileSync(join(root, "sentinel.md"), "utf8"), command);
		assert.equal(readFileSync(path, "utf8"), invalid);
	}
});

test("completed retirements retain retryable ownership after a later removal fails", (t) => {
	const { root } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const generated = join(root, ".kimi-code");
	rmSync(join(root, ".claude/commands/om-capture.md"));
	rmSync(join(root, ".claude/agents/review.md"));
	const originalUnlink = fs.unlinkSync;
	const mocked = t.mock.method(fs, "unlinkSync", (path: Parameters<typeof originalUnlink>[0]) => {
		if (String(path) === join(generated, "agents/review.md")) throw new Error("simulated removal failure");
		return originalUnlink(path);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }), /simulated removal failure/);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
	const state = JSON.parse(readFileSync(join(generated, ".mind-setup.json"), "utf8"));
	assert.equal(existsSync(join(generated, "skills/om-capture.md")), false);
	assert.equal(Object.hasOwn(state.files, "skills/om-capture.md"), false);
	assert.ok(Object.hasOwn(state.files, "agents/review.md"));
	assert.deepEqual(setupKimi({ vaultRoot: root, platform: "darwin" }).conflicts, []);
	assert.equal(existsSync(join(generated, "agents/review.md")), false);
});

test("moving a prepared vault refreshes owned absolute paths without duplicating global hooks", (t) => {
	const { root, home, base } = fixture(t);
	setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	const moved = join(base, "moved vault");
	renameSync(root, moved);
	// An unrelated folder may now occupy the old path; its identity is different.
	put(join(root, ".kimi-code/.mind-setup.json"), '{"hookId":"0000000000000000"}');
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

test("copying a prepared vault preserves the original vault's separate global hooks", (t) => {
	const { root, home, base } = fixture(t);
	setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	const copied = join(base, "copied vault");
	cpSync(root, copied, { recursive: true });
	setupKimi({ vaultRoot: copied, kimiHome: home, installHooks: true, platform: "darwin" });
	const config = readFileSync(join(home, "config.toml"), "utf8");
	assert.equal([...config.matchAll(/^# BEGIN obsidian-mind/gm)].length, 2);
	assert.ok(config.includes(root));
	assert.ok(config.includes(copied));
	assert.deepEqual(setupKimi({ vaultRoot: copied, kimiHome: home, installHooks: true, platform: "darwin" }).changed, []);
	assert.deepEqual(setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" }).changed, []);
});

test("legacy state without a recorded root recovers its origin from owned MCP metadata before copying", (t) => {
	const { root, home, base } = fixture(t);
	setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	const path = join(root, ".kimi-code/.mind-setup.json");
	const legacy = JSON.parse(readFileSync(path, "utf8"));
	delete legacy.vaultRoot;
	writeFileSync(path, JSON.stringify(legacy));
	const copied = join(base, "legacy copy");
	cpSync(root, copied, { recursive: true });
	setupKimi({ vaultRoot: copied, platform: "darwin" });
	setupKimi({ vaultRoot: copied, kimiHome: home, installHooks: true, platform: "darwin" });
	setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	const config = readFileSync(join(home, "config.toml"), "utf8");
	assert.equal([...config.matchAll(/^# BEGIN obsidian-mind/gm)].length, 2);
	assert.ok(config.includes(root));
	assert.ok(config.includes(copied));
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

test("TOML-looking text inside multiline strings cannot be removed or treated as a managed block", () => {
	const hooks = buildHooks("/fixture", "/usr/bin/node");
	for (const content of ["hooks = []", "[not-a-table]\nhooks = []", mergeHooks("", "/fixture", hooks).trimEnd()]) {
		const original = `description = '''\n${content}\n'''\n`;
		assert.ok(mergeHooks(original, "/fixture", hooks).startsWith(original));
	}
	const embeddedTable = "description = '''\n[not-a-table]\n'''\nhooks = []\n";
	const merged = mergeHooks(embeddedTable, "/fixture", hooks);
	assert.ok(!merged.includes("\nhooks = []"));
	assert.ok(merged.startsWith("description = '''\n[not-a-table]\n'''\n"));
	const encodedKey = '"\\u0068ooks" = []\n';
	assert.ok(!mergeHooks(encodedKey, "/fixture", hooks).includes(encodedKey));
	const literalEscape = '"\\\\U00000068ooks" = []\n';
	assert.ok(mergeHooks(literalEscape, "/fixture", hooks).startsWith(literalEscape));
	const dottedKey = '"providers"."mine"."type" = "kimi"\n';
	assert.ok(mergeHooks(dottedKey, "/fixture", hooks).startsWith(dottedKey));
	assert.throws(() => mergeHooks('hooks = ["existing"]\n', "/fixture", hooks), /root hooks/);
});

test("invalid existing config fails before changing generated skills or their ownership", (t) => {
	const { root, home } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const managed = join(root, ".kimi-code/skills/notes/SKILL.md");
	const state = join(root, ".kimi-code/.mind-setup.json");
	const oldState = readFileSync(state, "utf8");
	put(join(root, ".claude/skills/notes/SKILL.md"), skill + "Updated.\n");
	const mcp = join(root, ".kimi-code/mcp.json");
	const oldMcp = readFileSync(mcp, "utf8");
	writeFileSync(mcp, "invalid JSON");
	assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }));
	assert.equal(readFileSync(managed, "utf8"), skill);
	assert.equal(readFileSync(state, "utf8"), oldState);
	writeFileSync(mcp, oldMcp);
	put(join(home, "config.toml"), 'hooks = [{event="Stop",command="custom"}]\n');
	assert.throws(() => setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" }), /root hooks/);
	assert.equal(readFileSync(managed, "utf8"), skill);
	assert.equal(readFileSync(state, "utf8"), oldState);
	assert.deepEqual(setupKimi({ vaultRoot: root, platform: "darwin" }).conflicts, []);
	assert.equal(readFileSync(managed, "utf8"), skill + "Updated.\n");
});

test("completed file ownership survives a later filesystem failure and a retry", (t) => {
	const { root } = fixture(t);
	const originalRename = fs.renameSync;
	const mocked = t.mock.method(fs, "renameSync", (from: Parameters<typeof originalRename>[0], to: Parameters<typeof originalRename>[1]) => {
		if (String(to) === join(root, ".kimi-code/agents/review.md")) throw new Error("simulated disk failure");
		return originalRename(from, to);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }), /simulated disk failure/);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
	assert.equal(readFileSync(join(root, ".kimi-code/skills/notes/SKILL.md"), "utf8"), skill);
	assert.deepEqual(readdirSync(join(root, ".kimi-code/agents")), []);
	assert.deepEqual(setupKimi({ vaultRoot: root, platform: "darwin" }).conflicts, []);
});

test("a linked source root is refused before materializing personal files", { skip: process.platform === "win32" }, (t) => {
	const { root, base } = fixture(t);
	const source = join(root, ".claude/skills");
	const outside = join(base, "personal-skills");
	renameSync(source, outside);
	symlinkSync(outside, source);
	assert.throws(() => setupKimi({ vaultRoot: root, platform: "darwin" }), /Source directory/);
	assert.equal(existsSync(join(root, ".kimi-code")), false);
});

test("atomic replacement cannot overwrite another hard link to a managed skill", { skip: process.platform === "win32" }, (t) => {
	const { root, base } = fixture(t);
	setupKimi({ vaultRoot: root, platform: "darwin" });
	const outside = join(base, "separate-copy.md");
	linkSync(join(root, ".kimi-code/skills/notes/SKILL.md"), outside);
	put(join(root, ".claude/skills/notes/SKILL.md"), skill + "Updated.\n");
	setupKimi({ vaultRoot: root, platform: "darwin" });
	assert.equal(readFileSync(outside, "utf8"), skill);
	assert.equal(readFileSync(join(root, ".kimi-code/skills/notes/SKILL.md"), "utf8"), skill + "Updated.\n");
});

test("intentional global config symlinks remain links and retain target mode and unrelated bytes", { skip: process.platform === "win32" }, (t) => {
	const { root, home, base } = fixture(t);
	const target = join(base, "dotfiles/config.toml");
	const original = '# My configuration\ndefault_model = "example"\n';
	put(target, original);
	const mode = statSync(target).mode & 0o777;
	mkdirSync(home);
	const path = join(home, "config.toml");
	symlinkSync(target, path);
	const result = setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	assert.equal(lstatSync(path).isSymbolicLink(), true);
	assert.ok(readFileSync(target, "utf8").startsWith(original));
	assert.equal(statSync(target).mode & 0o777, mode);
	assert.equal(readFileSync(result.backups[0]!, "utf8"), original);
	assert.deepEqual(readdirSync(dirname(target)), ["config.toml"]);
});

test("atomic config updates preserve existing modes even under a restrictive umask", { skip: process.platform === "win32" }, (t) => {
	const { root, home } = fixture(t);
	const path = join(home, "config.toml");
	put(path, '# shared config\n');
	chmodSync(path, 0o660);
	const mask = process.umask(0o077);
	try {
		setupKimi({ vaultRoot: root, kimiHome: home, installHooks: true, platform: "darwin" });
	} finally {
		process.umask(mask);
	}
	assert.equal(statSync(path).mode & 0o777, 0o660);
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

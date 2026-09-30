#!/usr/bin/env node
/** Kimi Code CLI adapter. Install its generated global hooks via kimi-setup. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import { handleKimiHook } from "./lib/kimi-hook.ts";

// A global hook belongs to THIS vault, never to a path supplied by stdin
// or by another harness's inherited environment variables.
const vaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
try {
	const output = handleKimiHook(await readStdinJson(), vaultRoot);
	if (output) process.stdout.write(output);
} catch (error) {
	debug(`kimi hook skipped: ${String(error)}`);
}

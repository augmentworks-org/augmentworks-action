import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// npm dist.integrity of the complete published package, including its data assets.
const archive = new URL("../vendor/augmentworks-cli-0.4.2.tgz", import.meta.url);
const integrity = "jyXZSnW8L1AcET3fjMLm9++Izjeu061Za/3Iis3gy+foWUqW0OhScjU8Vr9bm3yDiP+ExRuAYvMac/cZrWZ6tA==";
const outputLimit = 32 * 1024 * 1024;

function cliEnvironment(env) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    // Only the wrapper publishes Actions output. Target and AugmentWorks
    // credentials intentionally come from the caller-provided environment.
    if (/^(?:INPUT_|ACTIONS_)/i.test(key) ||
        /^(?:GITHUB_(?:ENV|OUTPUT|PATH|STATE|STEP_SUMMARY|TOKEN)|GH_TOKEN|NODE_OPTIONS|NODE_PATH|TAR_OPTIONS)$/i.test(key)) {
      delete result[key];
    }
  }
  return result;
}

function runChild(command, args, { cwd, env, signal, timeoutMs, stdin }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let failure;
    let escalation;

    function stop(message) {
      if (failure) return;
      failure = message;
      // Give the local runner a chance to clean up its test fixtures.
      child.kill("SIGINT");
      escalation = setTimeout(() => child.kill("SIGKILL"), 5000);
      escalation.unref();
    }
    function collect(chunks, data) {
      size += data.length;
      if (size > outputLimit) stop("AugmentWorks CLI exceeded the output limit.");
      else if (!failure) chunks.push(data);
    }
    const onAbort = () => stop("AugmentWorks CLI was cancelled.");
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => stop("AugmentWorks CLI timed out."), timeoutMs);
    timeout.unref();
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    child.on("error", () => { failure ??= "Unable to start the AugmentWorks runtime."; });
    if (stdin) {
      // A failed extraction can close the pipe before all bytes are written.
      child.stdin.on("error", () => { failure ??= "Unable to unpack the AugmentWorks runtime."; });
      child.stdin.end(stdin);
    }
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal.removeEventListener("abort", onAbort);
      if (failure || code === null) {
        reject(new Error(failure ?? "AugmentWorks CLI ended before producing an exit code."));
      } else {
        resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }
    });
  });
}

export async function prepareCli({ cwd, env = process.env, tempDir = tmpdir() }) {
  const bytes = await readFile(archive);
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) {
    throw new Error("The bundled AugmentWorks CLI failed its integrity check.");
  }
  // Decompress in Node so extraction cannot pick up a workspace gzip binary.
  const tarball = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const work = await mkdtemp(join(tempDir, "augmentworks-cli-"));
  const windows = process.platform === "win32";
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const tar = windows ? join(systemRoot, "System32", "tar.exe") : "/usr/bin/tar";
  const executable = join(work, "package", "dist", "index.js");
  const lifecycle = new AbortController();
  const active = new Set();
  const cancel = () => lifecycle.abort(new Error("AugmentWorks CLI was cancelled."));
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);

  async function close() {
    cancel();
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
    await Promise.allSettled(active);
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
  }
  try {
    const extracted = await runChild(tar, ["-xf", "-"], {
      cwd: work, env: windows ? { SystemRoot: systemRoot } : {}, signal: lifecycle.signal, timeoutMs: 30_000, stdin: tarball,
    });
    if (extracted.code !== 0 || !(await stat(executable)).isFile()) {
      throw new Error("Could not extract the bundled AugmentWorks CLI with the runner's system tar.");
    }
  } catch (error) {
    await close();
    throw error;
  }

  const childEnv = cliEnvironment(env);
  async function cli(args, { signal, timeoutMs = 35 * 60 * 1000 } = {}) {
    const combined = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    const run = runChild(process.execPath, [executable, ...args], { cwd, env: childEnv, signal: combined, timeoutMs });
    active.add(run);
    try {
      return await run;
    } finally {
      active.delete(run);
    }
  }
  return { cli, close };
}

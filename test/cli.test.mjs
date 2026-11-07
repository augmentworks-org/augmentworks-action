import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareCli } from "../src/cli.mjs";

test("runs the integrity-checked published CLI without loading caller dependencies", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "augmentworks caller "));
  const tempDir = await mkdtemp(join(tmpdir(), "augmentworks runtime "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const hook = join(cwd, "caller-preload.cjs");
  await writeFile(hook, 'throw Error("Unexpected NODE_OPTIONS from the caller")');

  const { cli, close } = await prepareCli({ cwd, tempDir, env: { ...process.env, NODE_OPTIONS: "--require=" + JSON.stringify(hook) } });
  t.after(close);
  const result = await cli(["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\b0\.4\.2\b/);
  const help = await cli(["test", "--help"]);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /--ci-admission/);
  assert.deepEqual(await readdir(cwd), ["caller-preload.cjs"]);

  await close();
  assert.deepEqual(await readdir(tempDir), []);
  await assert.rejects(cli(["--version"]), /cancelled/);
});

test("selects the upstream CLI with admission support for linked staging runs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "augmentworks linked caller "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { cli, close } = await prepareCli({ cwd, linked: true });
  t.after(close);

  const help = await cli(["test", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--ci-admission <path>/);

  const missingConsent = await cli(["test", "--ci-admission", "admission.json", "--manifest", "saved.json", "--shard", "1", "--headless", "--json"]);
  assert.equal(missingConsent.code, 2);
  assert.match(missingConsent.stderr, /CI_ADMISSION_CONSENT_REQUIRED/);
});

test("rejects a damaged linked CLI before attempting extraction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "augmentworks corrupted runtime "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "vendor"));
  const module = join(root, "src", "cli.mjs");
  await copyFile(new URL("../src/cli.mjs", import.meta.url), module);
  await writeFile(join(root, "vendor", "augmentworks-cli-f4097e989d68.tgz"), "invalid archive");
  const { prepareCli: prepareDamaged } = await import(pathToFileURL(module));
  await assert.rejects(prepareDamaged({ cwd: root, linked: true, tempDir: root }), /failed its integrity check/);
  assert.deepEqual((await readdir(root)).sort(), ["src", "vendor"]);
});

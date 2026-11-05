import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(await readdir(cwd), ["caller-preload.cjs"]);

  await close();
  assert.deepEqual(await readdir(tempDir), []);
  await assert.rejects(cli(["--version"]), /cancelled/);
});

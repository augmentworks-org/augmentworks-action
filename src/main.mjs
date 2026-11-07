import { prepareCli } from './cli.mjs';
import { runHosted } from './hosted.mjs';
import { childEnvironment, InputError, readEvent, readInputs } from './inputs.mjs';
import { createLinkedApi, LinkedApiError } from './linked-api.mjs';
import { freshOutput, runLocal } from './local.mjs';
import { publishResult, writeProvenance } from './reporting.mjs';

const env = process.env;
let runtime;
let result;
let provenancePath = '';
try {
  const options = await readInputs(env);
  const event = await readEvent(env, options.mode, options.githubLink);
  const linked = options.githubLink === 'required';
  if (options.mode === 'hosted') {
    // Validate output paths before a machine key can authorize a billed run.
    try {
      await freshOutput(options.cwd, options.outputDir);
    } catch {
      throw new InputError('Hosted mode needs a fresh output directory inside working-directory, without symlink parents.');
    }
  }
  runtime = await prepareCli({ cwd: options.cwd, env: childEnvironment(env, options), tempDir: env.RUNNER_TEMP, linked });
  const execute = options.mode === 'hosted' ? runHosted : runLocal;
  const admission = linked ? {
    api: createLinkedApi({ apiOrigin: options.apiOrigin, apiKey: options.apiKey, env }),
    tempDir: env.RUNNER_TEMP,
  } : undefined;
  result = await execute({ ...options, cli: runtime.cli, linked: admission });
  provenancePath = await writeProvenance(env, event, options, result);
} catch (error) {
  if (result) {
    result = { ...result, exitCode: result.exitCode || 1, outcome: 'error', detail: 'Assessment finished, but its CI provenance could not be recorded.' };
  } else {
    const input = error instanceof InputError || error instanceof LinkedApiError;
    result = { exitCode: input ? 2 : 1, outcome: 'error', failedChecks: [],
      detail: input ? error.message : 'The Action could not complete. Check runner disk space, system tar, and the configured target.' };
  }
} finally {
  try {
    await runtime?.close();
  } catch {
    result = { ...result, exitCode: result.exitCode || 1, outcome: 'error', detail: 'The runner could not remove its temporary CLI directory.' };
  }
}
try {
  await publishResult(env, result, provenancePath);
  process.exitCode = result.exitCode;
} catch {
  console.error('AugmentWorks could not write GitHub Actions outputs or the job summary.');
  process.exitCode = result.exitCode || 1;
}

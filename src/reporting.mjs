import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fileCommand(name, value) {
  const text = String(value ?? '');
  if (!/[\r\n]/.test(text)) return name + '=' + text + '\n';
  const delimiter = 'aw_' + randomUUID();
  return name + '<<' + delimiter + '\n' + text + '\n' + delimiter + '\n';
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function writeProvenance(env, event, options, result) {
  if (!result.runId) return '';
  const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'augmentworks-run-'));
  const path = join(directory, 'provenance.json');
  await writeFile(path, JSON.stringify({
    schema: 'augmentworks/github-action-run/v1',
    ...event,
    tested_revision: options.testedRevision || null,
    mode: options.mode,
    ...(options.githubLink === 'required' && {
      link_status: result.linkStatus || 'unconfirmed',
      revision_verification: result.revisionVerification || null,
    }),
    run_id: result.runId,
    outcome: result.outcome,
    exit_code: result.exitCode,
    report_url: result.reportUrl || null,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}

export async function publishResult(env, result, provenancePath) {
  const checked = result.failedChecks ?? [];
  const outputs = {
    'outcome': result.outcome,
    'exit-code': result.exitCode,
    'run-id': result.runId,
    'report-path': result.reportPath,
    'report-url': result.reportUrl,
    'failed-checks': JSON.stringify(checked),
    'provenance-path': provenancePath,
    'link-status': result.linkStatus,
    'revision-verification': result.revisionVerification,
  };
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => fileCommand(key, value)).join(''));
  }
  const lines = [
    '### AugmentWorks agent regression tests',
    '',
    '**Outcome** ' + escapeHtml(result.outcome) + ' (exit ' + result.exitCode + ')',
  ];
  if (result.detail) lines.push('', escapeHtml(result.detail));
  if (result.linkStatus === 'linked') lines.push('', 'GitHub job linked to the run. The fixed target’s deployed revision is unknown.');
  if (result.linkStatus === 'unconfirmed') lines.push('', 'GitHub run attachment is unconfirmed.');
  if (result.runId) lines.push('', 'Run <code>' + escapeHtml(result.runId) + '</code>');
  if (checked.length) lines.push('', '**Failed checks**', '', ...checked.map(id => '- <code>' + escapeHtml(id) + '</code>'));
  if (result.reportUrl) lines.push('', '[Open the AugmentWorks report](' + result.reportUrl + ')');
  if (result.reportPath) lines.push('', 'The <code>report-path</code> step output points to the report on this runner.');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  // Only wrapper-generated diagnostics reach Actions logs.
  console.log('AugmentWorks ' + result.outcome + ' (exit ' + result.exitCode + ')' + (result.detail ? '. ' + result.detail : '.'));
}

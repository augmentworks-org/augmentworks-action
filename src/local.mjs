import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const outcomes = ['passed', 'failed', 'inconclusive', 'error'];
const maxReportBytes = 8 * 1024 * 1024; // The CLI's local artifact limit.
const summaryLimit = 20;

function failure(exitCode, detail) {
  return { exitCode: exitCode || 1, outcome: 'error', runId: '', reportPath: '', reportUrl: '', failedChecks: [], detail };
}

function checkLabel(key) {
  if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,149}$/.test(key) && !/aw_api_|gh[pousr]_/i.test(key)) return key;
  return 'check-' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

async function readSummary(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxReportBytes) throw new Error('Invalid report file');
    const report = JSON.parse(await handle.readFile('utf8'));
    if (report.schema_version !== 'AW-LOCAL-RESULT-1' || typeof report.run_id !== 'string' || !/^local_run_[a-f0-9]{32}$/.test(report.run_id) ||
        !outcomes.includes(report.outcome) || !Array.isArray(report.attempts)) throw new Error('Invalid local report');
    const checks = new Set();
    let cleanupFailed = false;
    for (const attempt of report.attempts) {
      if (!Array.isArray(attempt.assertions)) throw new Error('Invalid assertions');
      if (attempt.cleanup_status === 'failed') cleanupFailed = true;
      for (const assertion of attempt.assertions) {
        if (typeof assertion.key !== 'string' || typeof assertion.passed !== 'boolean') throw new Error('Invalid assertion result');
        if (!assertion.passed) checks.add(checkLabel(assertion.key));
      }
    }
    return { outcome: report.outcome, runId: report.run_id, checks: [...checks], cleanupFailed };
  } finally {
    await handle.close();
  }
}

export async function freshOutput(cwd, requested) {
  const output = resolve(cwd, requested || join('.augmentworks', 'action-' + randomUUID()));
  const subpath = relative(cwd, output);
  if (!subpath || subpath === '..' || subpath.startsWith('..' + sep) || isAbsolute(subpath)) {
    throw new Error('Choose a report directory inside the working directory.');
  }
  // A PR checkout can contain symlinks. The demo also accepts nested output paths.
  let current = cwd;
  for (const part of subpath.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info) break;
    if (current === output || !info.isDirectory()) throw new Error('Choose an unused report directory without symlink parents.');
  }
  return output;
}

async function runDemo(cli, cwd, output) {
  const result = await cli(['demo', '--output-dir', output, '--json'], { cwd });
  if (result.code !== 0) return failure(result.code, 'The local refund demo could not finish.');
  try {
    const demo = JSON.parse(result.stdout);
    const { faulty, corrected } = demo.runs;
    if (demo.schema_version !== 'AW-DEMO-SUMMARY-1' || !demo.ok || !demo.cleanup?.ok ||
        faulty.exit_code !== 10 || corrected.exit_code !== 0) throw new Error('Unexpected demo result');
    // Only open the known reports under the requested directory.
    const reportPath = join(output, 'passing', 'report.json');
    const before = await readSummary(join(output, 'failing', 'report.json'));
    const after = await readSummary(reportPath);
    if (before.outcome !== 'failed' || after.outcome !== 'passed' || !before.checks.length ||
        before.cleanupFailed || after.cleanupFailed) throw new Error('Unexpected demo reports');
    return {
      exitCode: 0, outcome: 'passed', runId: after.runId, reportPath, reportUrl: '', failedChecks: [],
      detail: 'The faulty agent failed ' + before.checks.length + ' checks. The corrected agent passed. Both runs are saved in the demo report directory.',
    };
  } catch {
    return failure(1, 'The demo did not produce a valid failure and recovery report.');
  }
}

export async function runLocal({ mode, cwd, config = 'augmentworks.yaml', packet, outputDir, cli }) {
  if (!['local', 'demo'].includes(mode)) return failure(2, 'Unknown local assessment mode.');
  let output;
  try {
    output = await freshOutput(cwd, outputDir);
  } catch {
    return failure(2, 'Choose a fresh report directory inside the working directory without symlink parents.');
  }
  if (mode === 'demo') return runDemo(cli, cwd, output);
  if (!config || !packet) return failure(2, 'Local mode requires a config and local packet.');

  const result = await cli(['test', '--local', '-c', config, '--packet', packet, '--output-dir', output], { cwd });
  if (![0, 5, 6, 10, 130].includes(result.code)) {
    return failure(result.code, 'Local assessment could not start. Check the configuration, packet, and target environment.');
  }
  const reportPath = join(output, 'report.json');
  let report;
  try {
    report = await readSummary(reportPath);
  } catch {
    return failure(result.code, 'The CLI did not produce a readable local assessment report.');
  }
  const expected = report.cleanupFailed ? 6 : ({ passed: 0, failed: 10, inconclusive: 10, error: 5 })[report.outcome];
  if (result.code !== 130 && result.code !== expected) {
    return failure(result.code, 'The CLI status and local report disagree.');
  }
  let detail;
  if (result.code === 130) detail = 'Local assessment interrupted.';
  else if (report.cleanupFailed) detail = 'Target cleanup failed. Inspect the private report before retrying.';
  else if (report.checks.length > summaryLimit) detail = 'Showing the first ' + summaryLimit + ' failed check IDs.';
  return {
    exitCode: result.code, outcome: result.code === 130 || report.cleanupFailed ? 'error' : report.outcome,
    runId: report.runId, reportPath, reportUrl: '', failedChecks: report.checks.slice(0, summaryLimit), detail,
  };
}

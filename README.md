# AugmentWorks Agent Regression Tests

Run a policy test against your HTTP agent from GitHub Actions. A failed check fails the step and appears in the job summary. Local mode writes JSON, HTML, and JUnit evidence on the runner. Hosted mode returns a link to the AugmentWorks run and can compare it against a pinned baseline.

## Try the refund demo

Save this as `.github/workflows/agent-evals.yml` and use **Run workflow**. The demo starts a fictional agent on loopback, catches an $80 refund that exceeds a $50 limit, then verifies the corrected agent. The demo step passes when it observes both outcomes and completes cleanup. It needs no account, API key, model, or application checkout.

```yaml
name: Try AugmentWorks
on: workflow_dispatch
permissions: {}
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: augmentworks-org/augmentworks-action@main
        with:
          mode: demo
```

The examples use `@main` for an initial trial. Pin the Action to a reviewed full commit SHA before putting it in a release workflow. It ships the exact published `@augmentworks/cli@0.4.2` archive and checks its integrity before running it. GitHub provides the Node 24 action runtime. Self-hosted runners need Node 24 action support and system `tar`. The Action itself requires no npm installation or build step.

## Test your own agent

Commit your target's `augmentworks.yaml` and a local packet, then run the following workflow. For a starting point, copy [the FAQ config](fixtures/faq/augmentworks.yaml) and [test packet](fixtures/faq/packet.json) into an `evals/` directory in **your application repo**. Edit the HTTP mapping, question and expected policy for your agent. Configure the `CHATBOT_BASE_URL` repository variable and `CHATBOT_API_KEY` secret for a target you operate and are authorized to test.

```yaml
name: Test agent policy
on: [pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  policy:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Check the return window
        id: eval
        uses: augmentworks-org/augmentworks-action@main
        env:
          CHATBOT_BASE_URL: ${{ vars.CHATBOT_BASE_URL }}
          CHATBOT_API_KEY: ${{ secrets.CHATBOT_API_KEY }}
        with:
          mode: local
          working-directory: evals
          config: augmentworks.yaml
          packet: packet.json
```

For a PR-specific verdict, start the checked-out agent on the runner before the Action or point the config at that revision's preview deployment. A fixed staging URL tests whatever build is actually running there. The [repository's caller workflow](.github/workflows/test.yml) starts the [included HTTP fixture](fixtures/faq/server.mjs), catches a seven-day reply, and runs the same packet again after changing the reply to thirty days.

Local mode uses no AugmentWorks credits. Your target can still invoke its model or perform configured operations. Give secret-bearing jobs and write-capable target credentials only to trusted revisions. The workflow above skips fork PRs; keep secret-bearing jobs off `pull_request_target`.

## Run a hosted assessment

Save a suite revision in your workspace and set `selection.suite_revision_id` in the assessment file. Keep the target config and assessment in the caller repo. Use a machine key scoped to that workspace and the hosted CI permissions in the [CLI recipe](https://github.com/augmentworks-org/augmentworks-cli/blob/main/docs/examples/github-actions-hosted.yml). Set the key as a repository secret and the expected workspace UUID as a repository variable. This example runs on demand with a ceiling of 30 credits.

```yaml
name: Hosted agent assessment
on: workflow_dispatch
permissions:
  contents: read
jobs:
  assess:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Assess the configured target
        id: eval
        uses: augmentworks-org/augmentworks-action@main
        env:
          CHATBOT_BASE_URL: ${{ vars.CHATBOT_BASE_URL }}
          CHATBOT_API_KEY: ${{ secrets.CHATBOT_API_KEY }}
        with:
          mode: hosted
          working-directory: evals
          config: augmentworks.yaml
          assessment: augmentworks.assessment.yaml
          api-key: ${{ secrets.AUGMENTWORKS_API_KEY }}
          workspace-id: ${{ vars.AUGMENTWORKS_WORKSPACE_ID }}
          max-credits: '30'
          # Optional: UUID of a previously pinned baseline
          baseline-id: ${{ vars.AUGMENTWORKS_BASELINE_ID }}
```

The Action checks workspace identity, requests an estimate, and starts at most one run per invocation within the supplied ceiling. It waits for that run, checks its report, and evaluates the baseline gate if configured. A green hosted step requires a passing candidate and, when supplied, a passing gate. Pending grading and operating errors fail the step. If grading is incomplete or a request is interrupted, use the original run ID or the CLI's recovery state before starting another assessment.

## Inputs

| Input | Behavior |
| --- | --- |
| `mode` | `local` (default), `hosted`, or `demo`. |
| `working-directory` | Caller directory containing the test files. Defaults to the workspace. |
| `config` | HTTP target config, relative to the working directory. Defaults to `augmentworks.yaml`. |
| `packet` | Required in local mode. Use a local JSON packet, a directory containing `packet.json`, or the bundled `support-refunds-starter@0.1.0` for its matching workflow target. |
| `assessment` | Hosted assessment selection. Defaults to `augmentworks.assessment.yaml`. |
| `output-dir` | Fresh report directory under the working directory. The default creates a unique path under `.augmentworks/`. |
| `api-key` | Hosted machine key. Can also be provided through `AUGMENTWORKS_API_KEY`. |
| `workspace-id` | Expected hosted workspace UUID. Can also be provided through `AUGMENTWORKS_WORKSPACE_ID`. |
| `max-credits` | Required in hosted mode. Nonnegative integer spending ceiling for this invocation. |
| `baseline-id` | Optional pinned hosted baseline UUID. Can also be provided through `AUGMENTWORKS_BASELINE_ID`. |
| `tested-revision` | Optional full commit SHA for the build actually serving the target, supplied by your build or deployment workflow. |

## Outputs and evidence

| Step output | Value |
| --- | --- |
| `exit-code` | Numeric Action result. `0` means success. A failed required check can return `10`. |
| `outcome` | Passed, failed, incomplete, inconclusive, or error verdict, depending on mode and evidence. Values are lowercase. |
| `run-id` | ID of the local or hosted run, when available. Demo returns the corrected run's ID. |
| `report-path` | Absolute path on the runner to local `report.json`, or a sanitized `hosted-summary.json` for a hosted run. |
| `report-url` | Private dashboard URL for a hosted run, when available. |
| `failed-checks` | JSON array of failed check identifiers available to the Action. An empty list can also mean grading was incomplete; use the outcome and exit code for the verdict. |
| `provenance-path` | Runner-local JSON associating the result with its GitHub context, including the event SHA, PR number when available, and optional explicitly supplied target revision. |

Access outputs as `${{ steps.eval.outputs.run-id }}` with the step ID shown above. Use `if: always()` on a later step if you need the result after a failure. Evidence remains on the runner unless your workflow uploads it. Local reports can include conversations and observed state. Restrict artifact access and retention if you choose to upload them.

Use the hosted run ID or dashboard link to look up a result in AugmentWorks. The provenance file records GitHub context in CI; server-side discovery by PR number is not part of this Action.

## Development

Run `node --test` on Node 24. The [CI workflow](.github/workflows/test.yml) also calls the Action itself through `uses: ./` and checks a failure followed by a passing run. [Vendored CLI provenance and update instructions](vendor/README.md) · [Apache 2.0 license](LICENSE)

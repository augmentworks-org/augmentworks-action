# Rehearse a linked assessment on staging

Use a public staging fixture with a protected branch and a fixed HTTPS agent target you control. The platform checks the repository and owner IDs, the workflow path and commit, and the single job and check run for the current attempt. The fixture needs one directly invoked job with the same job ID and display name. Omit reusable workflows, matrices and custom deployment environments.

1. Deploy the platform admission, recovery and attachment routes and their database migrations to an isolated staging project at `https://staging.augmentworks.ai`. Create a dedicated workspace machine key in the staging workspace with the normal hosted CI read and execution permissions. This first version uses an operator-provisioned binding.
2. Commit a CLI target configuration and a saved-suite assessment or compiled manifest. The target must use the exact HTTPS origin approved by the policy. Get the immutable suite revision and shard ID from the compiled selection.
3. Copy the workflow below. Replace the Action placeholder with a reviewed **full commit SHA** containing linked support. Use the target variables and staging-only secrets referenced by your config. Set the repository variables before the rehearsal and keep the job’s credit ceiling within the approved budget.
4. Merge the workflow to the protected branch. Use the pinned CLI to estimate the staging shard. Enroll its execution plan digest, the resulting workflow SHA, branch, path, immutable repository and owner IDs, job, suite revision, target and cap. Set the returned binding ID as a repository variable and enable GitHub CI on the staging deployment. Use the resulting push run for the rehearsal. Rerun that same job if its first attempt preceded enrollment.
5. Verify that the step outputs a run ID, a staging report URL, `link-status=linked` and `revision-verification=unknown`. Rerun the **same GitHub workflow run** on a clean runner. Check that it recovers the same AugmentWorks run ID and that the staging ledger shows a single run reservation. A new push has its own commit SHA and requires a fresh reviewed binding under the current policy. Exit 11 means grading or execution is incomplete. Inspect the original run before making a release decision.

```yaml
name: Linked staging assessment
on:
  push:
    branches: [main]
permissions: {}
jobs:
  policy:
    name: policy
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          persist-credentials: false
      - name: Run the saved staging shard
        id: eval
        uses: augmentworks-org/augmentworks-action@REPLACE_WITH_REVIEWED_40_HEX_COMMIT_SHA
        env:
          CHATBOT_BASE_URL: ${{ vars.STAGING_AGENT_ORIGIN }}
          CHATBOT_API_KEY: ${{ secrets.STAGING_AGENT_KEY }}
        with:
          mode: hosted
          github-link: required
          platform-environment: staging
          working-directory: evals
          config: augmentworks.yaml
          assessment: augmentworks.assessment.yaml
          shard: ${{ vars.STAGING_SHARD_ID }}
          api-key: ${{ secrets.STAGING_AUGMENTWORKS_API_KEY }}
          workspace-id: ${{ vars.STAGING_WORKSPACE_ID }}
          binding-id: ${{ vars.STAGING_BINDING_ID }}
          suite-revision-id: ${{ vars.STAGING_SUITE_REVISION_ID }}
          max-credits: '30'
```

The platform narrows the requested ceiling to the approved maximum. An authentication failure, changed request or unconfirmed attachment fails the step. Retry the original GitHub run after resolving the cause. The job needs only OIDC and read access to its checkout. The platform holds the admission across attempts.

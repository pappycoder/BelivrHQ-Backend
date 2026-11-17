# Automatic pull requests after CI

The `pull-requests` job waits for the required aggregate CI check. On a successful same-repository feature-branch push, it creates a pull request into each of `main` and `staging` when there are changes. Existing open PRs for the same head/base are reused. Main/staging pushes and fork/PR runs do not create PRs. The script verifies the checked commit is still the branch head before each creation.

Only this job requests `pull-requests: write`; ordinary CI retains read-only permissions. It uses the job-scoped GitHub token and no deployment credential. Review and merge stay subject to protected-branch rules. There are no approval or merge steps.

Activation is pending operator approval of GitHub’s combined “Allow GitHub Actions to create and approve pull requests” repository setting. GitHub exposes PR creation and review approval through one setting, so enabling it grants broader capability to other suitably permissioned workflows. Automatic approval review rejected changing this setting without explicit operator approval. No hosted setting has been changed.

After that approval, enable the combined setting in each repository and set the repository Actions variable `AUTOMATIC_RELEASE_PRS` to the exact value `true`. Until then, the optional PR job stays skipped so missing PR-creation permissions cannot fail otherwise valid CI. A subsequent feature-branch push or rerun of a successful push run can create the PRs. Do not enable automatic merging as part of this rollout.

GitHub may place workflows triggered by token-created PRs in an approval-required state. Approve those runs in GitHub when required; this implementation does not introduce a personal access token or GitHub App credential to bypass that platform behavior.

Validation: `npm run release:test` includes the PR evidence, stale-head, duplicate/race, failed-check, repository-boundary and job-permission regressions.

References: [repository Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token).

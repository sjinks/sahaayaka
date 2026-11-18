# Sahaayaka

A Probot GitHub App that combines GitHub Actions, external check runs, and
commit statuses into one pull request check named **Sahaayaka**. Require that
check in GitHub to gate merges while letting individual workflows run
conditionally.

## Set up the GitHub App

1. Register a GitHub App with the repository permissions and webhook events in
   [`app.yml`](app.yml). Enable webhooks and set a webhook secret. For local
   development, use a Smee channel URL as the GitHub App's webhook URL. For a
   deployed app, use its public HTTPS URL ending in `/api/github/webhooks` by
   default. [GitHub App webhook setup](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
2. Generate a private key in the app settings, record the numeric App ID, and
   install the app on the repositories it should monitor.
3. Start Sahaayaka locally or [deploy it with systemd](#deploy-with-systemd).

For an existing GitHub App, update the settings in GitHub and have an
installation owner approve any new permissions.

## Run locally

Use Node.js 24 or newer. Run `npm ci`, then copy
[`.env.example`](.env.example) to `.env` if you haven't already created one.
Set `APP_ID`, `PRIVATE_KEY_PATH`, and `WEBHOOK_SECRET` using your app settings.
`PRIVATE_KEY` can supply the key directly. If you use Smee, set
`WEBHOOK_PROXY_URL` to the same channel URL you entered in GitHub.

```sh
npm run build
npm start
```

`npm run dev` runs TypeScript directly. `npm run check` builds, lints, and tests.
The app listens on `127.0.0.1:4500` by default. Use `HOST` and `PORT` to
override the listener address.

For local testing, set `REPOSITORY_ALLOWLIST=owner/test-repository` to limit
discovery, polling, and webhook processing to that repository. The setting
accepts comma-separated `owner/repository` names. Omit it to process all
repositories accessible to the app.

## Deploy with systemd

Run `npm ci` and `npm run compile` with Bun 1.4 or newer on Linux for the
deployment architecture. The build produces `./sahaayaka`. Install it as
`/opt/sahaayaka/sahaayaka`, the path used by the
[`sahaayaka.service`](systemd/sahaayaka.service) unit.

```sh
sudo install -d -m 0755 /opt/sahaayaka
sudo install -m 0755 ./sahaayaka /opt/sahaayaka/sahaayaka
sudo install -d -m 0700 /etc/sahaayaka
```

Create these root-owned files with mode `0600` before starting the service.

| File                             | Contents                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `/etc/sahaayaka/sahaayaka.env`   | `APP_ID=<numeric app ID>` and any optional settings such as `REPOSITORY_ALLOWLIST`. |
| `/etc/sahaayaka/private-key.pem` | The GitHub App private key.                                                         |
| `/etc/sahaayaka/webhook-secret`  | The webhook secret from the GitHub App settings, with an optional final newline.    |

systemd passes both secrets as credential files and creates the service
account and the persistent SQLite state directory at `/var/lib/sahaayaka`.
`sahaayaka.env` supplies the service environment. The compiled binary skips
automatic loading of local `.env` files.
`WEBHOOK_SECRET_FILE` takes precedence over `WEBHOOK_SECRET` when set.

```sh
sudo install -m 0644 systemd/sahaayaka.service /etc/systemd/system/sahaayaka.service
sudo systemctl daemon-reload
sudo systemctl enable --now sahaayaka.service
sudo journalctl -u sahaayaka.service -n 50
curl --fail http://127.0.0.1:4500/readyz
```

Forward the public HTTPS webhook endpoint to
`http://127.0.0.1:4500/api/github/webhooks` through your reverse proxy.
`/readyz` returns 200 after initial GitHub discovery. If you increase
`SHUTDOWN_TIMEOUT_MS` to 40000 or higher, set `TimeoutStopSec` in a systemd
drop-in to allow more time than the app's shutdown timeout.

## Require the aggregate check

Verify that Sahaayaka publishes a passing check on a test PR. Then, in branch
protection or a ruleset, require **Sahaayaka** and select your GitHub App as the
expected source. Once the aggregate check is required, remove the individual CI
checks you want it to replace.
[Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

Sahaayaka discovers existing open pull requests at startup, on installation
and repository access changes, and every five minutes. Merge queues
(`merge_group`) are unsupported.

## Repository policy

Configuration is optional. Sahaayaka applies built-in defaults, then owner-wide
defaults, then repository overrides. Each layer overrides individual keys.

- Put owner-wide defaults in `.github/sahaayaka.json` on the default branch of
  `OWNER/.github`. For example, `{"approve": true}` in `sjinks/.github` enables
  automatic approval by default for repositories owned by `sjinks`. The GitHub
  App needs read access to the defaults repository.
- Put repository overrides in `.github/sahaayaka.json` on the PR's **base
  branch**. The app reads the file from the base commit it evaluates. A
  repository can set `"approve": false` or omit the key to inherit its default.
- Arrays replace the entire inherited value. For example, `"requiredChecks": []`
  clears inherited requirements.

All policy keys are available at both levels. A missing file contributes no
settings. An invalid file, including one with unknown keys, fails evaluation.

This example expects a `test` job for source, test, dependency, or GitHub configuration
changes and a `lint` job for TypeScript or ESLint configuration changes. A
docs-only PR can pass when no CI runs and no requirement applies.

```json
{
    "approve": false,
    "commentOnApproval": true,
    "settleSeconds": 30,
    "timeoutSeconds": 3600,
    "allowEmpty": true,
    "allowedConclusions": ["success", "skipped", "neutral"],
    "requiredChecks": [
        {
            "name": "test",
            "paths": ["src/**", "test/**", "package.json", "package-lock.json", ".github/**"]
        },
        {
            "name": "lint",
            "paths": ["**/*.ts", "eslint.config.mjs"]
        }
    ]
}
```

- The aggregate includes the latest CI results selected for the PR, even when
  `requiredChecks` is empty. A failed, cancelled, timed-out, or otherwise
  unapproved completed check fails the next evaluation.
- `requiredChecks` keeps the gate pending when an applicable check is missing.
  Pending or missing CI fails at `timeoutSeconds` (default 3600). A requirement
  applies if at least one changed path matches `paths` and is outside
  `ignorePaths`. Omit `paths` to match any changed path before applying
  `ignorePaths`. Both names of a renamed file count.
- Use the exact GitHub job name or external check name. Use
  `Workflow: <workflow name>` for a workflow result and the context name for a
  commit status. You can pin a requirement to a producing GitHub App with
  `appId` when the result has an App ID.
- `allowEmpty` defaults to `false`. Set it to `true` to let a PR pass after
  settling when it has zero observed checks and zero applicable requirements.
- `allowedConclusions` defaults to `success`, `skipped`, and `neutral`. Use only
  `success` if skipped or neutral jobs should block merging.
- `settleSeconds` sets the quiet period after input changes (default 30).
  List any job that must run in `requiredChecks` so a delayed start keeps the
  gate pending even after the quiet period.

Match these path rules to your workflow triggers. GitHub Actions and external
providers decide when CI runs. Path rules only decide which missing results
Sahaayaka waits for.

## Ordering and recovery

Each evaluation fetches current GitHub state. Actions runs are grouped by workflow,
event, source repository, and branch; the largest run number and its current
attempt determine the authoritative execution. Jobs use GitHub's `latest` filter,
so partial reruns retain successful jobs. GitHub may copy a retained successful
job under a new ID; workflow identity and attempt establish execution order.
External check runs select the highest
check-run ID per producer/name; legacy statuses select the highest status ID per
context. A late completion of an older execution cannot replace a newer failure.
That ordering guarantee applies to Actions runs and providers that create check
runs in execution order. Legacy commit statuses expose no execution identity:
their providers must prevent an older execution from posting a newer status for
the same context. Sahaayaka follows GitHub's most recently posted status.

Sahaayaka inspects the head commit and includes the test-merge commit when
its parents match the current base branch tip and PR head. The aggregate is
published on the head commit. When reconciliation notices a base branch
update, it reloads policy and evaluates the available CI results. Require
up-to-date branches in GitHub if merging must depend on CI against the latest
base.

After a completed result, returning to pending creates a new check run with the
same required name. GitHub retains a completed conclusion when only its status
is updated. Sahaayaka recovers interrupted creations by external ID.

One serialized worker handles webhook and polling updates, and generation checks
discard evaluations invalidated while awaiting GitHub. The PR revision is checked
again before publishing a result.

Tracking data survives restarts in SQLite. A separate SQLite exclusive lock
prevents two processes using the same database from publishing concurrently and
is released by the OS after a crash. Run **one instance per GitHub App** with one
durable local database; separate databases or network filesystems do not provide
cross-instance coordination. Startup and periodic reconciliation recover tracked
PRs from missed webhooks and interrupted evaluations.
Removal, suspension, and deletion retire affected targets immediately and
invalidate evaluations in flight. Access state survives restarts; successful
authoritative discovery can reactivate targets after access is restored. A
failed or incomplete scan preserves known access, and stale scan results cannot
retire PRs or access identities created by newer events.
Webhook delivery IDs are deduplicated for seven days, in the same SQLite
transaction as their tracking updates.

`DATABASE_PATH` defaults to `./data/sahaayaka.sqlite`.
`RECONCILE_INTERVAL_MS` defaults to 30000 (minimum 1000). Webhook work takes
priority over polling, with a background turn after eight webhook turns to
prevent starvation. Work is deduplicated per PR. Failed requests use bounded
exponential backoff; GitHub rate-limit responses honor `Retry-After` and primary
quota reset times through a shared cooldown for discovery and reconciliation.
Rate limiting delays evaluation without publishing a false CI failure or
withdrawing an approval solely because GitHub is temporarily unavailable.
Logs identify the affected PR target.

GitHub API reads, webhook delivery, and merges are not one atomic transaction.
There is an unavoidable interval between a new CI run starting and the app
learning about it and changing a previously green check. Quiet periods and
required expectations reduce this risk.

External providers must create a new check-run ID for each new execution. A
provider that updates the same check-run ID out of execution order cannot be
disambiguated by this app. Check names should uniquely identify a logical check
within each producing app.

## Operations

`GET /healthz` reports process liveness. `GET /readyz` returns 503 until initial
discovery succeeds, while draining, if SQLite is unavailable, or if the last
successful discovery is older than `READINESS_MAX_DISCOVERY_AGE_MS` (default
900000). A rate-limit cooldown alone does not fail liveness or readiness;
discovery freshness still applies. `GET /metrics` exposes Prometheus queue,
reconciliation, discovery, cooldown, storage, and retention metrics without
repository names or credentials. These endpoints also accept HEAD. Keep them
on an internal network or restrict access at your reverse proxy.

Closed PR records are retained for `CLOSED_TARGET_RETENTION_DAYS` (default 30).
Cleanup runs at startup and every minute, deleting at most 1000 expired targets
and 1000 expired delivery IDs per pass. Open targets and installation/repository
access records are preserved. Existing closed records receive a full retention
period when upgrading. Reopening a target clears its previous close timestamp.

SIGTERM and SIGINT stop incoming connections, drain accepted webhook requests
and current work, and close SQLite. The app exits with an error if shutdown
exceeds `SHUTDOWN_TIMEOUT_MS` (default 30000).

If startup reports `database is locked`, check for an existing Sahaayaka process
using the same `DATABASE_PATH`. The publisher holds an exclusive lock on the
adjacent `.lock` file for its lifetime.

## Optional approval

Set `approve: true` and grant the app **Pull requests: write**. Successful,
non-draft PRs receive an automated approving review tied to the evaluated head
commit. The app records its review ID and dismisses its approval when the gate
stops passing or the revision changes. It does not request changes or merge PRs.
Repository rules determine whether a bot approval satisfies review requirements.
The required aggregate check remains the CI merge gate.

Set `"commentOnApproval": false` in owner-wide defaults or repository policy to
submit new approving reviews without the message. The setting defaults to
`true`.

Enable GitHub's stale-approval dismissal for new commits as well. Review dismissal
must be permitted for the app; a failure to dismiss fails the CI gate. Keep
approval disabled when a human review is required by policy.

## License

[MIT](LICENSE)

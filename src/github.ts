import { type Policy, type PolicyOverrides, policyOverridesSchema, policySchema } from './policy.js';
import type { Check, Octokit, Outcome, Repository, Snapshot, Target } from './types.js';

export const CHECK_NAME = 'Sahaayaka';
type CheckState = Outcome['state'] | 'cancelled';

export interface Pull {
    headSha: string;
    baseSha: string;
    mergeSha: string | null;
    draft: boolean;
    closed: boolean;
    changedFiles: number;
}

export interface Gateway {
    pull(target: Target): Promise<Pull>;
    policy(target: Target): Promise<Policy>;
    snapshot(target: Target, pull: Pull): Promise<Snapshot>;
    create(target: Target): Promise<number>;
    publish(target: Target, state: CheckState, summary: string): Promise<number>;
    cancelPendingChecks(target: Target, stillClosed: () => boolean): Promise<void>;
    approve(target: Target, commentOnApproval: boolean): Promise<number>;
    dismiss(target: Target): Promise<void>;
}

function numericId(id: number | bigint): number {
    const value = Number(id);
    if (!Number.isSafeInteger(value)) {
        throw new Error('GitHub ID exceeds the supported safe integer range.');
    }
    return value;
}

type WorkflowRun = Awaited<
    ReturnType<Octokit['rest']['actions']['listWorkflowRunsForRepo']>
>['data']['workflow_runs'][number];
type CheckRun = Awaited<ReturnType<Octokit['rest']['checks']['listForRef']>>['data']['check_runs'][number];

function selectRuns(runs: WorkflowRun[]): Map<string, WorkflowRun> {
    const latestRuns = new Map<string, WorkflowRun>();
    for (const run of runs) {
        const key = `${run.workflow_id}:${run.event}:${run.head_repository.id}:${run.head_branch}`;
        const prior = latestRuns.get(key);
        if (
            !prior ||
            run.run_number > prior.run_number ||
            (run.run_number === prior.run_number && (run.run_attempt ?? 1) > (prior.run_attempt ?? 1))
        ) {
            latestRuns.set(key, run);
        }
    }
    return latestRuns;
}

export class GitHub implements Gateway {
    private login: string | undefined;

    public constructor(
        private readonly octokit: Octokit,
        private readonly appId: number,
    ) {}

    public async pull(target: Target): Promise<Pull> {
        const { data } = await this.octokit.rest.pulls.get({ ...this.repo(target), pull_number: target.pullNumber });
        const pull: Pull = {
            headSha: data.head.sha,
            baseSha: data.base.sha,
            mergeSha: data.merge_commit_sha,
            draft: data.draft ?? false,
            closed: data.state === 'closed',
            changedFiles: data.changed_files,
        };
        if (pull.closed) {
            return pull;
        }
        // PR base.sha can remain at an older snapshot after a base-branch push.
        // Read the branch itself so policy and evaluation identity use its tip.
        const { data: base } = await this.octokit.rest.repos.getBranch({ ...this.repo(target), branch: data.base.ref });
        let mergeSha = data.merge_commit_sha;
        if (mergeSha !== null) {
            const { data: merge } = await this.octokit.rest.git.getCommit({
                ...this.repo(target),
                commit_sha: mergeSha,
            });
            if (
                merge.parents.length !== 2 ||
                merge.parents[0]?.sha !== base.commit.sha ||
                merge.parents[1]?.sha !== data.head.sha
            ) {
                mergeSha = null;
            }
        }
        return {
            ...pull,
            baseSha: base.commit.sha,
            mergeSha,
        };
    }

    public async policy(target: Target): Promise<Policy> {
        const [ownerDefaults, repositoryPolicy] = await Promise.all([
            this.readPolicy({ owner: target.owner, repo: '.github' }),
            this.readPolicy(this.repo(target), target.baseSha),
        ]);

        return policySchema.parse({ ...ownerDefaults, ...repositoryPolicy });
    }

    private async readPolicy(repository: Repository, ref?: string): Promise<PolicyOverrides> {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                ...repository,
                path: '.github/sahaayaka.json',
                ...(ref === undefined ? {} : { ref }),
            });
            if (!('content' in data) || data.encoding !== 'base64') {
                throw new Error('Policy must be a JSON file.');
            }
            return policyOverridesSchema.parse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
        } catch (error) {
            if (error instanceof Error && 'status' in error && error.status === 404) {
                return {};
            }
            throw error;
        }
    }

    public async snapshot(target: Target, pull: Pull): Promise<Snapshot> {
        const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
            ...this.repo(target),
            pull_number: target.pullNumber,
            per_page: 100,
        });
        if (files.length !== pull.changedFiles) {
            throw new Error('GitHub did not return the complete changed-file list; refusing to evaluate path rules.');
        }
        const refs = [...new Set([target.headSha, target.mergeSha].filter((sha): sha is string => sha !== null))];
        const inputs = await Promise.all(
            refs.map(async (ref) => {
                const [runs, checkRuns] = await Promise.all([
                    this.octokit.paginate(this.octokit.rest.actions.listWorkflowRunsForRepo, {
                        ...this.repo(target),
                        head_sha: ref,
                        per_page: 100,
                    }),
                    this.octokit.paginate(this.octokit.rest.checks.listForRef, {
                        ...this.repo(target),
                        ref,
                        filter: 'all',
                        per_page: 100,
                    }),
                ]);
                if (runs.length >= 1000) {
                    throw new Error('Workflow-run search reached GitHub’s result limit.');
                }
                return { ref, runs, checkRuns };
            }),
        );
        // Actions may identify a PR run by its source SHA while its check runs
        // belong to the synthetic merge SHA. Resolve suites across both refs.
        const runs = inputs
            .flatMap((input) => input.runs)
            .filter(
                (run) => !run.pull_requests?.length || run.pull_requests.some((pr) => pr.number === target.pullNumber),
            );
        const allChecks = inputs.flatMap((input) => input.checkRuns);
        const suites = new Set(runs.map((run) => run.check_suite_id));
        const checks = await this.workflowChecks(target, runs, allChecks);
        for (const input of inputs) {
            checks.push(...this.externalChecks(input.ref, input.checkRuns, suites));
            // eslint-disable-next-line no-await-in-loop
            checks.push(...(await this.statusChecks(target, input.ref)));
        }
        return {
            checks,
            files: files.flatMap((file) =>
                file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
            ),
        };
    }

    private async workflowChecks(target: Target, runs: WorkflowRun[], allChecks: CheckRun[]): Promise<Check[]> {
        const repo = this.repo(target);
        const latestRuns = selectRuns(runs);
        const checks: Check[] = [];
        for (const [key, run] of latestRuns) {
            const appId = allChecks.find((check) => check.check_suite?.id === run.check_suite_id)?.app?.id ?? null;
            checks.push({
                key: `workflow:${key}`,
                name: `Workflow: ${run.name ?? run.path}`,
                appId,
                status: run.status ?? 'queued',
                conclusion: run.conclusion,
                url: run.html_url,
            });
            // The workflow result blocks during reruns; latest jobs also retain
            // successful jobs that were not selected for a partial rerun.
            // eslint-disable-next-line no-await-in-loop
            const jobs = await this.octokit.paginate(this.octokit.rest.actions.listJobsForWorkflowRun, {
                ...repo,
                run_id: run.id,
                filter: 'latest',
                per_page: 100,
            });
            for (const job of jobs) {
                checks.push({
                    key: `job:${key}:${job.name}`,
                    name: job.name,
                    appId,
                    status: job.status,
                    conclusion: job.conclusion,
                    url: job.html_url ?? run.html_url,
                });
            }
        }
        return checks;
    }

    private async listOwnChecks(target: Target): Promise<CheckRun[]> {
        return this.octokit.paginate(this.octokit.rest.checks.listForRef, {
            ...this.repo(target),
            ref: target.headSha,
            app_id: this.appId,
            filter: 'all',
            per_page: 100,
        });
    }

    public async cancelPendingChecks(target: Target, stillClosed: () => boolean): Promise<void> {
        const checks = await this.listOwnChecks(target);
        const externalIdPrefix = `${target.key}:${target.headSha}:`;
        const pending = checks.filter(
            (check) =>
                check.name === CHECK_NAME &&
                check.status !== 'completed' &&
                check.external_id?.startsWith(externalIdPrefix) === true,
        );
        for (const check of pending) {
            if (!stillClosed()) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.publish(
                { ...target, checkId: numericId(check.id) },
                'cancelled',
                'The pull request closed before CI evaluation finished.',
            );
        }
    }

    public async create(target: Target, pendingOnly = false): Promise<number> {
        // Recover a check created immediately before a crash, avoiding duplicates.
        const checks = await this.listOwnChecks(target);
        const externalId = `${target.key}:${target.headSha}:${target.baseSha}`;
        const existing = checks
            .filter((check) => check.name === CHECK_NAME && check.external_id === externalId)
            .sort((a, b) => (a.id > b.id ? -1 : 1))[0];
        if (existing && (!pendingOnly || existing.status !== 'completed')) {
            return numericId(existing.id);
        }
        const { data } = await this.octokit.rest.checks.create({
            ...this.repo(target),
            name: CHECK_NAME,
            head_sha: target.headSha,
            external_id: externalId,
            status: 'in_progress',
            output: { title: 'Evaluating CI', summary: 'Waiting for CI results.' },
        });
        return numericId(data.id);
    }

    public async publish(target: Target, state: CheckState, summary: string): Promise<number> {
        if (target.checkId === null) {
            throw new Error('Cannot publish without an aggregate check.');
        }
        let checkId = target.checkId;
        if (state === 'pending') {
            const { data } = await this.octokit.rest.checks.get({ ...this.repo(target), check_run_id: checkId });
            if (data.status === 'completed') {
                // GitHub retains a completed conclusion when PATCH only changes
                // status, and rejects null conclusions. Start a fresh check run.
                checkId = await this.create(target, true);
            }
        }
        const titles = {
            success: 'CI passed',
            failure: 'CI failed',
            pending: 'Waiting for CI',
            cancelled: 'CI evaluation cancelled',
        };
        const { data } = await this.octokit.rest.checks.update({
            ...this.repo(target),
            check_run_id: checkId,
            ...(state === 'pending'
                ? { status: 'in_progress' as const }
                : { status: 'completed' as const, conclusion: state, completed_at: new Date().toISOString() }),
            output: {
                title: titles[state],
                summary: summary.slice(0, 60000),
            },
        });
        return numericId(data.id);
    }

    public async approve(target: Target, commentOnApproval: boolean): Promise<number> {
        const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
            ...this.repo(target),
            pull_number: target.pullNumber,
            per_page: 100,
        });
        const login = await this.botLogin();
        const existing = reviews.findLast(
            (review) =>
                review.user?.login === login && review.state === 'APPROVED' && review.commit_id === target.headSha,
        );
        if (existing) {
            return numericId(existing.id);
        }
        const { data } = await this.octokit.rest.pulls.createReview({
            ...this.repo(target),
            pull_number: target.pullNumber,
            commit_id: target.headSha,
            event: 'APPROVE',
            ...(commentOnApproval ? { body: 'All applicable CI checks passed. Automated approval by Sahaayaka.' } : {}),
        });
        return numericId(data.id);
    }

    public async dismiss(target: Target): Promise<void> {
        // Discover approvals as well as using the persisted ID: a process can
        // crash after GitHub creates a review but before its ID is saved.
        const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
            ...this.repo(target),
            pull_number: target.pullNumber,
            per_page: 100,
        });
        const login = await this.botLogin();
        for (const review of reviews) {
            if (review.user?.login !== login || review.state !== 'APPROVED') {
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.octokit.rest.pulls.dismissReview({
                ...this.repo(target),
                pull_number: target.pullNumber,
                review_id: numericId(review.id),
                message: 'The CI gate must be evaluated again.',
            });
        }
    }

    private repo(target: Target): Repository {
        return { owner: target.owner, repo: target.repo };
    }

    private async botLogin(): Promise<string> {
        if (!this.login) {
            const { data } = await this.octokit.rest.apps.getAuthenticated();
            if (!data?.slug) {
                throw new Error('GitHub App identity is unavailable.');
            }
            this.login = `${data.slug}[bot]`;
        }
        return this.login;
    }

    private externalChecks(
        ref: string,
        allChecks: CheckRun[],
        suites: ReadonlySet<WorkflowRun['check_suite_id']>,
    ): Check[] {
        const checks: Check[] = [];
        const latestChecks = new Map<string, (typeof allChecks)[number]>();
        for (const check of allChecks) {
            if (check.app?.id === this.appId || suites.has(check.check_suite?.id)) {
                continue;
            }
            // Unmapped Actions checks indicate an incomplete API snapshot. Never
            // fold them into a result that might select an obsolete workflow run.
            if (check.app?.slug === 'github-actions') {
                throw new Error('An Actions check has no corresponding workflow run yet.');
            }
            const key = `${check.app?.id}:${check.name}`;
            const prior = latestChecks.get(key);
            if (!prior || check.id > prior.id) {
                latestChecks.set(key, check);
            }
        }
        for (const [key, check] of latestChecks) {
            checks.push({
                key: `${ref}:check:${key}`,
                name: check.name,
                appId: check.app?.id ?? null,
                status: check.status,
                conclusion: check.conclusion,
                url: check.html_url ?? '',
            });
        }
        return checks;
    }

    private async statusChecks(target: Target, ref: string): Promise<Check[]> {
        const repo = this.repo(target);
        const checks: Check[] = [];
        const statuses = await this.octokit.paginate(this.octokit.rest.repos.listCommitStatusesForRef, {
            ...repo,
            ref,
            per_page: 100,
        });
        const latestStatuses = new Map<string, (typeof statuses)[number]>();
        for (const status of statuses) {
            const prior = latestStatuses.get(status.context);
            if (!prior || status.id > prior.id) {
                latestStatuses.set(status.context, status);
            }
        }
        for (const [context, status] of latestStatuses) {
            let conclusion: string | null = 'failure';
            if (status.state === 'success') {
                conclusion = 'success';
            } else if (status.state === 'pending') {
                conclusion = null;
            }
            checks.push({
                key: `${ref}:status:${context}`,
                name: context,
                appId: null,
                status: status.state === 'pending' ? 'in_progress' : 'completed',
                conclusion,
                url: status.target_url ?? '',
            });
        }
        return checks;
    }
}

import type { Probot } from 'probot';
import { Store } from './store.js';
import { RetryPolicy, isRateLimitError } from './retry.js';
import type { Octokit, Target } from './types.js';

interface Installation {
    id: number;
    suspended_at?: string | null;
}
type AccessibleRepository = Awaited<
    ReturnType<Octokit['rest']['apps']['listReposAccessibleToInstallation']>
>['data']['repositories'][number];
interface OpenPull {
    number: number;
    head: { sha: string };
    base: { sha: string };
    merge_commit_sha: string | null;
    draft?: boolean;
}

interface RepositorySnapshot {
    repository: AccessibleRepository;
    pulls: OpenPull[];
}

interface InstallationSnapshot {
    installation: Installation;
    repositories: RepositorySnapshot[];
    retainedRepositoryIds: number[];
}

interface TargetVersion {
    generation: number;
    closed: boolean;
}

function numericId(id: number | bigint): number {
    const value = Number(id);
    if (!Number.isSafeInteger(value)) {
        throw new Error('GitHub repository ID exceeds the supported safe integer range.');
    }
    return value;
}

function statusCode(error: unknown): number | undefined {
    return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
}

async function canMintScopedToken(appOctokit: Octokit, installationId: number, repositoryId: number): Promise<boolean> {
    try {
        await appOctokit.rest.apps.createInstallationAccessToken({
            installation_id: installationId,
            repository_ids: [repositoryId],
            permissions: { metadata: 'read' },
        });
        return true;
    } catch (error) {
        if ([403, 404, 422].includes(statusCode(error) ?? 0) && !isRateLimitError(error)) {
            return false;
        }
        throw error;
    }
}

async function fetchRepositories(octokit: Octokit): Promise<AccessibleRepository[]> {
    const repositories: AccessibleRepository[] = [];
    let page = 1;
    let expected: number | undefined;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page });
        if (expected !== undefined && expected !== data.total_count) {
            throw new Error('Installation repository count changed during discovery.');
        }
        expected = data.total_count;
        repositories.push(...data.repositories);
        if (repositories.length > expected || (data.repositories.length === 0 && repositories.length < expected)) {
            throw new Error('Incomplete installation repository scan.');
        }
        if (repositories.length === expected) {
            const unique = new Set(repositories.map((repository) => numericId(repository.id)));
            if (unique.size !== expected) {
                throw new Error('Duplicate repositories in installation scan.');
            }
            return repositories;
        }
        page += 1;
    }
}

async function fetchInstallations(
    appOctokit: Octokit,
    activeInstallationIds: ReadonlySet<number>,
): Promise<Installation[]> {
    const installations: Installation[] = await appOctokit.paginate(appOctokit.rest.apps.listInstallations, {
        per_page: 100,
    });
    const listedIds = new Set(installations.map((installation) => installation.id));
    for (const id of activeInstallationIds) {
        if (listedIds.has(id)) {
            continue;
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            const { data } = await appOctokit.rest.apps.getInstallation({ installation_id: id });
            installations.push(data);
        } catch (error) {
            if (statusCode(error) !== 404) {
                throw error;
            }
        }
    }
    return installations;
}

function discoveredTarget(
    installationId: number,
    repository: AccessibleRepository,
    pull: OpenPull,
    old: Target | undefined,
): Target {
    const reset =
        old !== undefined &&
        (old.closed ||
            old.owner !== repository.owner.login ||
            old.repo !== repository.name ||
            old.installationId !== installationId);
    const now = Date.now();
    return {
        key: `${repository.id}:${pull.number}`,
        owner: repository.owner.login,
        repo: repository.name,
        repositoryId: numericId(repository.id),
        installationId,
        pullNumber: pull.number,
        headSha: old?.headSha ?? pull.head.sha,
        baseSha: old?.baseSha ?? pull.base.sha,
        mergeSha: old?.mergeSha ?? pull.merge_commit_sha,
        draft: old?.draft ?? pull.draft ?? false,
        startedAt: reset ? now : (old?.startedAt ?? now),
        activityAt: reset ? now : (old?.activityAt ?? now),
        generation: (old?.generation ?? 0) + Number(reset),
        checkId: reset ? null : (old?.checkId ?? null),
        reviewId: old?.reviewId ?? null,
        signature: reset ? null : (old?.signature ?? null),
        snapshotHash: reset ? null : (old?.snapshotHash ?? null),
        closed: false,
    };
}

export class Discovery {
    private readonly timer: ReturnType<typeof setInterval>;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private running: Promise<void> | undefined;
    private requested = false;
    private eventReadyAt = 0;
    private stopping = false;
    private serial = 0;
    private lastAttemptAt: number | null = null;
    private lastSuccessAt: number | null = null;
    private failureCount = 0;

    public constructor(
        private readonly app: Probot,
        private readonly store: Store,
        private readonly accepts: (owner: string, repo: string) => boolean,
        private readonly enqueue: (key: string) => void,
        interval = 300_000,
        private readonly retry = new RetryPolicy(),
        private readonly onSuccess: () => void = () => undefined,
    ) {
        this.timer = setInterval(() => this.request(), interval);
        this.timer.unref();
        this.request();
    }

    public request(): void {
        if (this.stopping) {
            return;
        }
        this.serial += 1;
        this.requested = true;
        this.eventReadyAt = 0;
        this.start();
    }

    public requestSoon(): void {
        if (this.stopping) {
            return;
        }
        this.serial += 1;
        this.requested = true;
        if (this.eventReadyAt === 0) {
            this.eventReadyAt = Date.now() + 1_000;
        }
        this.start();
    }

    public async drain(): Promise<void> {
        while (this.running) {
            // eslint-disable-next-line no-await-in-loop
            await this.running;
        }
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        this.serial += 1;
        clearInterval(this.timer);
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        await this.drain();
    }

    public status(): {
        running: boolean;
        lastAttemptAt: number | null;
        lastSuccessAt: number | null;
        failures: number;
        retryAt: number | null;
    } {
        return {
            running: this.running !== undefined,
            lastAttemptAt: this.lastAttemptAt,
            lastSuccessAt: this.lastSuccessAt,
            failures: this.failureCount,
            retryAt: this.retry.retryAt('discovery'),
        };
    }

    private start(): void {
        if (this.running || this.stopping || !this.requested) {
            return;
        }
        const dueAt = Math.max(this.retry.dueAt('discovery'), this.eventReadyAt);
        if (dueAt > Date.now()) {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
            }
            this.retryTimer = setTimeout(
                () => {
                    this.retryTimer = undefined;
                    this.start();
                },
                Math.min(2_147_483_647, dueAt - Date.now()),
            );
            this.retryTimer.unref();
            return;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        this.eventReadyAt = 0;
        this.running = Promise.resolve()
            .then(() => this.work())
            .finally(() => {
                this.running = undefined;
                this.start();
            });
    }

    private async work(): Promise<void> {
        while (this.requested && !this.stopping) {
            if (Math.max(this.retry.dueAt('discovery'), this.eventReadyAt) > Date.now()) {
                return;
            }
            this.eventReadyAt = 0;
            this.requested = false;
            this.lastAttemptAt = Date.now();
            const serial = this.serial;
            const targets = this.store.all();
            const versions = new Map(
                targets.map((target) => [target.key, { generation: target.generation, closed: target.closed }]),
            );
            const knownInstallations = new Set(this.store.knownInstallationIds());
            const knownRepositories = new Map(
                [...knownInstallations].map((id) => [id, new Set(this.store.knownRepositoryIds(id))]),
            );
            const activeInstallationIds = new Set(this.store.activeInstallationIds());
            const activeRepositoryIds = new Map(
                [...activeInstallationIds].map((id) => [id, new Set(this.store.activeRepositoryIds(id))]),
            );
            try {
                // Fetch every page before changing access. An incomplete API scan
                // must never revoke known access or declare a PR closed.
                // eslint-disable-next-line no-await-in-loop
                const installations = await this.fetch(
                    targets.filter(
                        (target) => !target.closed && this.store.canAccess(target.installationId, target.repositoryId),
                    ),
                    activeInstallationIds,
                    activeRepositoryIds,
                );
                if (serial === this.serial) {
                    this.apply(installations, versions, knownInstallations, knownRepositories);
                    this.lastSuccessAt = Date.now();
                    this.onSuccess();
                }
                this.retry.success('discovery');
            } catch (error) {
                this.failureCount += 1;
                this.retry.failure('discovery', error);
                this.requested = true;
                this.app.log.error(
                    { message: error instanceof Error ? error.message : 'Unknown discovery error' },
                    'Installation discovery failed',
                );
                return;
            }
        }
    }

    private async fetch(
        activeTargets: Target[],
        activeInstallationIds: ReadonlySet<number>,
        activeRepositoryIds: ReadonlyMap<number, ReadonlySet<number>>,
    ): Promise<InstallationSnapshot[]> {
        const appOctokit = await this.app.auth();
        const installations = await fetchInstallations(appOctokit, activeInstallationIds);
        const snapshots: InstallationSnapshot[] = [];
        for (const installation of installations) {
            if (installation.suspended_at) {
                snapshots.push({ installation, repositories: [], retainedRepositoryIds: [] });
                continue;
            }

            snapshots.push(
                // eslint-disable-next-line no-await-in-loop
                await this.fetchInstallation(
                    appOctokit,
                    installation,
                    activeTargets,
                    activeRepositoryIds.get(installation.id) ?? new Set(),
                ),
            );
        }
        return snapshots;
    }

    private async fetchInstallation(
        appOctokit: Octokit,
        installation: Installation,
        activeTargets: Target[],
        activeRepositoryIds: ReadonlySet<number>,
    ): Promise<InstallationSnapshot> {
        const octokit = await this.app.auth(installation.id);
        const repositories = await fetchRepositories(octokit);
        const listedIds = new Set(repositories.map((repository) => numericId(repository.id)));
        const omittedActiveIds = [...activeRepositoryIds].filter((id) => !listedIds.has(id));
        const retainedRepositoryIds: number[] = [];
        for (const repositoryId of omittedActiveIds) {
            // eslint-disable-next-line no-await-in-loop
            if (await canMintScopedToken(appOctokit, installation.id, repositoryId)) {
                retainedRepositoryIds.push(repositoryId);
            }
        }
        const accessible: RepositorySnapshot[] = [];
        for (const repository of repositories) {
            // eslint-disable-next-line no-await-in-loop
            const snapshot = await this.fetchRepository(
                appOctokit,
                octokit,
                installation.id,
                repository,
                activeTargets,
            );
            if (snapshot) {
                accessible.push(snapshot);
            }
        }
        return { installation, repositories: accessible, retainedRepositoryIds };
    }

    private async fetchRepository(
        appOctokit: Octokit,
        octokit: Octokit,
        installationId: number,
        repository: AccessibleRepository,
        activeTargets: Target[],
    ): Promise<RepositorySnapshot | undefined> {
        if (!this.accepts(repository.owner.login, repository.name)) {
            return undefined;
        }
        const repositoryId = numericId(repository.id);
        if (
            (this.store.installationDenied(installationId) ||
                this.store.repositoryDenied(installationId, repositoryId)) &&
            !(await canMintScopedToken(appOctokit, installationId, repositoryId))
        ) {
            return undefined;
        }
        const pulls: OpenPull[] = await octokit.paginate(octokit.rest.pulls.list, {
            owner: repository.owner.login,
            repo: repository.name,
            state: 'open',
            per_page: 100,
        });
        const pullNumbers = new Set(pulls.map((pull) => pull.number));
        for (const target of activeTargets) {
            if (
                target.installationId !== installationId ||
                target.repositoryId !== repositoryId ||
                pullNumbers.has(target.pullNumber) ||
                this.store.get(target.key)?.closed
            ) {
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const { data } = await octokit.rest.pulls.get({
                owner: repository.owner.login,
                repo: repository.name,
                pull_number: target.pullNumber,
            });
            if (data.state === 'open') {
                pulls.push(data);
            }
        }
        return { repository, pulls };
    }

    private apply(
        snapshots: InstallationSnapshot[],
        versions: ReadonlyMap<string, TargetVersion>,
        knownInstallations: ReadonlySet<number>,
        knownRepositories: ReadonlyMap<number, ReadonlySet<number>>,
    ): void {
        const activeIds = new Set(
            snapshots
                .filter((snapshot) => !snapshot.installation.suspended_at)
                .map((snapshot) => snapshot.installation.id),
        );
        for (const id of knownInstallations) {
            if (!activeIds.has(id)) {
                this.store.retireInstallation(id);
            }
        }
        for (const snapshot of snapshots) {
            this.applyInstallation(snapshot, versions, knownRepositories.get(snapshot.installation.id) ?? new Set());
        }
    }

    private applyInstallation(
        snapshot: InstallationSnapshot,
        versions: ReadonlyMap<string, TargetVersion>,
        knownRepositories: ReadonlySet<number>,
    ): void {
        const id = snapshot.installation.id;
        if (
            snapshot.installation.suspended_at ||
            (this.store.installationDenied(id) && snapshot.repositories.length === 0)
        ) {
            return;
        }
        this.store.activateInstallation(id);
        const repositoryIds = new Set([
            ...snapshot.repositories.map(({ repository }) => numericId(repository.id)),
            ...snapshot.retainedRepositoryIds,
        ]);
        for (const repositoryId of knownRepositories) {
            if (!repositoryIds.has(repositoryId)) {
                this.store.retireRepository(id, repositoryId);
            }
        }
        for (const { repository, pulls } of snapshot.repositories) {
            this.store.activateRepository(id, numericId(repository.id));
            this.applyPulls(id, repository, pulls, versions);
        }
    }

    private applyPulls(
        installationId: number,
        repository: AccessibleRepository,
        pulls: OpenPull[],
        versions: ReadonlyMap<string, TargetVersion>,
    ): void {
        const repositoryId = numericId(repository.id);
        const openKeys = new Set(pulls.map((pull) => `${repositoryId}:${pull.number}`));
        this.retireMissingPulls(installationId, repositoryId, openKeys, versions);
        for (const pull of pulls) {
            const key = `${repositoryId}:${pull.number}`;
            const old = this.store.get(key);
            const version = versions.get(key);
            if (old && (version?.generation !== old.generation || version.closed !== old.closed)) {
                // A newer webhook changed this target while the API scan was in
                // flight. Its own reconciliation owns the newer revision.
                continue;
            }
            this.store.put(discoveredTarget(installationId, repository, pull, old));
            this.enqueue(key);
        }
    }

    private retireMissingPulls(
        installationId: number,
        repositoryId: number,
        openKeys: ReadonlySet<string>,
        versions: ReadonlyMap<string, TargetVersion>,
    ): void {
        for (const target of this.store.all()) {
            if (
                target.installationId === installationId &&
                target.repositoryId === repositoryId &&
                !openKeys.has(target.key) &&
                versions.get(target.key)?.generation === target.generation &&
                versions.get(target.key)?.closed === target.closed
            ) {
                this.store.retire(target);
            }
        }
    }
}

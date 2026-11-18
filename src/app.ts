import type { Probot } from 'probot';
import { Engine } from './engine.js';
import { Discovery } from './discovery.js';
import { GitHub } from './github.js';
import { Store } from './store.js';
import { RetryPolicy } from './retry.js';
import { WorkQueue } from './work-queue.js';
import type { RuntimeStatus } from './runtime-status.js';
import type { Target } from './types.js';

export interface Runtime {
    drain(): Promise<void>;
    stop(): Promise<void>;
    status(): RuntimeStatus;
}

export function register(
    app: Probot,
    store: Store,
    appId: number,
    interval = 30000,
    repositories?: ReadonlySet<string>,
): Runtime {
    const engine = new Engine(store);
    const clients = new Map<number, GitHub>();
    const retry = new RetryPolicy();
    const pending = new WorkQueue();
    const startedAt = Date.now();
    const reconcileStatus: RuntimeStatus['reconcile'] = {
        succeeded: 0,
        failed: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastDurationMs: null,
    };
    let running: Promise<void> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let ready = false;

    function accepts(owner: string, repo: string): boolean {
        return repositories === undefined || repositories.has(`${owner}/${repo}`.toLowerCase());
    }

    function shouldReconcile(target: Target): boolean {
        return (
            (!target.closed || target.closedChecksFinalized !== true) &&
            accepts(target.owner, target.repo) &&
            store.canAccess(target.installationId, target.repositoryId)
        );
    }

    async function work(): Promise<void> {
        for (;;) {
            if (stopping) {
                return;
            }
            const key = pending.takeDue((item) => retry.dueAt(item));
            if (key === null) {
                return;
            }
            const target = store.get(key);
            if (!target || !shouldReconcile(target)) {
                retry.success(key);
                continue;
            }
            const attemptAt = Date.now();
            try {
                // All writes go through this one worker, including polling and
                // webhook-triggered work. No overlapping GitHub status writes.
                let github = clients.get(target.installationId);
                if (!github) {
                    // eslint-disable-next-line no-await-in-loop
                    github = new GitHub(await app.auth(target.installationId), appId);
                    clients.set(target.installationId, github);
                }
                // eslint-disable-next-line no-await-in-loop
                await engine.reconcile(key, github);
                retry.success(key);
                reconcileStatus.succeeded += 1;
                reconcileStatus.lastSuccessAt = Date.now();
            } catch (error) {
                retry.failure(key, error);
                pending.enqueue(key, false);
                reconcileStatus.failed += 1;
                reconcileStatus.lastFailureAt = Date.now();
                app.log.error(
                    { message: error instanceof Error ? error.message : 'Unknown reconciliation error', key },
                    'CI reconciliation failed',
                );
            } finally {
                reconcileStatus.lastDurationMs = Date.now() - attemptAt;
            }
        }
    }

    function startWork(): void {
        if (stopping || !ready || running) {
            return;
        }
        const nextDueAt = pending.nextDueAt((key) => retry.dueAt(key));
        if (nextDueAt === null) {
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = undefined;
            }
            return;
        }
        if (nextDueAt > Date.now()) {
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            retryTimer = setTimeout(
                () => {
                    retryTimer = undefined;
                    startWork();
                },
                Math.min(2_147_483_647, nextDueAt - Date.now()),
            );
            retryTimer.unref();
            return;
        }
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        running = Promise.resolve()
            .then(work)
            .finally(() => {
                running = undefined;
                startWork();
            });
    }

    function enqueue(key: string, invalidate: boolean): void {
        if (stopping) {
            return;
        }
        if (invalidate) {
            engine.invalidate(key);
        }
        pending.enqueue(key, invalidate);
        startWork();
    }

    // Poll persisted targets without turning deferred retries into new attempts.
    function reconcileAll(): void {
        for (const target of store.all()) {
            if (shouldReconcile(target) && retry.dueAt(target.key) <= Date.now()) {
                enqueue(target.key, false);
            }
        }
    }

    const discovery = new Discovery(
        app,
        store,
        accepts,
        (key) => enqueue(key, false),
        300_000,
        retry,
        () => {
            if (!ready) {
                ready = true;
                reconcileAll();
            }
            startWork();
        },
    );

    app.on(
        ['installation.created', 'installation.unsuspend', 'installation.suspend', 'installation.deleted'],
        (context) => {
            if (context.payload.action === 'suspend' || context.payload.action === 'deleted') {
                store.retireInstallation(context.payload.installation.id);
                clients.delete(context.payload.installation.id);
            }
            discovery.requestSoon();
        },
    );

    app.on(['installation_repositories.added', 'installation_repositories.removed'], (context) => {
        if (context.payload.action === 'removed') {
            for (const repository of context.payload.repositories_removed) {
                store.retireRepository(context.payload.installation.id, repository.id);
            }
        }
        discovery.requestSoon();
    });

    app.on(
        [
            'pull_request.opened',
            'pull_request.reopened',
            'pull_request.synchronize',
            'pull_request.edited',
            'pull_request.ready_for_review',
            'pull_request.converted_to_draft',
            'pull_request.closed',
        ],
        (context) => {
            if (!accepts(context.repo().owner, context.repo().repo)) {
                return;
            }
            const installationId = context.payload.installation?.id;
            if (!installationId) {
                return;
            }
            if (!store.canAccess(installationId, context.payload.repository.id)) {
                discovery.requestSoon();
                return;
            }
            store.processDelivery(context.id, () => {
                const pull = context.payload.pull_request;
                const key = `${context.payload.repository.id}:${pull.number}`;
                const existing = store.get(key);
                const target: Target = existing ?? {
                    ...context.repo(),
                    key,
                    repositoryId: context.payload.repository.id,
                    installationId,
                    pullNumber: pull.number,
                    headSha: pull.head.sha,
                    baseSha: pull.base.sha,
                    mergeSha: pull.merge_commit_sha,
                    draft: pull.draft ?? false,
                    startedAt: Date.now(),
                    activityAt: Date.now(),
                    generation: 0,
                    checkId: null,
                    reviewId: null,
                    signature: null,
                    snapshotHash: null,
                    closed: false,
                };
                // Existing revisions are refreshed from the API, never replaced by a
                // possibly delayed webhook payload.
                store.put({ ...target, owner: context.repo().owner, repo: context.repo().repo, installationId });
                enqueue(key, true);
            });
        },
    );

    app.on(
        [
            'check_run.created',
            'check_run.completed',
            'check_run.rerequested',
            'check_suite.requested',
            'check_suite.completed',
            'check_suite.rerequested',
            'workflow_run.requested',
            'workflow_run.in_progress',
            'workflow_run.completed',
            'status',
        ],
        (context) => {
            if (!accepts(context.repo().owner, context.repo().repo)) {
                return;
            }
            const payload = context.payload;
            if (!store.canAccess(payload.installation?.id ?? 0, payload.repository.id)) {
                return;
            }
            let sha: string;
            if ('check_run' in payload) {
                if (payload.check_run.app?.id === appId && payload.action !== 'rerequested') {
                    return;
                }
                sha = payload.check_run.head_sha;
            } else if ('check_suite' in payload) {
                if (payload.check_suite.app.id === appId) {
                    return;
                }
                sha = payload.check_suite.head_sha;
            } else if ('workflow_run' in payload) {
                sha = payload.workflow_run.head_sha;
            } else {
                sha = payload.sha;
            }
            store.processDelivery(context.id, () => {
                for (const target of store.all()) {
                    if (
                        !target.closed &&
                        target.repositoryId === payload.repository.id &&
                        (target.headSha === sha || target.mergeSha === sha)
                    ) {
                        enqueue(target.key, true);
                    }
                }
            });
        },
    );

    // Poll persisted targets on startup and periodically: lost webhooks, crashes,
    // new workflows and API propagation delays must all be recoverable.
    const timer = setInterval(reconcileAll, interval);
    timer.unref();
    const initial = discovery.drain();
    return {
        status(): RuntimeStatus {
            return {
                startedAt,
                stopping,
                initialDiscoveryComplete: ready,
                discovery: discovery.status(),
                queue: {
                    ...pending.stats((key) => retry.dueAt(key)),
                    running: running !== undefined,
                },
                reconcile: { ...reconcileStatus },
                backoffUntil: retry.backoffUntil,
            };
        },
        async drain(): Promise<void> {
            await initial;
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                await discovery.drain();
                const current = running;
                if (!current) {
                    return;
                }
                // eslint-disable-next-line no-await-in-loop
                await current;
            }
        },
        async stop(): Promise<void> {
            stopping = true;
            clearInterval(timer);
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
            await discovery.stop();
            await initial;
            await running;
            store.close();
        },
    };
}

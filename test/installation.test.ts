import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Probot } from 'probot';
import { register } from '../src/app.js';
import { Discovery } from '../src/discovery.js';
import { Store } from '../src/store.js';
import type { Target } from '../src/types.js';

interface MockRepository {
    id: number;
    name: string;
    owner: { login: string };
}

interface MockPull {
    number: number;
    head: { sha: string };
    base: { sha: string };
    merge_commit_sha: null;
    draft: boolean;
}

function repository(id: number, name: string): MockRepository {
    return { id, name, owner: { login: 'owner' } };
}

function pull(number: number): MockPull {
    return { number, head: { sha: `head-${number}` }, base: { sha: 'base' }, merge_commit_sha: null, draft: false };
}

function advanceDiscoveryRetry(t: TestContext, discovery: Discovery): void {
    const retryAt = discovery.status().retryAt;
    assert.ok(retryAt !== null);
    t.mock.timers.tick(Math.max(0, retryAt - Date.now()));
}

void test('discovery backfills open PRs, deduplicates scans, and honors the allowlist', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-installation-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const installations = [{ id: 3, suspended_at: null }];
    const repositories = [repository(1, 'allowed'), repository(2, 'unallowed')];
    const pulls = new Map([
        [1, [pull(10), pull(11)]],
        [2, [pull(12)]],
    ]);
    const calls: string[] = [];
    let fail = false;
    let failPulls = false;
    let tokenStatus = 200;
    let countOverride: number | undefined;
    let holdPulls: Promise<void> | undefined;
    let enteredPulls: (() => void) | undefined;
    const app = {
        auth: (id?: number) =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            calls.push('installations');
                            return Promise.resolve({ data: installations });
                        },
                        createInstallationAccessToken: () =>
                            tokenStatus === 200
                                ? Promise.resolve({ data: { token: 'test-token' } })
                                : Promise.reject(Object.assign(new Error('access denied'), { status: tokenStatus })),
                        listReposAccessibleToInstallation: () => {
                            calls.push(`repositories:${id}`);
                            if (fail) {
                                throw new Error('incomplete scan');
                            }
                            return Promise.resolve({
                                data: { total_count: countOverride ?? repositories.length, repositories },
                            });
                        },
                    },
                    pulls: {
                        list: ({ repo }: { repo: string }) => {
                            calls.push(`pulls:${repo}`);
                            if (failPulls) {
                                throw new Error('incomplete pulls');
                            }
                            const data = pulls.get(repo === 'allowed' ? 1 : 2) ?? [];
                            enteredPulls?.();
                            return holdPulls ? holdPulls.then(() => ({ data })) : Promise.resolve({ data });
                        },
                    },
                },
                paginate: async (method: (options: unknown) => Promise<{ data: unknown }>, options: unknown) => {
                    const result = await method(options);
                    if (Array.isArray(result.data)) {
                        return result.data as unknown[];
                    }
                    return (result.data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const queued: string[] = [];
    const discovery = new Discovery(
        app,
        store,
        (owner, repo) => `${owner}/${repo}` === 'owner/allowed',
        (key) => queued.push(key),
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    assert.deepEqual(
        store
            .all()
            .map((target) => target.key)
            .toSorted((a, b) => a.localeCompare(b)),
        ['1:10', '1:11'],
    );
    assert.deepEqual(
        queued.toSorted((a, b) => a.localeCompare(b)),
        ['1:10', '1:11'],
    );
    assert.equal(calls.includes('pulls:unallowed'), false);
    assert.equal(store.canAccess(3, 1), true);

    discovery.request();
    await discovery.drain();
    assert.equal(store.all().length, 2);
    assert.equal(store.get('1:10')?.generation, 0);

    let releasePulls!: () => void;
    holdPulls = new Promise<void>((resolve) => {
        releasePulls = resolve;
    });
    const pullScanStarted = new Promise<void>((resolve) => {
        enteredPulls = resolve;
    });
    discovery.request();
    await pullScanStarted;
    const opened = store.get('1:10');
    assert.ok(opened);
    store.put({ ...opened, key: '1:13', pullNumber: 13, headSha: 'head-13' });
    store.put({ ...opened, closed: true });
    holdPulls = undefined;
    releasePulls();
    await discovery.drain();
    assert.equal(store.get('1:13')?.closed, false);
    assert.equal(store.get('1:10')?.closed, true);
    store.put({ ...opened, generation: opened.generation + 1 });

    failPulls = true;
    pulls.set(1, []);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    failPulls = false;
    pulls.set(1, [pull(10), pull(11)]);
    countOverride = 3;
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    countOverride = undefined;

    fail = true;
    repositories.splice(0, repositories.length);
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(store.canAccess(3, 1), true);

    fail = false;
    tokenStatus = 403;
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.canAccess(3, 1), false);
    const retiredGeneration = store.get('1:10')?.generation;
    repositories.push(repository(1, 'allowed'));
    tokenStatus = 200;
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(store.get('1:10')?.generation, (retiredGeneration ?? 0) + 1);
    assert.equal(store.canAccess(3, 1), true);
});

void test('suspension, deletion, and failed installation enumeration preserve confirmed state', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-installation-state-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let installations = [{ id: 3, suspended_at: null as string | null }];
    let fail = false;
    let repoName = 'allowed';
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            if (fail) {
                                throw new Error('incomplete installations');
                            }
                            return Promise.resolve({ data: installations });
                        },
                        getInstallation: ({ installation_id }: { installation_id: number }) => {
                            const installation = installations.find((item) => item.id === installation_id);
                            return installation
                                ? Promise.resolve({ data: installation })
                                : Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
                        },
                        createInstallationAccessToken: () => Promise.resolve({ data: { token: 'test-token' } }),
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 1, repositories: [repository(1, repoName)] } }),
                    },
                    pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const result = await method();
                    return Array.isArray(result.data)
                        ? (result.data as unknown[])
                        : (result.data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    const established = store.get('1:10');
    assert.ok(established);
    store.put({ ...established, checkId: 42, reviewId: 43, signature: 'settled' });
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.checkId, 42);
    assert.equal(store.get('1:10')?.reviewId, 43);
    assert.equal(store.get('1:10')?.signature, 'settled');
    assert.equal(store.get('1:10')?.generation, 0);
    repoName = 'renamed';
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.repo, 'renamed');
    assert.equal(store.get('1:10')?.generation, 1);
    assert.equal(store.get('1:10')?.checkId, null);
    assert.equal(store.get('1:10')?.signature, null);
    fail = true;
    installations = [];
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    fail = false;
    installations = [{ id: 3, suspended_at: '2026-11-17T00:00:00Z' }];
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.canAccess(3, 1), false);
    installations = [{ id: 3, suspended_at: null }];
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    installations = [];
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.canAccess(3, 1), false);
});

void test('a delayed scan cannot apply after a newer lifecycle request', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-stale-scan-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const active = [{ id: 3, suspended_at: null }];
    let installations = active;
    let hold: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            const snapshot = installations;
                            entered?.();
                            return hold ? hold.then(() => ({ data: snapshot })) : Promise.resolve({ data: snapshot });
                        },
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 1, repositories: [repository(1, 'allowed')] } }),
                    },
                    pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const result = await method();
                    return Array.isArray(result.data)
                        ? (result.data as unknown[])
                        : (result.data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    assert.equal(store.get('1:10')?.generation, 0);
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    installations = [];
    discovery.request();
    await started;
    installations = active;
    hold = undefined;
    discovery.request();
    release();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(store.get('1:10')?.generation, 0);
});

void test('a scan cannot retire installation or repository identities created after it began', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-new-access-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let holdRepositories: Promise<void> | undefined;
    let enteredRepositories: (() => void) | undefined;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: [{ id: 3, suspended_at: null }] }),
                        listReposAccessibleToInstallation: () => {
                            const data = { total_count: 1, repositories: [repository(1, 'allowed')] };
                            enteredRepositories?.();
                            return holdRepositories
                                ? holdRepositories.then(() => ({ data }))
                                : Promise.resolve({ data });
                        },
                    },
                    pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const result = await method();
                    return Array.isArray(result.data)
                        ? (result.data as unknown[])
                        : (result.data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    const existing = store.get('1:10');
    assert.ok(existing);
    let releaseRepositories!: () => void;
    holdRepositories = new Promise<void>((resolve) => {
        releaseRepositories = resolve;
    });
    const started = new Promise<void>((resolve) => {
        enteredRepositories = resolve;
    });
    discovery.request();
    await started;
    store.put({ ...existing, key: '2:11', repositoryId: 2, repo: 'new', pullNumber: 11 });
    store.put({ ...existing, key: '3:12', repositoryId: 3, installationId: 4, repo: 'another', pullNumber: 12 });
    holdRepositories = undefined;
    releaseRepositories();
    await discovery.drain();
    assert.equal(store.get('2:11')?.closed, false);
    assert.equal(store.get('3:12')?.closed, false);
    assert.equal(store.canAccess(3, 2), true);
    assert.equal(store.canAccess(4, 3), true);
});

void test('installation webhooks retire access immediately and denial survives restart', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-installation-webhooks-'));
    const path = join(directory, 'state.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new Store(path);
    const handlers = new Map<string, (context: unknown) => void>();
    const scans: string[] = [];
    const app = {
        on: (events: string | string[], callback: (context: unknown) => void): void => {
            for (const event of Array.isArray(events) ? events : [events]) {
                handlers.set(event, callback);
            }
        },
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            scans.push('scan');
                            return Promise.resolve({ data: [] });
                        },
                    },
                },
                paginate: (method: () => Promise<{ data: unknown[] }>) => method().then((response) => response.data),
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const runtime = register(app, store, 42, 30_000);
    await runtime.drain();
    const initialScans = scans.length;
    assert.equal(initialScans, 1);
    const target: Target = {
        key: '1:10',
        owner: 'owner',
        repo: 'allowed',
        repositoryId: 1,
        installationId: 3,
        pullNumber: 10,
        headSha: 'head',
        baseSha: 'base',
        mergeSha: null,
        draft: false,
        startedAt: 1,
        activityAt: 1,
        generation: 0,
        checkId: null,
        reviewId: null,
        signature: null,
        snapshotHash: null,
        closed: false,
    };
    store.put(target);
    const send = (name: string, payload: unknown): void => {
        const handler = handlers.get(name);
        assert.ok(handler);
        handler({ payload });
    };
    send('installation_repositories.removed', {
        action: 'removed',
        installation: { id: 3 },
        repositories_removed: [{ id: 1 }],
    });
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.get('1:10')?.generation, 1);
    assert.equal(store.canAccess(3, 1), false);
    await runtime.drain();
    send('installation.created', { action: 'created', installation: { id: 3 } });
    send('installation.unsuspend', { action: 'unsuspend', installation: { id: 3 } });
    t.mock.timers.tick(1_000);
    await runtime.drain();
    assert.ok(scans.length >= 2);
    store.put({ ...target, generation: 2 });
    send('installation.suspend', { action: 'suspend', installation: { id: 3 } });
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.canAccess(3, 1), false);
    await runtime.drain();
    send('installation.deleted', { action: 'deleted', installation: { id: 3 } });
    await runtime.drain();
    await runtime.stop();
    const reopened = new Store(path);
    assert.equal(reopened.canAccess(3, 1), false);
    assert.equal(reopened.get('1:10')?.closed, true);
    reopened.close();
});

void test('an omitted active installation requires a detail response before retirement', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-omitted-installation-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let listed = true;
    let detailStatus: 'active' | 'missing' | 'failed' = 'active';
    let detailCalls = 0;
    const installation = { id: 3, suspended_at: null };
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: listed ? [installation] : [] }),
                        getInstallation: () => {
                            detailCalls += 1;
                            if (detailStatus === 'active') {
                                return Promise.resolve({ data: installation });
                            }
                            return Promise.reject(
                                Object.assign(new Error('installation unavailable'), {
                                    status: detailStatus === 'missing' ? 404 : 500,
                                }),
                            );
                        },
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 1, repositories: [repository(1, 'allowed')] } }),
                    },
                    pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    listed = false;
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(detailCalls, 1);
    detailStatus = 'failed';
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    detailStatus = 'missing';
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    const completedDetailCalls = detailCalls;
    discovery.request();
    await discovery.drain();
    assert.equal(detailCalls, completedDetailCalls);
});

void test('an omitted active PR requires a detail response before retirement', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-omitted-pull-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let listed = true;
    let detailStatus: 'open' | 'closed' | 'failed' = 'open';
    let detailCalls = 0;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: [{ id: 3, suspended_at: null }] }),
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 1, repositories: [repository(1, 'allowed')] } }),
                    },
                    pulls: {
                        list: () => Promise.resolve({ data: listed ? [pull(10)] : [] }),
                        get: () => {
                            detailCalls += 1;
                            return detailStatus === 'failed'
                                ? Promise.reject(Object.assign(new Error('pull unavailable'), { status: 500 }))
                                : Promise.resolve({ data: { ...pull(10), state: detailStatus } });
                        },
                    },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    listed = false;
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(detailCalls, 1);
    detailStatus = 'failed';
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    detailStatus = 'closed';
    advanceDiscoveryRetry(t, discovery);
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    const completedDetailCalls = detailCalls;
    discovery.request();
    await discovery.drain();
    assert.equal(detailCalls, completedDetailCalls);
});

void test('an omitted active repository requires scoped access confirmation before retirement', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-omitted-repository-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let listed = true;
    let tokenStatus = 200;
    let tokenCalls = 0;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: [{ id: 3, suspended_at: null }] }),
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({
                                data: {
                                    total_count: listed ? 1 : 0,
                                    repositories: listed ? [repository(1, 'allowed')] : [],
                                },
                            }),
                        createInstallationAccessToken: () => {
                            tokenCalls += 1;
                            return tokenStatus === 200
                                ? Promise.resolve({ data: { token: 'test-token' } })
                                : Promise.reject(Object.assign(new Error('access denied'), { status: tokenStatus }));
                        },
                    },
                    pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    listed = false;
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, false);
    assert.equal(tokenCalls, 1);
    tokenStatus = 403;
    discovery.request();
    await discovery.drain();
    assert.equal(store.get('1:10')?.closed, true);
    assert.equal(store.canAccess(3, 1), false);
    const completedTokenCalls = tokenCalls;
    discovery.request();
    await discovery.drain();
    assert.equal(tokenCalls, completedTokenCalls);
});

for (const scope of ['repository', 'installation'] as const) {
    void test(`${scope} denial requires a fresh scoped token before reactivation`, async (t) => {
        const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-capability-'));
        const store = new Store(join(directory, 'state.sqlite'));
        t.after(() => {
            store.close();
            rmSync(directory, { recursive: true, force: true });
        });
        const tokenRequests: unknown[] = [];
        const logged: unknown[] = [];
        let tokenStatus = 403;
        const app = {
            auth: () =>
                Promise.resolve({
                    rest: {
                        apps: {
                            listInstallations: () => Promise.resolve({ data: [{ id: 3, suspended_at: null }] }),
                            listReposAccessibleToInstallation: () =>
                                Promise.resolve({
                                    data: {
                                        total_count: 2,
                                        repositories: [repository(1, 'allowed'), repository(2, 'blocked')],
                                    },
                                }),
                            createInstallationAccessToken: (options: unknown) => {
                                tokenRequests.push(options);
                                return tokenStatus === 200
                                    ? Promise.resolve({ data: { token: 'secret-test-token' } })
                                    : Promise.reject(
                                          Object.assign(new Error('access denied'), { status: tokenStatus }),
                                      );
                            },
                        },
                        pulls: { list: () => Promise.resolve({ data: [pull(10)] }) },
                    },
                    paginate: async (method: () => Promise<{ data: unknown }>) => {
                        const { data } = await method();
                        return Array.isArray(data)
                            ? (data as unknown[])
                            : (data as { repositories: MockRepository[] }).repositories;
                    },
                }),
            log: { error: (message: unknown) => logged.push(message) },
        } as unknown as Probot;
        const discovery = new Discovery(
            app,
            store,
            (owner, repo) => `${owner}/${repo}` === 'owner/allowed',
            () => undefined,
        );
        t.after(() => discovery.stop());
        await discovery.drain();
        if (scope === 'installation') {
            store.retireInstallation(3);
        } else {
            store.retireRepository(3, 1);
        }
        for (const status of [403, 404, 422]) {
            tokenStatus = status;
            discovery.request();
            // eslint-disable-next-line no-await-in-loop
            await discovery.drain();
            assert.equal(store.get('1:10')?.closed, true);
            assert.equal(store.canAccess(3, 1), false);
        }
        assert.deepEqual(tokenRequests, [
            { installation_id: 3, repository_ids: [1], permissions: { metadata: 'read' } },
            { installation_id: 3, repository_ids: [1], permissions: { metadata: 'read' } },
            { installation_id: 3, repository_ids: [1], permissions: { metadata: 'read' } },
        ]);
        tokenStatus = 200;
        discovery.request();
        await discovery.drain();
        assert.equal(store.get('1:10')?.closed, false);
        assert.equal(store.canAccess(3, 1), true);
        const requestsAfterRecovery = tokenRequests.length;
        discovery.request();
        await discovery.drain();
        assert.equal(tokenRequests.length, requestsAfterRecovery);
        assert.equal(JSON.stringify(logged).includes('secret-test-token'), false);
    });
}

void test('an omitted installation with no open PRs is checked before access retirement', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-idle-installation-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let listed = true;
    let detailStatus: 'active' | 'missing' = 'active';
    let detailCalls = 0;
    const installation = { id: 3, suspended_at: null };
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: listed ? [installation] : [] }),
                        getInstallation: () => {
                            detailCalls += 1;
                            return detailStatus === 'active'
                                ? Promise.resolve({ data: installation })
                                : Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
                        },
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 1, repositories: [repository(1, 'allowed')] } }),
                    },
                    pulls: { list: () => Promise.resolve({ data: [] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    assert.deepEqual(store.all(), []);
    assert.deepEqual(store.activeInstallationIds(), [3]);
    listed = false;
    discovery.request();
    await discovery.drain();
    assert.equal(detailCalls, 1);
    assert.equal(store.installationDenied(3), false);
    detailStatus = 'missing';
    discovery.request();
    await discovery.drain();
    assert.equal(store.installationDenied(3), true);
    const completedDetailCalls = detailCalls;
    discovery.request();
    await discovery.drain();
    assert.equal(detailCalls, completedDetailCalls);
});

void test('an omitted active installation with no repositories is checked by detail', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-empty-installation-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    store.activateInstallation(3);
    assert.deepEqual(store.activeInstallationIds(), [3]);
    let detailCalls = 0;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: [] }),
                        getInstallation: () => {
                            detailCalls += 1;
                            return Promise.resolve({ data: { id: 3, suspended_at: null } });
                        },
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({ data: { total_count: 0, repositories: [] } }),
                    },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    assert.equal(detailCalls, 1);
    assert.equal(store.installationDenied(3), false);
    store.retireInstallation(3);
    discovery.request();
    await discovery.drain();
    assert.equal(detailCalls, 1);
});

void test('an omitted repository with no open PRs is checked before access retirement', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-idle-repository-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    let listed = true;
    let tokenStatus = 200;
    let tokenCalls = 0;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => Promise.resolve({ data: [{ id: 3, suspended_at: null }] }),
                        listReposAccessibleToInstallation: () =>
                            Promise.resolve({
                                data: {
                                    total_count: listed ? 1 : 0,
                                    repositories: listed ? [repository(1, 'allowed')] : [],
                                },
                            }),
                        createInstallationAccessToken: () => {
                            tokenCalls += 1;
                            return tokenStatus === 200
                                ? Promise.resolve({ data: { token: 'test-token' } })
                                : Promise.reject(Object.assign(new Error('access denied'), { status: tokenStatus }));
                        },
                    },
                    pulls: { list: () => Promise.resolve({ data: [] }) },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => {
                    const { data } = await method();
                    return Array.isArray(data)
                        ? (data as unknown[])
                        : (data as { repositories: MockRepository[] }).repositories;
                },
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
    );
    t.after(() => discovery.stop());
    await discovery.drain();
    assert.deepEqual(store.all(), []);
    assert.deepEqual(store.activeRepositoryIds(3), [1]);
    listed = false;
    discovery.request();
    await discovery.drain();
    assert.equal(tokenCalls, 1);
    assert.equal(store.canAccess(3, 1), true);
    tokenStatus = 403;
    discovery.request();
    await discovery.drain();
    assert.equal(store.canAccess(3, 1), false);
    const completedTokenCalls = tokenCalls;
    discovery.request();
    await discovery.drain();
    assert.equal(tokenCalls, completedTokenCalls);
});

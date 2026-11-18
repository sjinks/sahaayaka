import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Probot } from 'probot';
import { register } from '../src/app.js';
import { Discovery } from '../src/discovery.js';
import { Engine } from '../src/engine.js';
import type { Gateway } from '../src/github.js';
import { RetryPolicy } from '../src/retry.js';
import { Store } from '../src/store.js';
import type { Target } from '../src/types.js';
import { WorkQueue } from '../src/work-queue.js';

void test('webhooks precede background work and promote a queued key once', () => {
    const queue = new WorkQueue(() => 10);
    queue.enqueue('background', false);
    queue.enqueue('urgent', true);
    assert.equal(
        queue.takeDue(() => 0),
        'urgent',
    );
    queue.enqueue('background', true);
    queue.enqueue('background', true);
    assert.deepEqual(
        queue.stats(() => 0),
        {
            webhook: 1,
            background: 0,
            oldestEnqueuedAt: 10,
            deferred: 0,
        },
    );
    assert.equal(
        queue.takeDue(() => 0),
        'background',
    );
    assert.equal(
        queue.takeDue(() => 0),
        null,
    );
});

void test('deferred keys wait while background work eventually gets a turn', () => {
    let now = 0;
    const queue = new WorkQueue(() => now);
    queue.enqueue('deferred', true);
    queue.enqueue('background', false);
    for (let index = 0; index < 9; index += 1) {
        queue.enqueue(`webhook-${index}`, true);
    }
    const dueAt = (key: string): number => (key === 'deferred' ? 5_000 : 0);
    assert.equal(queue.stats(dueAt).deferred, 1);
    for (let index = 0; index < 8; index += 1) {
        assert.equal(queue.takeDue(dueAt), `webhook-${index}`);
    }
    assert.equal(queue.takeDue(dueAt), 'background');
    now = 5_000;
    assert.equal(queue.takeDue(dueAt), 'deferred');
    assert.equal(queue.takeDue(dueAt), 'webhook-8');
});

void test('failed initial discovery stays unready and retries after the API cooldown', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-scheduler-'));
    const store = new Store(join(directory, 'state.sqlite'));
    let requests = 0;
    const limited = Object.assign(new Error('rate limited'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' } },
    });
    const app = {
        on: () => undefined,
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            requests += 1;
                            return requests === 1 ? Promise.reject(limited) : Promise.resolve({ data: [] });
                        },
                    },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => (await method()).data,
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const runtime = register(app, store, 42, 10_000);
    t.after(async () => {
        await runtime.stop();
        rmSync(directory, { recursive: true, force: true });
    });
    await runtime.drain();
    assert.equal(requests, 1);
    assert.equal(runtime.status().initialDiscoveryComplete, false);
    assert.equal(runtime.status().discovery.failures, 1);
    assert.equal(runtime.status().backoffUntil, 5_000);
    t.mock.timers.tick(4_999);
    await runtime.drain();
    assert.equal(requests, 1);
    t.mock.timers.tick(1);
    await runtime.drain();
    assert.equal(requests, 2);
    assert.equal(runtime.status().initialDiscoveryComplete, true);
    assert.equal(runtime.status().discovery.failures, 1);
    assert.equal(runtime.status().discovery.retryAt, null);
});

void test('lifecycle bursts coalesce and discovery observes reconciliation cooldown', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-discovery-schedule-'));
    const store = new Store(join(directory, 'state.sqlite'));
    let requests = 0;
    const app = {
        auth: () =>
            Promise.resolve({
                rest: {
                    apps: {
                        listInstallations: () => {
                            requests += 1;
                            return Promise.resolve({ data: [] });
                        },
                    },
                },
                paginate: async (method: () => Promise<{ data: unknown }>) => (await method()).data,
            }),
        log: { error: () => undefined },
    } as unknown as Probot;
    const retry = new RetryPolicy();
    const discovery = new Discovery(
        app,
        store,
        () => true,
        () => undefined,
        300_000,
        retry,
    );
    t.after(async () => {
        await discovery.stop();
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    await discovery.drain();
    for (let event = 0; event < 20; event += 1) {
        discovery.requestSoon();
    }
    await discovery.drain();
    assert.equal(requests, 1);
    t.mock.timers.tick(999);
    await discovery.drain();
    assert.equal(requests, 1);
    t.mock.timers.tick(1);
    await discovery.drain();
    assert.equal(requests, 2);
    retry.failure(
        'reconciliation',
        Object.assign(new Error('primary rate limit'), {
            status: 403,
            response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' } },
        }),
    );
    discovery.request();
    await discovery.drain();
    t.mock.timers.tick(3_999);
    await discovery.drain();
    assert.equal(requests, 2);
    t.mock.timers.tick(1);
    await discovery.drain();
    assert.equal(requests, 3);
});

void test('a rate-limited reconciliation preserves the original error and makes no failure writes', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-rate-limit-'));
    const store = new Store(join(directory, 'state.sqlite'));
    t.after(() => {
        store.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const target: Target = {
        key: '1:2',
        owner: 'owner',
        repo: 'repo',
        repositoryId: 1,
        installationId: 3,
        pullNumber: 2,
        headSha: 'head',
        baseSha: 'base',
        mergeSha: null,
        draft: false,
        startedAt: 0,
        activityAt: 0,
        generation: 0,
        checkId: 9,
        reviewId: 8,
        signature: null,
        snapshotHash: null,
        closed: false,
    };
    store.put(target);
    const limited = Object.assign(new Error('secondary rate limit'), {
        status: 403,
        response: { headers: { 'retry-after': '20' } },
    });
    let writes = 0;
    const gateway = {
        pull: () => Promise.reject(limited),
        publish: () => {
            writes += 1;
            return Promise.resolve(9);
        },
        dismiss: () => {
            writes += 1;
            return Promise.resolve();
        },
    } as unknown as Gateway;
    await assert.rejects(new Engine(store).reconcile(target.key, gateway), (error: unknown) => error === limited);
    assert.equal(writes, 0);
});

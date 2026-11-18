import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Health } from '../src/health.js';
import type { RuntimeStatus } from '../src/runtime-status.js';
import { Store } from '../src/store.js';
import type { Target } from '../src/types.js';

function target(key: string, closed: boolean): Target {
    return {
        key,
        owner: 'private-owner',
        repo: 'private-repo',
        repositoryId: 1,
        installationId: 2,
        pullNumber: 3,
        headSha: 'head',
        baseSha: 'base',
        mergeSha: null,
        draft: false,
        startedAt: 0,
        activityAt: 0,
        generation: 0,
        checkId: null,
        reviewId: null,
        signature: null,
        snapshotHash: null,
        closed,
    };
}

void test('health stays live while readiness and metrics reflect startup, staleness, drain, and storage', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-health-'));
    const store = new Store(join(directory, 'state.sqlite'));
    let closed = false;
    const closeStore = (): void => {
        if (!closed) {
            store.close();
            closed = true;
        }
    };
    const state: { runtime: RuntimeStatus | undefined } = { runtime: undefined };
    const health = new Health(
        () => state.runtime,
        store,
        () => ({ lastRunAt: 90_000, failures: 1, targetsPruned: 4, deliveriesPruned: 5 }),
        1000,
    );
    const server = createServer((request, response) => {
        if (!health.handle(request, response)) {
            response.writeHead(404).end();
        }
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        closeStore();
        rmSync(directory, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;

    assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { status: 'ok' });
    const startup = await fetch(`${url}/readyz`);
    assert.equal(startup.status, 503);
    assert.deepEqual(await startup.json(), { status: 'not_ready', reasons: ['initial_discovery'] });
    assert.equal((await fetch(`${url}/metrics`)).status, 503);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    const rejected = await fetch(`${url}/healthz`, { method: 'POST' });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD');

    state.runtime = {
        startedAt: 1000,
        stopping: false,
        initialDiscoveryComplete: true,
        discovery: { running: false, lastAttemptAt: 100_000, lastSuccessAt: 100_000, failures: 2, retryAt: null },
        queue: { webhook: 2, background: 3, deferred: 1, running: true, oldestEnqueuedAt: 99_000 },
        reconcile: { succeeded: 7, failed: 1, lastSuccessAt: 98_000, lastFailureAt: 97_000, lastDurationMs: 250 },
        backoffUntil: null,
    };
    store.put(target('active', false));
    store.put(target('closed', true));
    store.processDelivery('delivery', () => undefined);
    assert.deepEqual(await (await fetch(`${url}/readyz`)).json(), { status: 'ready', reasons: [] });
    const head = await fetch(`${url}/readyz`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.match(metrics, /sahaayaka_queue_webhook 2\n/u);
    assert.match(metrics, /sahaayaka_targets_active 1\n/u);
    assert.match(metrics, /sahaayaka_targets_closed 1\n/u);
    assert.match(metrics, /sahaayaka_deliveries_retained 1\n/u);
    assert.match(metrics, /sahaayaka_retention_targets_pruned_total 4\n/u);
    assert.doesNotMatch(metrics, /private-owner|private-repo|repository=/u);

    t.mock.timers.setTime(101_001);
    const stale = await fetch(`${url}/readyz`);
    assert.equal(stale.status, 503);
    assert.deepEqual(await stale.json(), { status: 'not_ready', reasons: ['discovery_stale'] });
    t.mock.timers.setTime(100_000);
    health.beginShutdown();
    const draining = await fetch(`${url}/readyz`);
    assert.equal(draining.status, 503);
    assert.deepEqual(await draining.json(), { status: 'not_ready', reasons: ['draining'] });
    closeStore();
    const unavailable = await fetch(`${url}/readyz`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: 'not_ready', reasons: ['draining', 'storage_unavailable'] });
    assert.equal((await fetch(`${url}/metrics`)).status, 503);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

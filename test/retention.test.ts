import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { Store } from '../src/store.js';
import type { Target } from '../src/types.js';

const day = 86_400_000;

function target(key: string, closed: boolean): Target {
    return {
        key,
        owner: 'owner',
        repo: 'repo',
        repositoryId: 1,
        installationId: 2,
        pullNumber: Number(key.replace(/\D/gu, '')) || 1,
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

function temporaryPath(t: TestContext): string {
    const directory = mkdtempSync(join(tmpdir(), 'sahaayaka-retention-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, 'state.sqlite');
}

void test('migration gives old closed rows a full grace period', (t) => {
    const path = temporaryPath(t);
    const oldDatabase = new DatabaseSync(path);
    oldDatabase.exec('CREATE TABLE targets (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    oldDatabase
        .prepare('INSERT INTO targets (key, data) VALUES (?, ?)')
        .run('closed', JSON.stringify(target('closed', true)));
    oldDatabase.close();
    t.mock.method(Date, 'now', () => 50_000);
    const store = new Store(path);
    t.after(() => store.close());
    assert.equal(store.prune(1000, 50_999).targets, 0);
    assert.ok(store.get('closed'));
    assert.equal(store.prune(1000, 51_001).targets, 1);
    assert.equal(store.get('closed'), undefined);
});

void test('repeated close preserves age while reopening starts a fresh retention period', (t) => {
    const store = new Store(temporaryPath(t));
    t.after(() => store.close());
    store.put(target('repeated', true), 1000);
    store.put(target('repeated', true), 5000);
    assert.equal(store.prune(10_000, 12_000).targets, 1);
    assert.equal(store.get('repeated'), undefined);

    store.put(target('reopened', true), 1000);
    store.put(target('reopened', false), 2000);
    store.put(target('reopened', true), 9000);
    assert.equal(store.prune(10_000, 12_000).targets, 0);
    assert.ok(store.get('reopened'));
    assert.equal(store.prune(10_000, 20_000).targets, 1);
});

void test('prune uses 1000-row batches and preserves active targets and access tombstones', (t) => {
    const store = new Store(temporaryPath(t));
    t.after(() => store.close());
    store.retireInstallation(3);
    store.retireRepository(4, 5);
    store.put(target('active', false), 1000);
    for (let index = 0; index < 1002; index += 1) {
        store.put(target(`closed-${index}`, true), 1000);
        store.processDelivery(`delivery-${index}`, () => undefined, 1000);
    }
    const now = 7 * day + 2000;
    assert.deepEqual(store.prune(1000, now), { targets: 1000, deliveries: 1000 });
    assert.deepEqual(store.counts(), { activeTargets: 1, closedTargets: 2, deliveries: 2 });
    assert.deepEqual(store.prune(1000, now), { targets: 2, deliveries: 2 });
    assert.deepEqual(store.counts(), { activeTargets: 1, closedTargets: 0, deliveries: 0 });
    assert.ok(store.get('active'));
    assert.equal(store.installationDenied(3), true);
    assert.equal(store.repositoryDenied(4, 5), true);
});

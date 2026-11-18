import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings } from '../src/settings.js';

void test('settings apply bounded defaults and normalize the repository allowlist', () => {
    const defaults = readSettings({ APP_ID: '42' });
    assert.equal(defaults.appId, 42);
    assert.equal(defaults.interval, 30_000);
    assert.equal(defaults.port, 3000);
    assert.equal(defaults.host, '127.0.0.1');
    assert.equal(defaults.shutdownTimeoutMs, 30_000);
    assert.equal(defaults.retentionMs, 30 * 86_400_000);
    assert.equal(defaults.maxDiscoveryAgeMs, 900_000);
    assert.equal(defaults.repositories, undefined);

    const configured = readSettings({
        APP_ID: '7',
        RECONCILE_INTERVAL_MS: '1000',
        PORT: '65535',
        HOST: '0.0.0.0',
        SHUTDOWN_TIMEOUT_MS: '600000',
        CLOSED_TARGET_RETENTION_DAYS: '3650',
        READINESS_MAX_DISCOVERY_AGE_MS: '86400000',
        REPOSITORY_ALLOWLIST: ' Owner/Repo,owner/repo, Team.Service/Project-1 ',
    });
    assert.equal(configured.retentionMs, 3650 * 86_400_000);
    assert.equal(configured.interval, 1000);
    assert.equal(configured.port, 65535);
    assert.equal(configured.host, '0.0.0.0');
    assert.equal(configured.shutdownTimeoutMs, 600_000);
    assert.equal(configured.maxDiscoveryAgeMs, 86_400_000);
    assert.deepEqual([...(configured.repositories ?? [])], ['owner/repo', 'team.service/project-1']);
});

void test('each numeric setting rejects out-of-range and non-integer values', () => {
    const limits = [
        ['APP_ID', 1, Number.MAX_SAFE_INTEGER],
        ['RECONCILE_INTERVAL_MS', 1000, 3_600_000],
        ['PORT', 1, 65_535],
        ['SHUTDOWN_TIMEOUT_MS', 1000, 600_000],
        ['CLOSED_TARGET_RETENTION_DAYS', 1, 3650],
        ['READINESS_MAX_DISCOVERY_AGE_MS', 1000, 86_400_000],
    ] as const;
    for (const [name, minimum, maximum] of limits) {
        for (const value of [minimum - 1, maximum + 1, 1.5, Number.POSITIVE_INFINITY]) {
            assert.throws(() => readSettings({ APP_ID: '42', [name]: String(value) }), new RegExp(name, 'u'));
        }
        assert.doesNotThrow(() => readSettings({ APP_ID: '42', [name]: String(minimum) }));
        assert.doesNotThrow(() => readSettings({ APP_ID: '42', [name]: String(maximum) }));
    }
    assert.throws(() => readSettings({ APP_ID: '' }), /APP_ID/u);
    assert.throws(() => readSettings({ APP_ID: '9007199254740992' }), /APP_ID/u);
});

void test('allowlist rejects malformed entries instead of silently widening access', () => {
    for (const value of ['', 'owner', '/repo', 'owner/', 'owner/repo,', 'owner/repo/sub', 'owner/with space']) {
        assert.throws(() => readSettings({ APP_ID: '42', REPOSITORY_ALLOWLIST: value }), /REPOSITORY_ALLOWLIST/u);
    }
});

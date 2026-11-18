import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Probot } from 'probot';
import { RetryPolicy, SahaayakaOctokit, isRateLimitError } from '../src/retry.js';

for (const { name, status, message, headers } of [
    {
        name: 'primary rate limit',
        status: 403,
        message: 'API rate limit exceeded',
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 2) },
    },
    {
        name: 'secondary rate limit',
        status: 403,
        message: 'You have exceeded a secondary rate limit.',
        headers: { 'retry-after': '1' },
    },
    {
        name: 'HTTP 429',
        status: 429,
        message: 'Too many requests',
        headers: { 'retry-after': '1' },
    },
]) {
    void test(`Probot passes ${name} to the work queue without retrying`, async () => {
        let attempts = 0;
        const app = new Probot({
            githubToken: 'test',
            Octokit: SahaayakaOctokit,
            logLevel: 'silent',
            request: {
                fetch: (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
                    attempts += 1;
                    assert.equal(attempts, 1, 'Octokit retried a rate-limited request');
                    const response = Response.json({ message }, { status, headers });
                    Object.defineProperty(response, 'url', { value: input instanceof Request ? input.url : input });
                    return Promise.resolve(response);
                },
            },
        });
        await app.ready();
        const octokit = await app.auth(1);
        await assert.rejects(octokit.rest.repos.get({ owner: 'owner', repo: 'repo' }), isRateLimitError);
        assert.equal(attempts, 1);
    });
}

void test('per-key retries grow exponentially and remain bounded', () => {
    let now = 0;
    const retry = new RetryPolicy(() => now);
    assert.equal(retry.failure('a', new Error('temporary')), 1_000);
    assert.equal(retry.failure('a', new Error('temporary')), 2_000);
    assert.equal(retry.failure('b', new Error('temporary')), 1_000);
    for (let attempt = 0; attempt < 30; attempt += 1) {
        retry.failure('a', new Error('temporary'));
    }
    assert.equal(retry.retryAt('a'), 300_000);
    now = 1_000;
    assert.equal(retry.dueAt('b'), 1_000);
    retry.success('b');
    assert.equal(retry.failures('b'), 0);
});

void test('primary 403, secondary 403, and 429 set a shared cooldown', () => {
    let now = 1_000;
    const retry = new RetryPolicy(() => now);
    const primary = Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '11' } },
    });
    assert.equal(isRateLimitError(primary), true);
    assert.equal(retry.failure('a', primary), 11_000);
    assert.equal(retry.dueAt('unrelated'), 11_000);
    const secondary = Object.assign(new Error('secondary rate limit'), {
        status: 403,
        response: { headers: { 'Retry-After': '30' } },
    });
    assert.equal(retry.failure('b', secondary), 31_000);
    assert.equal(retry.dueAt('a'), 31_000);
    const tooMany = Object.assign(new Error('too many'), { status: 429, response: { headers: new Headers() } });
    assert.equal(retry.failure('c', tooMany), 61_000);
    assert.equal(retry.backoffUntil, 61_000);
    now = 61_000;
    assert.equal(retry.backoffUntil, null);
    assert.equal(retry.dueAt('new webhook'), 61_000);
});

void test('ordinary 403 does not block unrelated work', () => {
    const denied = Object.assign(new Error('forbidden'), { status: 403, response: { headers: {} } });
    const retry = new RetryPolicy(() => 0);
    assert.equal(isRateLimitError(denied), false);
    assert.equal(retry.failure('a', denied), 1_000);
    assert.equal(retry.dueAt('b'), 0);
});

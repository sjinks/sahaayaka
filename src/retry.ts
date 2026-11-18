const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

interface ApiError {
    status?: unknown;
    message?: unknown;
    response?: { headers?: unknown };
    headers?: unknown;
}

function header(headers: unknown, name: string): string | undefined {
    if (headers instanceof Headers) {
        return headers.get(name) ?? undefined;
    }
    if (typeof headers !== 'object' || headers === null) {
        return undefined;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name && (typeof value === 'string' || typeof value === 'number')) {
            return String(value);
        }
    }
    return undefined;
}

function retryAfterDelay(retryAfter: string | undefined, now: number): number | null {
    if (retryAfter === undefined) {
        return null;
    }
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1_000;
    }
    const date = Date.parse(retryAfter);
    return Number.isFinite(date) ? date - now : null;
}

function rateLimitUntil(error: unknown, now: number): number | null {
    if (typeof error !== 'object' || error === null) {
        return null;
    }
    const apiError = error as ApiError;
    if (apiError.status !== 403 && apiError.status !== 429) {
        return null;
    }
    const headers = apiError.response?.headers ?? apiError.headers;
    const remaining = header(headers, 'x-ratelimit-remaining');
    const reset = Number(header(headers, 'x-ratelimit-reset'));
    const retryAfter = header(headers, 'retry-after');
    const secondary =
        typeof apiError.message === 'string' && /secondary rate limit|abuse detection/iu.test(apiError.message);
    if (apiError.status === 403 && remaining !== '0' && retryAfter === undefined && !secondary) {
        return null;
    }
    const delay =
        retryAfterDelay(retryAfter, now) ??
        (remaining === '0' && Number.isFinite(reset) && reset > 0 ? reset * 1_000 - now : RATE_LIMIT_FALLBACK_MS);
    return now + Math.max(BASE_DELAY_MS, Math.min(Number.MAX_SAFE_INTEGER - now, delay));
}

export function isRateLimitError(error: unknown): boolean {
    return rateLimitUntil(error, Date.now()) !== null;
}

interface RetryState {
    failures: number;
    retryAt: number;
}

export class RetryPolicy {
    private readonly states = new Map<string, RetryState>();
    private cooldownUntil = 0;

    public constructor(private readonly now: () => number = Date.now) {}

    public failure(key: string, error: unknown): number {
        const current = this.states.get(key);
        const failures = (current?.failures ?? 0) + 1;
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(failures - 1, 20));
        const limitedUntil = rateLimitUntil(error, this.now());
        if (limitedUntil !== null) {
            this.cooldownUntil = Math.max(this.cooldownUntil, limitedUntil);
        }
        const retryAt = Math.max(this.now() + delay, this.cooldownUntil);
        this.states.set(key, { failures, retryAt });
        return retryAt;
    }

    public success(key: string): void {
        this.states.delete(key);
    }

    public retryAt(key: string): number | null {
        return this.states.get(key)?.retryAt ?? null;
    }

    public failures(key: string): number {
        return this.states.get(key)?.failures ?? 0;
    }

    public dueAt(key: string): number {
        return Math.max(this.states.get(key)?.retryAt ?? 0, this.cooldownUntil);
    }

    public get backoffUntil(): number | null {
        return this.cooldownUntil > this.now() ? this.cooldownUntil : null;
    }
}

export interface Settings {
    appId: number;
    interval: number;
    port: number;
    host: string;
    shutdownTimeoutMs: number;
    retentionMs: number;
    maxDiscoveryAgeMs: number;
    repositories: ReadonlySet<string> | undefined;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
    const names = env.REPOSITORY_ALLOWLIST?.split(',').map((name) => name.trim().toLowerCase());
    if (names?.some((name) => !/^[\w.-]+\/[\w.-]+$/u.test(name))) {
        throw new Error('REPOSITORY_ALLOWLIST must contain comma-separated owner/repository names.');
    }
    return {
        appId: integer(env, 'APP_ID', 0, 1, Number.MAX_SAFE_INTEGER),
        interval: integer(env, 'RECONCILE_INTERVAL_MS', 30000, 1000, 3600000),
        port: integer(env, 'PORT', 3000, 1, 65535),
        host: env.HOST ?? '127.0.0.1',
        shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 30000, 1000, 600000),
        retentionMs: integer(env, 'CLOSED_TARGET_RETENTION_DAYS', 30, 1, 3650) * 86400000,
        maxDiscoveryAgeMs: integer(env, 'READINESS_MAX_DISCOVERY_AGE_MS', 900000, 1000, 86400000),
        repositories: names === undefined ? undefined : new Set(names),
    };
}

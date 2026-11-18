export interface RuntimeStatus {
    startedAt: number;
    stopping: boolean;
    initialDiscoveryComplete: boolean;
    discovery: {
        running: boolean;
        lastAttemptAt: number | null;
        lastSuccessAt: number | null;
        failures: number;
        retryAt: number | null;
    };
    queue: {
        webhook: number;
        background: number;
        running: boolean;
        oldestEnqueuedAt: number | null;
        deferred: number;
    };
    reconcile: {
        succeeded: number;
        failed: number;
        lastSuccessAt: number | null;
        lastFailureAt: number | null;
        lastDurationMs: number | null;
    };
    backoffUntil: number | null;
}

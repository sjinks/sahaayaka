import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeStatus } from './runtime-status.js';
import type { MaintenanceStatus } from './maintenance.js';
import { Store } from './store.js';

function seconds(timestamp: number | null): number {
    return timestamp === null ? 0 : timestamp / 1000;
}

function metrics(
    status: RuntimeStatus,
    storage: ReturnType<Store['counts']>,
    cleanup: MaintenanceStatus,
    now: number,
): string {
    const values: Record<string, number> = {
        process_start_time_seconds: seconds(status.startedAt),
        queue_webhook: status.queue.webhook,
        queue_background: status.queue.background,
        queue_deferred: status.queue.deferred,
        worker_running: Number(status.queue.running),
        queue_oldest_age_seconds:
            status.queue.oldestEnqueuedAt === null ? 0 : Math.max(0, now - status.queue.oldestEnqueuedAt) / 1000,
        reconcile_success_total: status.reconcile.succeeded,
        reconcile_failure_total: status.reconcile.failed,
        reconcile_last_success_timestamp_seconds: seconds(status.reconcile.lastSuccessAt),
        reconcile_last_failure_timestamp_seconds: seconds(status.reconcile.lastFailureAt),
        reconcile_last_duration_seconds: (status.reconcile.lastDurationMs ?? 0) / 1000,
        discovery_running: Number(status.discovery.running),
        discovery_failure_total: status.discovery.failures,
        discovery_last_success_timestamp_seconds: seconds(status.discovery.lastSuccessAt),
        discovery_next_retry_timestamp_seconds: seconds(status.discovery.retryAt),
        backoff_remaining_seconds: Math.max(0, (status.backoffUntil ?? now) - now) / 1000,
        targets_active: storage.activeTargets,
        targets_closed: storage.closedTargets,
        deliveries_retained: storage.deliveries,
        retention_targets_pruned_total: cleanup.targetsPruned,
        retention_deliveries_pruned_total: cleanup.deliveriesPruned,
        retention_failure_total: cleanup.failures,
        retention_last_run_timestamp_seconds: seconds(cleanup.lastRunAt),
    };
    return Object.entries(values)
        .map(([name, value]) => {
            const type = name.endsWith('_total') ? 'counter' : 'gauge';
            return `# TYPE sahaayaka_${name} ${type}\nsahaayaka_${name} ${value}\n`;
        })
        .join('');
}

export class Health {
    private draining = false;

    public constructor(
        private readonly runtime: () => RuntimeStatus | undefined,
        private readonly store: Store,
        private readonly maintenance: () => MaintenanceStatus,
        private readonly maxDiscoveryAgeMs = 900000,
    ) {}

    public beginShutdown(): void {
        this.draining = true;
    }

    private readiness(status: RuntimeStatus | undefined, now: number): string[] {
        const reasons: string[] = [];
        if (this.draining || status?.stopping) {
            reasons.push('draining');
        }
        if (!status?.initialDiscoveryComplete || status.discovery.lastSuccessAt === null) {
            reasons.push('initial_discovery');
        } else if (now - status.discovery.lastSuccessAt > this.maxDiscoveryAgeMs) {
            reasons.push('discovery_stale');
        }
        if (!this.store.ping()) {
            reasons.push('storage_unavailable');
        }
        return reasons;
    }

    public handle(request: IncomingMessage, response: ServerResponse): boolean {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!['/healthz', '/readyz', '/metrics'].includes(pathname)) {
            return false;
        }
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return true;
        }
        if (pathname === '/healthz') {
            Health.json(response, 200, { status: 'ok' }, request.method);
            return true;
        }
        const status = this.runtime();
        if (pathname === '/readyz') {
            const reasons = this.readiness(status, Date.now());
            Health.json(
                response,
                reasons.length ? 503 : 200,
                { status: reasons.length ? 'not_ready' : 'ready', reasons },
                request.method,
            );
            return true;
        }
        if (!status || !this.store.ping()) {
            Health.json(response, 503, { status: 'not_ready' }, request.method);
            return true;
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end(
            request.method === 'HEAD'
                ? undefined
                : metrics(status, this.store.counts(), this.maintenance(), Date.now()),
        );
        return true;
    }

    private static json(response: ServerResponse, code: number, value: unknown, method: string): void {
        response.writeHead(code, { 'Content-Type': 'application/json' });
        response.end(method === 'HEAD' ? undefined : JSON.stringify(value));
    }
}

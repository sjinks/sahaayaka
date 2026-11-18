import type { Logger } from 'probot';
import { Store } from './store.js';

export interface MaintenanceStatus {
    lastRunAt: number | null;
    failures: number;
    targetsPruned: number;
    deliveriesPruned: number;
}

export class Maintenance {
    private readonly timer: ReturnType<typeof setInterval>;
    private readonly state: MaintenanceStatus = { lastRunAt: null, failures: 0, targetsPruned: 0, deliveriesPruned: 0 };

    public constructor(
        private readonly store: Store,
        private readonly retentionMs: number,
        private readonly log: Pick<Logger, 'error'>,
    ) {
        this.run();
        this.timer = setInterval(() => this.run(), 60000);
        this.timer.unref();
    }

    private run(): void {
        this.state.lastRunAt = Date.now();
        try {
            const result = this.store.prune(this.retentionMs);
            this.state.targetsPruned += result.targets;
            this.state.deliveriesPruned += result.deliveries;
        } catch (error) {
            this.state.failures += 1;
            this.log.error(
                { message: error instanceof Error ? error.message : 'Unknown storage error' },
                'Retention cleanup failed',
            );
        }
    }

    public status(): MaintenanceStatus {
        return { ...this.state };
    }

    public stop(): void {
        clearInterval(this.timer);
    }
}

interface QueueEntry {
    key: string;
    webhook: boolean;
    enqueuedAt: number;
}

export class WorkQueue {
    private readonly entries = new Map<string, QueueEntry>();
    private webhookBurst = 0;

    public constructor(private readonly now: () => number = Date.now) {}

    public enqueue(key: string, webhook: boolean): void {
        const existing = this.entries.get(key);
        if (existing) {
            existing.webhook ||= webhook;
            return;
        }
        this.entries.set(key, { key, webhook, enqueuedAt: this.now() });
    }

    public takeDue(dueAt: (key: string) => number): string | null {
        let webhook: QueueEntry | undefined;
        let background: QueueEntry | undefined;
        for (const entry of this.entries.values()) {
            if (dueAt(entry.key) > this.now()) {
                continue;
            }
            if (entry.webhook) {
                webhook ??= entry;
            } else {
                background ??= entry;
            }
        }
        const selected = this.webhookBurst < 8 ? (webhook ?? background) : (background ?? webhook);
        if (!selected) {
            return null;
        }
        this.entries.delete(selected.key);
        this.webhookBurst = selected.webhook ? this.webhookBurst + 1 : 0;
        return selected.key;
    }

    public nextDueAt(dueAt: (key: string) => number): number | null {
        let next: number | null = null;
        for (const entry of this.entries.values()) {
            const due = dueAt(entry.key);
            next = next === null ? due : Math.min(next, due);
        }
        return next;
    }

    public stats(dueAt: (key: string) => number): {
        webhook: number;
        background: number;
        oldestEnqueuedAt: number | null;
        deferred: number;
    } {
        let webhook = 0;
        let background = 0;
        let oldestEnqueuedAt: number | null = null;
        let deferred = 0;
        for (const entry of this.entries.values()) {
            if (entry.webhook) {
                webhook += 1;
            } else {
                background += 1;
            }
            oldestEnqueuedAt =
                oldestEnqueuedAt === null ? entry.enqueuedAt : Math.min(oldestEnqueuedAt, entry.enqueuedAt);
            deferred += Number(dueAt(entry.key) > this.now());
        }
        return { webhook, background, oldestEnqueuedAt, deferred };
    }
}

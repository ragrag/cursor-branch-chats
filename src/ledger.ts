import * as fs from 'fs';
import * as path from 'path';

export type LinkOrigin = 'auto' | 'manual';

export interface LedgerEntry {
    branch: string;
    capturedAt: number;
    origin: LinkOrigin;
}

interface LedgerFile {
    version: 1;
    entries: Record<string, LedgerEntry>;
}

const LEDGER_FILENAME = 'branch-chat-index.json';

/**
 * The ledger lives next to the transcripts (one level up, inside the project dir)
 * so it travels with the project's Cursor state rather than the extension install.
 */
export class BranchLedger {
    private readonly filePath: string;
    private data: LedgerFile;

    constructor(transcriptsDir: string) {
        this.filePath = path.join(path.dirname(transcriptsDir), LEDGER_FILENAME);
        this.data = this.load();
    }

    private load(): LedgerFile {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as LedgerFile;
            if (parsed && parsed.version === 1 && parsed.entries) {
                // Backfill origin for ledgers written by older versions.
                for (const entry of Object.values(parsed.entries)) {
                    if (entry.origin !== 'manual' && entry.origin !== 'auto') {
                        entry.origin = 'auto';
                    }
                }
                return parsed;
            }
        } catch {
            /* fall through to fresh ledger */
        }
        return { version: 1, entries: {} };
    }

    private persist(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch {
            /* best-effort; capture is non-critical */
        }
    }

    has(conversationId: string): boolean {
        return Boolean(this.data.entries[conversationId]);
    }

    get(conversationId: string): LedgerEntry | undefined {
        return this.data.entries[conversationId];
    }

    /** Auto-records a branch for a conversation only if not already known (first-seen wins). */
    capture(conversationId: string, branch: string): boolean {
        if (this.data.entries[conversationId]) {
            return false;
        }
        this.data.entries[conversationId] = { branch, capturedAt: Date.now(), origin: 'auto' };
        this.persist();
        return true;
    }

    /** Manually (re)assign a conversation to a branch. Overwrites any existing link. */
    link(conversationId: string, branch: string): void {
        this.data.entries[conversationId] = { branch, capturedAt: Date.now(), origin: 'manual' };
        this.persist();
    }

    /** Remove a conversation's branch link entirely. */
    unlink(conversationId: string): boolean {
        if (!this.data.entries[conversationId]) {
            return false;
        }
        delete this.data.entries[conversationId];
        this.persist();
        return true;
    }

    all(): Record<string, LedgerEntry> {
        return this.data.entries;
    }
}

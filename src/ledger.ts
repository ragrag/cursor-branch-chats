import * as fs from 'fs';
import * as path from 'path';

export type LinkOrigin = 'auto' | 'manual';

/** A single (conversation -> branch) association. A conversation may have many. */
export interface BranchLink {
    branch: string;
    origin: LinkOrigin;
    capturedAt: number;
}

interface ConversationEntry {
    links: BranchLink[];
}

interface LedgerFileV2 {
    version: 2;
    entries: Record<string, ConversationEntry>;
}

/** Legacy single-branch shape (one entry per conversation). */
interface LedgerEntryV1 {
    branch: string;
    capturedAt: number;
    origin?: LinkOrigin;
}
interface LedgerFileV1 {
    version: 1;
    entries: Record<string, LedgerEntryV1>;
}

const LEDGER_FILENAME = 'branch-chat-index.json';

/**
 * The ledger lives next to the transcripts (one level up, inside the project dir)
 * so it travels with the project's Cursor state rather than the extension install.
 *
 * A conversation can be linked to multiple branches: it accumulates every branch
 * it was actively worked on (auto) plus any you link by hand (manual).
 */
export class BranchLedger {
    private readonly filePath: string;
    private data: LedgerFileV2;

    constructor(transcriptsDir: string) {
        this.filePath = path.join(path.dirname(transcriptsDir), LEDGER_FILENAME);
        this.data = this.load();
    }

    private load(): LedgerFileV2 {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<LedgerFileV2 | LedgerFileV1>;
            if (parsed && parsed.version === 2 && parsed.entries) {
                return this.sanitizeV2(parsed as LedgerFileV2);
            }
            if (parsed && parsed.version === 1 && parsed.entries) {
                return this.migrateV1(parsed as LedgerFileV1);
            }
        } catch {
            /* fall through to fresh ledger */
        }
        return { version: 2, entries: {} };
    }

    private sanitizeV2(file: LedgerFileV2): LedgerFileV2 {
        const entries: Record<string, ConversationEntry> = {};
        for (const [id, entry] of Object.entries(file.entries)) {
            const links = Array.isArray(entry?.links) ? entry.links : [];
            const cleaned: BranchLink[] = [];
            for (const link of links) {
                if (!link || typeof link.branch !== 'string' || !link.branch) {
                    continue;
                }
                if (cleaned.some(l => l.branch === link.branch)) {
                    continue;
                }
                cleaned.push({
                    branch: link.branch,
                    origin: link.origin === 'manual' ? 'manual' : 'auto',
                    capturedAt: typeof link.capturedAt === 'number' ? link.capturedAt : Date.now(),
                });
            }
            if (cleaned.length > 0) {
                entries[id] = { links: cleaned };
            }
        }
        return { version: 2, entries };
    }

    private migrateV1(file: LedgerFileV1): LedgerFileV2 {
        const entries: Record<string, ConversationEntry> = {};
        for (const [id, entry] of Object.entries(file.entries)) {
            if (!entry || typeof entry.branch !== 'string' || !entry.branch) {
                continue;
            }
            entries[id] = {
                links: [
                    {
                        branch: entry.branch,
                        origin: entry.origin === 'manual' ? 'manual' : 'auto',
                        capturedAt: typeof entry.capturedAt === 'number' ? entry.capturedAt : Date.now(),
                    },
                ],
            };
        }
        const migrated: LedgerFileV2 = { version: 2, entries };
        this.data = migrated;
        this.persist();
        return migrated;
    }

    private persist(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch {
            /* best-effort; capture is non-critical */
        }
    }

    /** True if the conversation is linked to at least one branch. */
    has(conversationId: string): boolean {
        return (this.data.entries[conversationId]?.links.length ?? 0) > 0;
    }

    /** True if the conversation is linked to this specific branch. */
    hasBranch(conversationId: string, branch: string): boolean {
        return Boolean(this.data.entries[conversationId]?.links.some(l => l.branch === branch));
    }

    /** All branch links for a conversation (empty when unlinked). */
    branches(conversationId: string): BranchLink[] {
        return this.data.entries[conversationId]?.links ?? [];
    }

    /**
     * Auto-records a branch for a conversation. Adds the branch if not already
     * linked; existing links (including manual ones) are left untouched. Returns
     * true only when a new branch link was actually added.
     */
    capture(conversationId: string, branch: string): boolean {
        return this.addLink(conversationId, branch, 'auto');
    }

    /**
     * Manually link a conversation to a branch (additive). If the branch is already
     * linked, its origin is upgraded to 'manual'. Returns true when a new branch
     * link was added.
     */
    link(conversationId: string, branch: string): boolean {
        return this.addLink(conversationId, branch, 'manual');
    }

    private addLink(conversationId: string, branch: string, origin: LinkOrigin): boolean {
        const entry = this.data.entries[conversationId] ?? { links: [] };
        const existing = entry.links.find(l => l.branch === branch);
        if (existing) {
            // Upgrade an auto link to manual when explicitly linked by the user.
            if (origin === 'manual' && existing.origin !== 'manual') {
                existing.origin = 'manual';
                this.data.entries[conversationId] = entry;
                this.persist();
            }
            return false;
        }
        entry.links.push({ branch, origin, capturedAt: Date.now() });
        this.data.entries[conversationId] = entry;
        this.persist();
        return true;
    }

    /** Remove a single branch link from a conversation. */
    unlink(conversationId: string, branch: string): boolean {
        const entry = this.data.entries[conversationId];
        if (!entry) {
            return false;
        }
        const next = entry.links.filter(l => l.branch !== branch);
        if (next.length === entry.links.length) {
            return false;
        }
        if (next.length === 0) {
            delete this.data.entries[conversationId];
        } else {
            entry.links = next;
        }
        this.persist();
        return true;
    }

    /** Remove a branch from every conversation. Returns the number of links removed. */
    deleteBranch(branch: string): number {
        let removed = 0;
        for (const [id, entry] of Object.entries(this.data.entries)) {
            const next = entry.links.filter(l => l.branch !== branch);
            if (next.length === entry.links.length) {
                continue;
            }
            removed += entry.links.length - next.length;
            if (next.length === 0) {
                delete this.data.entries[id];
            } else {
                entry.links = next;
            }
        }
        if (removed > 0) {
            this.persist();
        }
        return removed;
    }

    /** Remove a conversation from every branch. */
    unlinkAll(conversationId: string): boolean {
        if (!this.data.entries[conversationId]) {
            return false;
        }
        delete this.data.entries[conversationId];
        this.persist();
        return true;
    }

    all(): Record<string, ConversationEntry> {
        return this.data.entries;
    }
}

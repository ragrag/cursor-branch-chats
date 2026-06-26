import * as vscode from 'vscode';
import { ComposerHeader } from './composer';
import { BranchLedger, LinkOrigin } from './ledger';
import { Conversation, listConversations } from './transcripts';

type NodeKind = 'branch' | 'unlinked' | 'conversation';

/** Sentinel group key for conversations that have no branch link. */
export const UNLINKED_GROUP = '__unlinked__';

export interface EnrichedConversation {
    conv: Conversation;
    branch: string | null;
    origin: LinkOrigin | null;
    name: string;
    startedAt: number;
    lastActivity: number;
    subtitle?: string;
}

export class TreeNode extends vscode.TreeItem {
    constructor(
        public readonly kind: NodeKind,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly conversation?: Conversation,
        public readonly branchName?: string,
        public readonly origin?: LinkOrigin | null,
    ) {
        super(label, collapsibleState);
    }
}

function relativeTime(ts: number): string {
    if (!ts) {
        return '';
    }
    const diff = Date.now() - ts;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mon = Math.round(day / 30);
    return `${mon}mo ago`;
}

interface ProviderConfig {
    ignoredBranches: string[];
    showUnlinked: boolean;
}

export class BranchChatsProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this.emitter.event;

    private cache: Map<string, EnrichedConversation[]> = new Map();

    constructor(
        private readonly transcriptsDir: string,
        private readonly ledger: BranchLedger,
        private readonly getCurrentBranch: () => string | undefined,
        private readonly loadHeaders: () => Promise<Map<string, ComposerHeader>>,
    ) {}

    refresh(): void {
        this.emitter.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            this.cache = await this.computeGroups();
            return this.rootGroups();
        }
        if (element.kind === 'branch') {
            return this.conversationNodes(this.cache.get(element.branchName ?? '') ?? []);
        }
        if (element.kind === 'unlinked') {
            return this.conversationNodes(this.cache.get(UNLINKED_GROUP) ?? []);
        }
        return [];
    }

    private config(): ProviderConfig {
        const cfg = vscode.workspace.getConfiguration('branchChats');
        const ignored = cfg.get<string[]>('ignoredBranches', ['main', 'master']);
        return {
            ignoredBranches: (ignored ?? []).map(b => b.trim()).filter(Boolean),
            showUnlinked: cfg.get<boolean>('showUnlinked', false),
        };
    }

    private async computeGroups(): Promise<Map<string, EnrichedConversation[]>> {
        const headers = await this.loadHeaders();
        const conversations = listConversations(this.transcriptsDir);
        const map = new Map<string, EnrichedConversation[]>();

        for (const conv of conversations) {
            const entry = this.ledger.get(conv.id);
            const header = headers.get(conv.id);
            const branch = entry?.branch ?? null;
            const enriched: EnrichedConversation = {
                conv,
                branch,
                origin: entry?.origin ?? null,
                name: header?.name?.trim() || conv.title,
                startedAt: header?.createdAt ?? conv.startedAt,
                lastActivity: header?.lastUpdatedAt ?? conv.updatedAt ?? conv.startedAt,
                subtitle: header?.subtitle,
            };
            const key = branch ?? UNLINKED_GROUP;
            const bucket = map.get(key) ?? [];
            bucket.push(enriched);
            map.set(key, bucket);
        }

        for (const bucket of map.values()) {
            bucket.sort((a, b) => b.lastActivity - a.lastActivity);
        }
        return map;
    }

    private rootGroups(): TreeNode[] {
        const { ignoredBranches, showUnlinked } = this.config();
        const current = this.getCurrentBranch();
        const ignored = new Set(ignoredBranches);

        const branches = [...this.cache.keys()].filter(key => {
            if (key === UNLINKED_GROUP) {
                return false;
            }
            // Always show the branch you're currently on, even if it's "ignored".
            return key === current || !ignored.has(key);
        });

        branches.sort((a, b) => {
            if (a === current) return -1;
            if (b === current) return 1;
            const aLatest = this.cache.get(a)?.[0]?.lastActivity ?? 0;
            const bLatest = this.cache.get(b)?.[0]?.lastActivity ?? 0;
            return bLatest - aLatest;
        });

        const nodes = branches.map(branch => {
            const count = this.cache.get(branch)!.length;
            const isCurrent = branch === current;
            const node = new TreeNode(
                'branch',
                branch,
                isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                branch,
            );
            node.description = `${count}${isCurrent ? ' · current' : ''}`;
            node.contextValue = 'branch';
            node.iconPath = new vscode.ThemeIcon('git-branch', isCurrent ? new vscode.ThemeColor('charts.green') : undefined);
            return node;
        });

        const unlinked = this.cache.get(UNLINKED_GROUP) ?? [];
        if (showUnlinked && unlinked.length > 0) {
            const node = new TreeNode('unlinked', 'Unlinked', vscode.TreeItemCollapsibleState.Collapsed, undefined, UNLINKED_GROUP);
            node.description = `${unlinked.length}`;
            node.contextValue = 'unlinked';
            node.iconPath = new vscode.ThemeIcon('question');
            node.tooltip = 'Conversations not linked to any branch. Right-click to link one.';
            nodes.push(node);
        }

        return nodes;
    }

    private conversationNodes(items: EnrichedConversation[]): TreeNode[] {
        return items.map(item => {
            const isManual = item.origin === 'manual';
            const isUnlinked = item.branch === null;
            const node = new TreeNode('conversation', item.name, vscode.TreeItemCollapsibleState.None, item.conv, item.branch ?? undefined, item.origin);
            node.description = relativeTime(item.lastActivity);
            node.contextValue = isUnlinked ? 'conversation-unlinked' : 'conversation';
            node.iconPath = new vscode.ThemeIcon(
                isUnlinked ? 'comment-discussion' : isManual ? 'link' : 'comment-discussion',
                isManual ? new vscode.ThemeColor('charts.blue') : undefined,
            );

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`**${escapeMd(item.name)}**\n\n`);
            if (item.subtitle) {
                tooltip.appendMarkdown(`${escapeMd(item.subtitle)}\n\n`);
            }
            if (item.branch) {
                const how = isManual ? 'linked manually' : 'captured automatically';
                tooltip.appendMarkdown(`Branch: \`${escapeMd(item.branch)}\` _(${how})_\n\n`);
            } else {
                tooltip.appendMarkdown(`_Not linked to a branch_\n\n`);
            }
            tooltip.appendMarkdown(`Started ${relativeTime(item.startedAt)} · Last active ${relativeTime(item.lastActivity)}\n\n`);
            tooltip.appendMarkdown(`\`${item.conv.id}\``);
            node.tooltip = tooltip;

            node.command = {
                command: 'branchChats.open',
                title: 'Open Conversation',
                arguments: [item.conv],
            };
            return node;
        });
    }
}

function escapeMd(s: string): string {
    return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, c => `\\${c}`);
}

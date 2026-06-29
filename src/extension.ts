import * as vscode from 'vscode';
import { ComposerHeader, getActiveComposerIds, getGlobalComposerHeaders } from './composer';
import { BranchTracker, listLocalBranches } from './git';
import { BranchLedger } from './ledger';
import { openConversation } from './open';
import { BranchChatsProvider, TreeNode } from './tree';
import { Conversation, conversationIdFromPath, listConversations, resolveTranscriptsDir } from './transcripts';

const HEADERS_TTL_MS = 2000;
const ENTER_BRANCH_ITEM = '$(pencil) Enter branch name…';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Branch Chats');
    context.subscriptions.push(output);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        output.appendLine('No workspace folder open; Branch Chats is idle.');
        return;
    }

    const transcriptsDir = resolveTranscriptsDir(workspaceRoot);
    if (!transcriptsDir) {
        output.appendLine(`No Cursor agent-transcripts directory found for ${workspaceRoot}.`);
        vscode.window.showInformationMessage('Branch Chats: no Cursor conversation transcripts found for this workspace yet.');
        return;
    }
    output.appendLine(`Using transcripts: ${transcriptsDir}`);

    const ledger = new BranchLedger(transcriptsDir);
    const tracker = new BranchTracker(workspaceRoot);
    context.subscriptions.push(tracker);
    await tracker.start();

    // Cache composer headers briefly so a refresh doesn't spawn the SQLite reader
    // multiple times in quick succession.
    let headerCache: Map<string, ComposerHeader> | undefined;
    let headerCacheAt = 0;
    const loadHeaders = async (): Promise<Map<string, ComposerHeader>> => {
        if (headerCache && Date.now() - headerCacheAt < HEADERS_TTL_MS) {
            return headerCache;
        }
        headerCache = await getGlobalComposerHeaders(context, output);
        headerCacheAt = Date.now();
        return headerCache;
    };
    const invalidateHeaders = () => {
        headerCache = undefined;
        headerCacheAt = 0;
    };

    // Branch existence is computed lazily on each tree render (one cheap refs walk),
    // not via a dedicated filesystem watcher.
    const provider = new BranchChatsProvider(
        transcriptsDir,
        ledger,
        () => tracker.branch,
        loadHeaders,
        () => listLocalBranches(workspaceRoot),
    );
    const view = vscode.window.createTreeView('branchChats.view', { treeDataProvider: provider });
    context.subscriptions.push(view);

    const refresh = () => {
        invalidateHeaders();
        provider.refresh();
    };

    context.subscriptions.push(
        tracker.onDidChangeBranch(() => {
            output.appendLine(`Current branch: ${tracker.branch ?? '(unknown)'}`);
            refresh();
        }),
    );

    const ignoredBranches = (): Set<string> => {
        const cfg = vscode.workspace.getConfiguration('branchChats');
        return new Set((cfg.get<string[]>('ignoredBranches', ['main', 'master']) ?? []).map(b => b.trim()).filter(Boolean));
    };

    // Forward capture: when Cursor creates a new conversation folder, record the
    // branch that HEAD is on right now (unless that branch is ignored).
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(transcriptsDir), '**'));
    context.subscriptions.push(watcher);

    const handleChange = (uri: vscode.Uri) => {
        const convId = conversationIdFromPath(transcriptsDir, uri.fsPath);
        if (!convId) {
            return;
        }
        const branch = tracker.branch;
        if (!branch || ignoredBranches().has(branch)) {
            return;
        }
        // Additive: a conversation accumulates every branch it is actively worked on.
        // capture() dedupes per-branch, so this is a no-op once this branch is linked.
        if (ledger.capture(convId, branch)) {
            output.appendLine(`Captured ${convId} -> ${branch}`);
            refresh();
        }
    };
    context.subscriptions.push(watcher.onDidCreate(handleChange));
    context.subscriptions.push(watcher.onDidChange(handleChange));

    const resolveConversation = async (node: TreeNode | undefined, preferUnlinked: boolean): Promise<Conversation | undefined> => {
        if (node?.conversation) {
            return node.conversation;
        }
        return pickConversation(transcriptsDir, ledger, await loadHeaders(), preferUnlinked);
    };

    const linkActiveChatToBranch = async (branch: string): Promise<void> => {
        // Give Cursor a beat to flush aux-bar state if the user just switched tabs.
        await new Promise(r => setTimeout(r, 150));
        const headers = await loadHeaders();
        const known = new Set(listConversations(transcriptsDir).map(c => c.id));
        const activeIds = (await getActiveComposerIds(context)).filter(id => known.has(id));

        let convId: string | undefined;
        if (activeIds.length === 1) {
            convId = activeIds[0];
        } else if (activeIds.length > 1) {
            const picked = await vscode.window.showQuickPick(
                activeIds.map((id, index) => ({
                    label: `${index === 0 ? '$(star-full) ' : ''}${headers.get(id)?.name ?? `#${id.slice(0, 8)}`}`,
                    description: index === 0 ? 'detected' : undefined,
                    id,
                })),
                { placeHolder: `Link which open chat to "${branch}"?`, matchOnDescription: true },
            );
            convId = picked?.id;
        }

        if (!convId) {
            // Could not detect the active chat — fall back to a full conversation picker.
            const conv = await pickConversation(transcriptsDir, ledger, headers, false);
            convId = conv?.id;
        }
        if (!convId) {
            return;
        }
        ledger.link(convId, branch);
        output.appendLine(`Linked (manual) ${convId} -> ${branch}`);
        refresh();
        vscode.window.showInformationMessage(`Branch Chats: linked "${headers.get(convId)?.name ?? convId.slice(0, 8)}" to ${branch}.`);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('branchChats.refresh', () => refresh()),

        vscode.commands.registerCommand('branchChats.open', async (conv: Conversation) => {
            const preferDeepLink = vscode.workspace.getConfiguration('branchChats').get<boolean>('preferDeepLink', true);
            await openConversation(conv, output, preferDeepLink);
        }),

        vscode.commands.registerCommand('branchChats.revealTranscript', async (node: TreeNode) => {
            const conv = await resolveConversation(node, false);
            if (conv) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(conv.transcriptPath));
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        }),

        vscode.commands.registerCommand('branchChats.linkHere', async (node: TreeNode | undefined) => {
            const branch = node?.branchName ?? tracker.branch;
            if (!branch) {
                vscode.window.showWarningMessage('Branch Chats: no branch to link to.');
                return;
            }
            await linkActiveChatToBranch(branch);
        }),

        vscode.commands.registerCommand('branchChats.linkConversation', async (node: TreeNode | undefined) => {
            const conv = await resolveConversation(node, true);
            if (!conv) {
                return;
            }
            const linked = new Set(ledger.branches(conv.id).map(l => l.branch));
            const branch = await pickBranch(ledger, tracker.branch, linked);
            if (!branch) {
                return;
            }
            const added = ledger.link(conv.id, branch);
            output.appendLine(`Linked (manual) ${conv.id} -> ${branch}`);
            refresh();
            vscode.window.showInformationMessage(
                added ? `Branch Chats: linked conversation to ${branch}.` : `Branch Chats: conversation already linked to ${branch}.`,
            );
        }),

        vscode.commands.registerCommand('branchChats.unlinkConversation', async (node: TreeNode | undefined) => {
            const conv = await resolveConversation(node, false);
            if (!conv) {
                return;
            }
            const linked = ledger.branches(conv.id).map(l => l.branch);
            if (linked.length === 0) {
                return;
            }
            // Prefer the branch group the item was invoked from; otherwise ask which to remove.
            let branch = node?.branchName;
            if (!branch) {
                branch = linked.length === 1 ? linked[0] : await pickBranchToRemove(linked);
            }
            if (!branch) {
                return;
            }
            if (ledger.unlink(conv.id, branch)) {
                output.appendLine(`Unlinked ${conv.id} from ${branch}`);
                refresh();
                vscode.window.showInformationMessage(`Branch Chats: removed conversation from ${branch}.`);
            }
        }),

        vscode.commands.registerCommand('branchChats.deleteBranch', async (node: TreeNode | undefined) => {
            const branch = node?.branchName;
            if (!branch) {
                return;
            }
            const linkCount = Object.values(ledger.all()).filter(e => e.links.some(l => l.branch === branch)).length;
            const detail =
                linkCount > 0
                    ? `This removes the "${branch}" group and unlinks ${linkCount} conversation(s) from it. The conversations and the git branch are not deleted.`
                    : `This removes the empty "${branch}" group.`;
            const confirm = await vscode.window.showWarningMessage(`Remove branch group "${branch}"?`, { modal: true, detail }, 'Remove');
            if (confirm !== 'Remove') {
                return;
            }
            const removed = ledger.deleteBranch(branch);
            output.appendLine(`Deleted branch group ${branch} (${removed} link(s) removed)`);
            refresh();
            vscode.window.showInformationMessage(`Branch Chats: removed branch group "${branch}".`);
        }),
    );

    refresh();
}

async function pickConversation(
    transcriptsDir: string,
    ledger: BranchLedger,
    headers: Map<string, ComposerHeader>,
    preferUnlinked: boolean,
): Promise<Conversation | undefined> {
    const conversations = listConversations(transcriptsDir).sort((a, b) => {
        const aTs = headers.get(a.id)?.lastUpdatedAt ?? a.updatedAt;
        const bTs = headers.get(b.id)?.lastUpdatedAt ?? b.updatedAt;
        return bTs - aTs;
    });
    const ordered = preferUnlinked ? [...conversations.filter(c => !ledger.has(c.id)), ...conversations.filter(c => ledger.has(c.id))] : conversations;

    type Item = vscode.QuickPickItem & { conv: Conversation };
    const items: Item[] = ordered.map(conv => {
        const links = ledger.branches(conv.id);
        const name = headers.get(conv.id)?.name?.trim() || conv.title;
        return {
            label: name,
            description: links.length ? `linked: ${links.map(l => l.branch).join(', ')}` : 'unlinked',
            detail: `#${conv.id.slice(0, 8)}`,
            conv,
        };
    });
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a conversation',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return picked?.conv;
}

async function pickBranch(ledger: BranchLedger, currentBranch: string | undefined, linkedBranches: Set<string>): Promise<string | undefined> {
    const known = new Set<string>();
    if (currentBranch) {
        known.add(currentBranch);
    }
    for (const entry of Object.values(ledger.all())) {
        for (const link of entry.links) {
            known.add(link.branch);
        }
    }
    const ordered = [...known].sort((a, b) => {
        if (a === currentBranch) return -1;
        if (b === currentBranch) return 1;
        return a.localeCompare(b);
    });

    const describe = (branch: string): string | undefined => {
        const tags: string[] = [];
        if (branch === currentBranch) {
            tags.push('current');
        }
        if (linkedBranches.has(branch)) {
            tags.push('already linked');
        }
        return tags.length ? tags.join(' · ') : undefined;
    };

    const items: vscode.QuickPickItem[] = ordered.map(branch => ({ label: branch, description: describe(branch) }));
    items.push({ label: ENTER_BRANCH_ITEM });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Link to which branch?' });
    if (!picked) {
        return undefined;
    }
    if (picked.label === ENTER_BRANCH_ITEM) {
        const entered = await vscode.window.showInputBox({
            prompt: 'Branch name',
            value: currentBranch ?? '',
            validateInput: value => (value.trim() ? null : 'Branch name is required'),
        });
        return entered?.trim() || undefined;
    }
    return picked.label;
}

/** Ask which of a conversation's linked branches to remove it from. */
async function pickBranchToRemove(linked: string[]): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
        linked.map(branch => ({ label: branch })),
        { placeHolder: 'Remove this conversation from which branch?' },
    );
    return picked?.label;
}

export function deactivate(): void {
    /* subscriptions disposed by VS Code */
}

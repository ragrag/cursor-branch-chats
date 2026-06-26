import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Bridge to Cursor's own chat ("composer") state.
 *
 * Cursor stores chat metadata in SQLite (`state.vscdb`):
 *   - global  : composer.composerHeaders  -> every chat across all workspaces
 *   - per-ws  : composer.composerData / aux-bar editor state -> what's open now
 *
 * The agent-transcript folder UUID equals the composer's `composerId`, so we can
 * enrich each transcript with its real chat name + last-activity time, and deep
 * link into the live pane via the `composer.openComposer` command.
 */

export interface ComposerHeader {
    composerId: string;
    name?: string;
    subtitle?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
}

const COMPOSER_HEADERS_KEY = 'composer.composerHeaders';
const COMPOSER_DATA_KEY = 'composer.composerData';
const PYTHON_CANDIDATES = ['python3', 'python'];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface RawHeader {
    composerId?: string;
    name?: string;
    subtitle?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
}

/** Map of composerId -> header metadata, pulled from Cursor's global state DB. */
export async function getGlobalComposerHeaders(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<Map<string, ComposerHeader>> {
    const result = new Map<string, ComposerHeader>();
    const dbPath = getGlobalDatabasePath(context);
    if (!dbPath) {
        return result;
    }
    const raw = await readCursorStorageValue(dbPath, COMPOSER_HEADERS_KEY);
    if (!raw) {
        return result;
    }
    try {
        const parsed = JSON.parse(raw) as { allComposers?: RawHeader[] };
        for (const header of parsed.allComposers ?? []) {
            if (!header.composerId) {
                continue;
            }
            result.set(header.composerId, {
                composerId: header.composerId,
                name: typeof header.name === 'string' ? header.name : undefined,
                subtitle: typeof header.subtitle === 'string' ? header.subtitle : undefined,
                createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
                lastUpdatedAt: typeof header.lastUpdatedAt === 'number' ? header.lastUpdatedAt : undefined,
            });
        }
    } catch (err) {
        output.appendLine(`[composer] failed to parse composerHeaders: ${String(err)}`);
    }
    return result;
}

/**
 * Best-effort ordered list of composer ids currently open in this workspace, most
 * likely-focused first. Used to offer "link the chat I'm looking at" without a
 * picker when there is an unambiguous candidate.
 */
export async function getActiveComposerIds(context: vscode.ExtensionContext): Promise<string[]> {
    const fromTabs = readComposerIdsFromTabGroups();
    if (fromTabs.length > 0) {
        return fromTabs;
    }

    const dbPath = getWorkspaceDatabasePath(context);
    if (!dbPath) {
        return [];
    }

    const embedded = await readEmbeddedAuxBarComposerIds(dbPath);
    if (embedded.length > 0) {
        return embedded;
    }

    const raw = await readCursorStorageValue(dbPath, COMPOSER_DATA_KEY);
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as {
            selectedComposerIds?: string[];
            lastFocusedComposerIds?: string[];
        };
        const ordered = [...(parsed.lastFocusedComposerIds ?? []), ...(parsed.selectedComposerIds ?? [])];
        return dedupe(ordered.filter(id => UUID_RE.test(id)));
    } catch {
        return [];
    }
}

function readComposerIdsFromTabGroups(): string[] {
    const ids: string[] = [];
    try {
        const activeGroup = vscode.window.tabGroups.all.find(g => g.isActive) ?? vscode.window.tabGroups.activeTabGroup;
        const ordered: vscode.Tab[] = [];
        if (activeGroup?.activeTab) {
            ordered.push(activeGroup.activeTab);
        }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (!ordered.includes(tab)) {
                    ordered.push(tab);
                }
            }
        }
        for (const tab of ordered) {
            const id = extractComposerIdFromTab(tab);
            if (id) {
                ids.push(id);
            }
        }
    } catch {
        /* tab groups not available */
    }
    return dedupe(ids);
}

function extractComposerIdFromTab(tab: vscode.Tab): string | undefined {
    const input = tab.input as Record<string, unknown> | undefined;
    if (!input) {
        return undefined;
    }
    const viewType = typeof input.viewType === 'string' ? input.viewType.toLowerCase() : '';
    const isComposerLike = viewType.includes('composer') || viewType.includes('aichat');

    const directId = typeof input.composerId === 'string' ? input.composerId : '';
    if (directId && UUID_RE.test(directId)) {
        return directId;
    }
    const uri = input.uri as vscode.Uri | undefined;
    if (uri) {
        const fromUri = matchUuid(uri.path) ?? matchUuid(uri.query) ?? matchUuid(uri.fragment);
        if (fromUri && (isComposerLike || uri.scheme.toLowerCase().includes('composer'))) {
            return fromUri;
        }
    }
    if (isComposerLike && typeof input.id === 'string') {
        return matchUuid(input.id);
    }
    return undefined;
}

interface AuxBarLeaf {
    data?: {
        id?: number;
        editors?: Array<{ id?: string; value?: string }>;
        mru?: number[];
    };
}

interface AuxBarNode {
    data?: AuxBarNode[] | AuxBarLeaf['data'];
}

async function readEmbeddedAuxBarComposerIds(dbPath: string): Promise<string[]> {
    const raw = await readCursorStorageValue(dbPath, 'workbench.parts.embeddedAuxBarEditor.state');
    if (!raw) {
        return [];
    }
    try {
        const state = JSON.parse(raw) as {
            activeGroup?: number;
            mostRecentActiveGroups?: number[];
            serializedGrid?: { root?: AuxBarNode };
        };
        const activeGroupId =
            typeof state.activeGroup === 'number' ? state.activeGroup : state.mostRecentActiveGroups?.find((id): id is number => typeof id === 'number');
        if (activeGroupId === undefined) {
            return [];
        }
        const leaf = findAuxBarLeaf(state.serializedGrid?.root, activeGroupId);
        const editors = leaf?.data?.editors;
        if (!Array.isArray(editors) || editors.length === 0) {
            return [];
        }
        const indexes = dedupe([...(leaf?.data?.mru ?? []), ...editors.map((_, index) => index)]).filter(index => Number.isInteger(index));

        const ids: string[] = [];
        for (const index of indexes) {
            const editor = editors[index];
            if (editor?.id !== 'workbench.editor.composer.input' || !editor.value) {
                continue;
            }
            try {
                const parsed = JSON.parse(editor.value) as { composerId?: unknown };
                if (typeof parsed.composerId === 'string' && parsed.composerId) {
                    ids.push(parsed.composerId);
                }
            } catch {
                /* skip malformed editor value */
            }
        }
        return dedupe(ids);
    } catch {
        return [];
    }
}

function findAuxBarLeaf(node: AuxBarNode | undefined, targetId: number): AuxBarLeaf | null {
    if (!node) {
        return null;
    }
    if (node.data && !Array.isArray(node.data) && typeof node.data === 'object') {
        const leaf = node as AuxBarLeaf;
        return leaf.data?.id === targetId ? leaf : null;
    }
    if (Array.isArray(node.data)) {
        for (const child of node.data) {
            const match = findAuxBarLeaf(child, targetId);
            if (match) {
                return match;
            }
        }
    }
    return null;
}

function getWorkspaceDatabasePath(context: vscode.ExtensionContext): string | null {
    if (!context.storageUri) {
        return null;
    }
    const dbPath = path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb');
    return existsSync(dbPath) ? dbPath : null;
}

function getGlobalDatabasePath(context: vscode.ExtensionContext): string | null {
    if (context.globalStorageUri) {
        const dbPath = path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
        if (existsSync(dbPath)) {
            return dbPath;
        }
    }
    if (context.storageUri) {
        const userDir = path.resolve(context.storageUri.fsPath, '../../..');
        const dbPath = path.join(userDir, 'globalStorage', 'state.vscdb');
        if (existsSync(dbPath)) {
            return dbPath;
        }
    }
    return null;
}

async function readCursorStorageValue(dbPath: string, key: string): Promise<string | null> {
    const script = [
        'import sqlite3, sys',
        'db_path, key = sys.argv[1], sys.argv[2]',
        "conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)",
        'cur = conn.cursor()',
        'row = cur.execute("SELECT value FROM ItemTable WHERE [key] = ?", (key,)).fetchone()',
        "print(row[0] if row and row[0] else '')",
    ].join('\n');

    for (const candidate of PYTHON_CANDIDATES) {
        try {
            const stdout = await execFileAsync(candidate, ['-c', script, dbPath, key]);
            return stdout.trim() || null;
        } catch {
            continue;
        }
    }
    return null;
}

function execFileAsync(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { maxBuffer: 1024 * 1024 * 32 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function matchUuid(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const match = UUID_RE.exec(value);
    return match ? match[0] : undefined;
}

function dedupe<T>(values: T[]): T[] {
    return values.filter((value, index) => values.indexOf(value) === index);
}

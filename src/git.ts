import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Minimal shape of the built-in vscode.git extension API we rely on.
interface GitRepositoryState {
    HEAD?: { name?: string; commit?: string };
    onDidChange: vscode.Event<void>;
}
interface GitRepository {
    rootUri: vscode.Uri;
    state: GitRepositoryState;
}
interface GitApi {
    repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
    getAPI(version: 1): GitApi;
}

export class BranchTracker implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeBranch = this.emitter.event;

    private current: string | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private headWatcher: fs.FSWatcher | undefined;

    constructor(private readonly workspaceRoot: string) {}

    async start(): Promise<void> {
        const api = await this.getGitApi();
        if (api) {
            this.wireGitApi(api);
        }
        // Always also watch .git/HEAD as a robust fallback (works even if the git
        // extension is slow to surface repositories).
        this.watchHead();
        this.refreshFromDisk();
    }

    get branch(): string | undefined {
        return this.current;
    }

    private async getGitApi(): Promise<GitApi | undefined> {
        const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!ext) {
            return undefined;
        }
        try {
            const exports = ext.isActive ? ext.exports : await ext.activate();
            return exports.getAPI(1);
        } catch {
            return undefined;
        }
    }

    private wireGitApi(api: GitApi): void {
        const wire = (repo: GitRepository) => {
            this.disposables.push(
                repo.state.onDidChange(() => {
                    const name = repo.state.HEAD?.name;
                    this.setBranch(name);
                }),
            );
            if (repo.state.HEAD?.name) {
                this.setBranch(repo.state.HEAD.name);
            }
        };
        api.repositories.forEach(wire);
        this.disposables.push(api.onDidOpenRepository(wire));
    }

    private watchHead(): void {
        const gitDir = resolveGitDir(this.workspaceRoot);
        if (!gitDir) {
            return;
        }
        // Watch the .git dir for HEAD changes only (current-branch detection).
        // Branch existence is computed lazily on refresh, so no refs watcher.
        try {
            this.headWatcher = fs.watch(gitDir, (_event, filename) => {
                if (!filename || filename === 'HEAD') {
                    this.refreshFromDisk();
                }
            });
        } catch {
            /* watch unsupported */
        }
    }

    private refreshFromDisk(): void {
        const name = readHeadBranch(this.workspaceRoot);
        if (name) {
            this.setBranch(name);
        }
    }

    private setBranch(name: string | undefined): void {
        if (!name || name === this.current) {
            return;
        }
        this.current = name;
        this.emitter.fire();
    }

    dispose(): void {
        this.emitter.dispose();
        this.headWatcher?.close();
        this.disposables.forEach(d => d.dispose());
    }
}

/** Resolve the real git directory, supporting `.git` files (worktrees/submodules). */
function resolveGitDir(workspaceRoot: string): string | undefined {
    const dotGit = path.join(workspaceRoot, '.git');
    try {
        const stat = fs.statSync(dotGit);
        if (stat.isDirectory()) {
            return dotGit;
        }
        if (stat.isFile()) {
            const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
            if (match) {
                const target = match[1].trim();
                return path.isAbsolute(target) ? target : path.resolve(workspaceRoot, target);
            }
        }
    } catch {
        /* not a git repo */
    }
    return undefined;
}

/** All local branch names (loose refs under refs/heads plus packed-refs). */
export function listLocalBranches(workspaceRoot: string): Set<string> {
    const branches = new Set<string>();
    const gitDir = resolveGitDir(workspaceRoot);
    if (!gitDir) {
        return branches;
    }

    const headsDir = path.join(gitDir, 'refs', 'heads');
    const walk = (dir: string, prefix: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), name);
            } else {
                branches.add(name);
            }
        }
    };
    walk(headsDir, '');

    try {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        for (const line of packed.split('\n')) {
            const match = /^[0-9a-f]+\s+refs\/heads\/(.+)$/.exec(line.trim());
            if (match) {
                branches.add(match[1]);
            }
        }
    } catch {
        /* no packed-refs */
    }

    return branches;
}

export function readHeadBranch(workspaceRoot: string): string | undefined {
    try {
        const head = fs.readFileSync(path.join(workspaceRoot, '.git', 'HEAD'), 'utf8').trim();
        const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (match) {
            return match[1];
        }
        // Detached HEAD: show short sha.
        return head.slice(0, 12);
    } catch {
        return undefined;
    }
}

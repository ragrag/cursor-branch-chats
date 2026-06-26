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
        const headPath = path.join(this.workspaceRoot, '.git', 'HEAD');
        try {
            this.headWatcher = fs.watch(path.dirname(headPath), (_event, filename) => {
                if (!filename || filename === 'HEAD') {
                    this.refreshFromDisk();
                }
            });
        } catch {
            /* no .git dir or watch unsupported */
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

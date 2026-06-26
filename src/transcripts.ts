import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Conversation {
    id: string;
    transcriptPath: string;
    startedAt: number;
    /** Last time the transcript file was written; fallback last-activity signal. */
    updatedAt: number;
    title: string;
}

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

/**
 * Cursor stores per-project agent transcripts at:
 *   ~/.cursor/projects/<encoded-workspace-path>/agent-transcripts/<conversationId>/<conversationId>.jsonl
 *
 * The encoded path is the absolute workspace path with leading separators dropped
 * and every path separator replaced by a dash.
 */
export function encodeWorkspacePath(workspacePath: string): string {
    return workspacePath.replace(/^[\\/]+/, '').replace(/[\\/]/g, '-');
}

export function transcriptsDirForWorkspace(workspacePath: string): string {
    const encoded = encodeWorkspacePath(workspacePath);
    return path.join(os.homedir(), '.cursor', 'projects', encoded, 'agent-transcripts');
}

/**
 * Fallback: if the encoded-path guess does not exist, scan ~/.cursor/projects for a
 * directory whose decoded name matches the workspace path.
 */
export function resolveTranscriptsDir(workspacePath: string): string | undefined {
    const guess = transcriptsDirForWorkspace(workspacePath);
    if (fs.existsSync(guess)) {
        return guess;
    }

    const projectsRoot = path.join(os.homedir(), '.cursor', 'projects');
    if (!fs.existsSync(projectsRoot)) {
        return undefined;
    }

    const target = encodeWorkspacePath(workspacePath);
    for (const entry of safeReaddir(projectsRoot)) {
        if (entry === target || entry.endsWith(target)) {
            const dir = path.join(projectsRoot, entry, 'agent-transcripts');
            if (fs.existsSync(dir)) {
                return dir;
            }
        }
    }
    return undefined;
}

function safeReaddir(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

function birthTime(p: string): number {
    try {
        const stat = fs.statSync(p);
        // birthtimeMs is reliable on macOS; fall back to ctime/mtime elsewhere.
        return Math.floor(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs);
    } catch {
        return 0;
    }
}

function modTime(p: string): number {
    try {
        return Math.floor(fs.statSync(p).mtimeMs);
    } catch {
        return 0;
    }
}

function firstLine(filePath: string): string | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(64 * 1024);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.toString('utf8', 0, bytes);
        const nl = text.indexOf('\n');
        return nl === -1 ? text : text.slice(0, nl);
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch {
                /* ignore */
            }
        }
    }
}

export function deriveTitle(transcriptPath: string, fallbackId: string): string {
    const line = firstLine(transcriptPath);
    if (!line) {
        return fallbackId.slice(0, 8);
    }
    try {
        const parsed = JSON.parse(line);
        const content = parsed?.message?.content;
        let text = '';
        if (Array.isArray(content)) {
            const textPart = content.find((c: { type?: string; text?: string }) => c?.type === 'text' && typeof c.text === 'string');
            text = textPart?.text ?? '';
        } else if (typeof content === 'string') {
            text = content;
        }
        const match = USER_QUERY_RE.exec(text);
        const raw = (match ? match[1] : text).trim();
        const oneLine = raw.replace(/\s+/g, ' ').trim();
        if (!oneLine) {
            return fallbackId.slice(0, 8);
        }
        return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
    } catch {
        return fallbackId.slice(0, 8);
    }
}

function transcriptFileFor(dir: string, id: string): string | undefined {
    const direct = path.join(dir, id, `${id}.jsonl`);
    if (fs.existsSync(direct)) {
        return direct;
    }
    const convDir = path.join(dir, id);
    for (const entry of safeReaddir(convDir)) {
        if (entry.endsWith('.jsonl')) {
            return path.join(convDir, entry);
        }
    }
    return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listConversations(transcriptsDir: string): Conversation[] {
    const result: Conversation[] = [];
    for (const id of safeReaddir(transcriptsDir)) {
        if (!UUID_RE.test(id)) {
            continue;
        }
        const convDir = path.join(transcriptsDir, id);
        let isDir = false;
        try {
            isDir = fs.statSync(convDir).isDirectory();
        } catch {
            isDir = false;
        }
        if (!isDir) {
            continue;
        }
        const transcriptPath = transcriptFileFor(transcriptsDir, id);
        if (!transcriptPath) {
            continue;
        }
        result.push({
            id,
            transcriptPath,
            startedAt: birthTime(convDir),
            updatedAt: modTime(transcriptPath) || birthTime(convDir),
            title: deriveTitle(transcriptPath, id),
        });
    }
    return result;
}

/** Extract the conversation id from a path inside the transcripts dir. */
export function conversationIdFromPath(transcriptsDir: string, changedPath: string): string | undefined {
    const rel = path.relative(transcriptsDir, changedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
    }
    const segment = rel.split(path.sep)[0];
    return UUID_RE.test(segment) ? segment : undefined;
}

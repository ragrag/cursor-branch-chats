import * as fs from 'fs';
import * as vscode from 'vscode';
import { Conversation } from './transcripts';

/**
 * Cursor's internal command that opens an existing chat ("composer") by id. The
 * agent-transcript folder UUID equals the composerId, so this jumps straight into
 * the live chat. `view: 'pane'` reopens it in the chat sidebar; the editor variant
 * is a fallback for builds that only support tab-hosted chats.
 */
const OPEN_COMPOSER_COMMAND = 'composer.openComposer';
const OPEN_COMPOSER_OPTIONS: Array<Record<string, unknown>> = [{ view: 'pane' }, { view: 'editor', openInNewTab: true }];

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function openConversation(conv: Conversation, output: vscode.OutputChannel, preferDeepLink: boolean): Promise<void> {
    if (preferDeepLink && (await tryDeepLink(conv, output))) {
        return;
    }
    await renderTranscript(conv);
}

async function tryDeepLink(conv: Conversation, output: vscode.OutputChannel): Promise<boolean> {
    const registered = new Set(await vscode.commands.getCommands(true));
    if (!registered.has(OPEN_COMPOSER_COMMAND)) {
        output.appendLine(`[deep-link] "${OPEN_COMPOSER_COMMAND}" not registered in this Cursor build; rendering transcript`);
        return false;
    }

    for (const options of OPEN_COMPOSER_OPTIONS) {
        try {
            await vscode.commands.executeCommand(OPEN_COMPOSER_COMMAND, conv.id, options);
            await delay(150);
            output.appendLine(`[deep-link] opened ${conv.id} via "${OPEN_COMPOSER_COMMAND}" ${JSON.stringify(options)}`);
            return true;
        } catch (err) {
            output.appendLine(`[deep-link] "${OPEN_COMPOSER_COMMAND}" ${JSON.stringify(options)} failed: ${String(err)}`);
        }
    }

    output.appendLine(`[deep-link] no working deep link for ${conv.id}; rendering transcript instead`);
    return false;
}

interface TranscriptTurn {
    role: string;
    text: string;
    tools: string[];
}

function parseTranscript(filePath: string): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let raw = '';
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return turns;
    }
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed);
            const role: string = parsed?.role ?? 'unknown';
            const content = parsed?.message?.content;
            let text = '';
            const tools: string[] = [];
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part?.type === 'text' && typeof part.text === 'string') {
                        text += part.text;
                    } else if (part?.type === 'tool_use' && part?.name) {
                        const target = part.input?.path ?? part.input?.pattern ?? part.input?.command ?? '';
                        tools.push(target ? `${part.name}: ${target}` : String(part.name));
                    }
                }
            } else if (typeof content === 'string') {
                text = content;
            }
            turns.push({ role, text: text.trim(), tools });
        } catch {
            /* skip malformed line */
        }
    }
    return turns;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(conv: Conversation, turns: TranscriptTurn[]): string {
    const body = turns
        .map(turn => {
            const cls = turn.role === 'user' ? 'user' : turn.role === 'assistant' ? 'assistant' : 'other';
            const label = turn.role.toUpperCase();
            const textHtml = turn.text ? `<div class="text">${escapeHtml(turn.text)}</div>` : '';
            const toolsHtml = turn.tools.length ? `<div class="tools">${turn.tools.map(t => `<span class="tool">${escapeHtml(t)}</span>`).join('')}</div>` : '';
            if (!textHtml && !toolsHtml) {
                return '';
            }
            return `<div class="turn ${cls}"><div class="role">${label}</div>${textHtml}${toolsHtml}</div>`;
        })
        .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; line-height: 1.5; }
  h1 { font-size: 1.1rem; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.8rem; margin-bottom: 20px; }
  .turn { margin: 0 0 18px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); }
  .turn.user { background: var(--vscode-editor-inactiveSelectionBackground); }
  .turn.assistant { background: transparent; }
  .role { font-size: 0.7rem; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .tools { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.72rem; background: var(--vscode-textCodeBlock-background); padding: 2px 7px; border-radius: 5px; }
</style>
</head>
<body>
  <h1>${escapeHtml(conv.title)}</h1>
  <div class="meta">${escapeHtml(conv.id)}</div>
  ${body || '<p>No readable content in this transcript.</p>'}
</body>
</html>`;
}

async function renderTranscript(conv: Conversation): Promise<void> {
    const turns = parseTranscript(conv.transcriptPath);
    const panel = vscode.window.createWebviewPanel(
        'branchChats.transcript',
        conv.title.length > 40 ? `${conv.title.slice(0, 39)}…` : conv.title,
        vscode.ViewColumn.Active,
        { enableScripts: false, retainContextWhenHidden: true },
    );
    panel.webview.html = renderHtml(conv, turns);
}

# Branch Chats

A Cursor / VS Code extension that indexes your **agent conversations by the git branch you were on when you started them**.

Switch branches → the sidebar shows the conversations you started while HEAD was on that branch, so you can jump back into the context you were last working in.

## How it works

Cursor writes each agent conversation to disk as a JSONL transcript under `~/.cursor/projects/<encoded-workspace>/agent-transcripts/<conversationId>/`.

This extension:

1. **Captures (forward-only):** watches that folder. When Cursor creates a new conversation, it records the **current git branch** into a small index file
   (`branch-chat-index.json`, next to the transcripts). Accurate from install onward — no guessing. Branches in `branchChats.ignoredBranches` (default `main`,
   `master`) are skipped.
2. **Tracks the branch:** via the built-in `vscode.git` API, with a `.git/HEAD` file-watch fallback. Switching branches refreshes the view.
3. **Groups & shows:** a sidebar tree groups conversations by branch, current branch pinned to the top and expanded. Chat **names** and **last-activity** times
   come straight from Cursor's own chat metadata (with the transcript's first user message as a fallback). Conversations are sorted by last activity.
4. **Opens a conversation:** deep-links straight into the live Cursor chat pane via Cursor's `composer.openComposer` command (the agent-transcript id _is_ the
   chat's `composerId`). If that command isn't available, it opens a clean, read-only **rendered transcript** in an editor tab. Toggle with the
   `branchChats.preferDeepLink` setting.

## Linking conversations

Auto-capture only knows the branch for chats you start _after_ installing. You can also link chats yourself:

- **Link Current Chat to Branch** — toolbar `$(link)` button (and command palette). Links the chat you're currently looking at to the current branch.
- **Link Conversation to Branch…** — right-click any conversation (or an item in the **Unlinked** group) to link/relink it to a branch you pick.
- **Unlink Conversation** — right-click a linked conversation to remove its link.

Manually-linked conversations are marked with a blue **link** icon; auto-captured ones use the chat-bubble icon. Hover any item for details.

> Conversations with no branch link are hidden by default. Enable `branchChats.showUnlinked` to surface them in an **Unlinked** group at the bottom for easy
> manual linking.

## Settings

| Setting                       | Default              | Description                                                                                     |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `branchChats.preferDeepLink`  | `true`               | Open the live Cursor chat pane before falling back to a rendered transcript.                    |
| `branchChats.ignoredBranches` | `["main", "master"]` | Branches excluded from auto-capture and hidden from the tree (unless it's your current branch). |
| `branchChats.showUnlinked`    | `false`              | Show an **Unlinked** group for conversations not linked to any branch.                          |

## Run it (development)

```bash
cd /Users/raggi/projects/cursor-branch-chats
npm install
npm run compile
```

Then press **F5** (Run Extension) to launch an Extension Development Host with your real workspace, or package and install it permanently:

```bash
npx @vscode/vsce package
# then in Cursor: Command Palette → "Extensions: Install from VSIX..."
```

Open the **Branch Chats** icon in the activity bar.

## Notes / limitations

- **Deep-linking** uses Cursor's internal `composer.openComposer` command. It works on current Cursor builds; if a future build renames it, the
  rendered-transcript fallback always works. Check the **Output → Branch Chats** channel to see what was attempted.
- **Chat names / last-activity / active-chat detection** read Cursor's `state.vscdb` (SQLite) using the system `python3`. If Python isn't available, the
  extension still works — it falls back to transcript-derived titles and file modification times.
- Auto branch-capture only happens while the extension is active. Start a conversation with Cursor open and the branch is recorded; otherwise link it manually.

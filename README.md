# Branch Chats

Organize your Cursor AI conversations by **git branch**. Switch to a branch and instantly see the chats that belong to the work you were doing there.

No more scrolling through a long, flat chat history trying to remember which conversation went with which feature.

## Features

- **Conversations grouped by branch** — your current branch is pinned to the top and expanded, so the chats you need are always one click away.
- **Open a chat with one click** — jumps straight back into the live Cursor chat. (If a chat can't be reopened, you'll get a clean, readable transcript
  instead.)
- **Automatic tracking** — new conversations are filed under the branch you're on when you start them. Nothing to do.
- **Manual linking** — link any conversation to any branch yourself, and unlink whenever you want.
- **Sorted by recent activity** — the chats you touched most recently show first, with real chat names and "last active" times.
- **Skips noisy branches** — `main` and `master` are ignored by default (configurable).

## Getting started

1. Install the extension.
2. Open the **Branch Chats** icon in the activity bar (the green branch + chat bubble).
3. Start chatting with Cursor as usual — conversations are automatically grouped under your current branch.
4. Switch branches and watch the list update.

> Tip: you can drag the Branch Chats icon and **pin** it wherever you like in the activity bar.

## Linking conversations to branches

Automatic tracking covers chats you start after installing. For everything else, link them yourself:

- **Add the chat you're viewing to a branch** — hover a branch row and click the **`+`** button. The chat currently open in Cursor gets linked to that branch.
- **Link / move a specific conversation** — right-click a conversation and choose **Link Conversation to Branch…**, then pick a branch (or type a new one).
- **Unlink** — right-click a linked conversation and choose **Unlink Conversation**.

Manually linked chats are marked with a blue **link** icon so you can tell them apart from automatically tracked ones. Hover any chat for its branch, name, and
timestamps.

## Settings

| Setting                       | Default              | What it does                                                                                                                   |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `branchChats.ignoredBranches` | `["main", "master"]` | Branches to leave out — chats started on them aren't tracked, and the groups are hidden (your current branch is always shown). |
| `branchChats.showUnlinked`    | `false`              | Show an **Unlinked** group at the bottom for conversations not tied to any branch, so you can link them.                       |
| `branchChats.preferDeepLink`  | `true`               | Reopen the real Cursor chat when you click a conversation. Turn off to always view a read-only transcript instead.             |

## Good to know

- Automatic tracking starts from the moment you install — older conversations won't have a branch until you link them (turn on `branchChats.showUnlinked` to
  find them easily).
- Clicking a conversation reopens the actual Cursor chat whenever possible; otherwise you get a tidy, read-only transcript.

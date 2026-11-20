---
title: Connect an assistant (MCP)
description: Let Claude Desktop or another assistant search your Lifer library and organise albums, with every change undoable.
slug: /api/mcp
---

# Connect an assistant

Lifer includes an [MCP](https://modelcontextprotocol.io) server, so an assistant such as Claude Desktop can
search your photos, look up species and your life list, and organise albums for you. It talks to Lifer
through the same public [API](/api/overview) as any script, using an API key you make, so it can only do
what that key allows.

## Set it up

**On the desktop app**, the assistant server comes with Lifer and runs on Lifer's own Node, so there is nothing to install or build.

1. Open **Settings > Integrations** and, next to **Connect an assistant**, click **Set up**. Lifer makes a key for it
   (read access to your library, plus albums) and shows the setup with the real paths and the key filled in.
2. In Claude Desktop, open **Settings > Developer > Edit Config**, paste the setup into the file (if it already has an
   `mcpServers` section, add only the `lifer` part), save, and restart Claude Desktop.

The key is shown once. To remove an assistant's access, revoke its key under **Settings > Integrations > API keys**.

**On a server**, the assistant runs on your own computer, not on the server:

1. In Lifer, open **Settings > Account > API keys** and make a key. For a look-around-only assistant, tick only
   the read permissions (gallery, species, stats, trips, albums, collection). Add **album.write** if you want it to
   make and fill albums. Nothing else is needed, and the assistant never imports, edits or shares photos.
2. Build the server once from the Lifer source folder: `npm run build -w @lifer/mcp`.
3. Open **Settings > Integrations**, copy the setup, put your key in it and the path of
   `packages/mcp/dist/index.js` in it, and paste it into the assistant's MCP settings.

The server reads two settings from that block: `LIFER_URL` (where Lifer is, for example
`http://lifer.local:4000`) and `LIFER_API_KEY`.

## What an assistant can do

| Tool | What it does | Key permission |
|---|---|---|
| `search_photos` | Text search and filters (a list means "any of these"), 25 photos at a time | gallery.read |
| `find_species`, `get_species` | Look up species and your photos of them | species.read |
| `life_list`, `life_list_summary` | The life list and its totals | collection.read |
| `list_albums`, `suggested_smart_albums` | Albums, and smart albums worth making | album.read |
| `list_trips`, `trip_summary` | Trips and their counts | trips.read |
| `library_stats` | Statistics about the library | stats.read |
| `create_album`, `create_smart_album`, `add_photos_to_album` | Make and fill albums | album.write |
| `undo_last_change` | Undo the newest change the assistant made | album.write |

Each tool is one public API route, so everything it does is in the [API reference](/api/overview).

## Undo and safety

- Every change the assistant makes is recorded with the steps that reverse it. Asking the assistant to "undo that"
  reverses the newest change, one change at a time, back through the last 20 recorded.
- A change is one tool call, and a call adds at most 200 photos, so a big job is several steps, never one that can't be reviewed.
- There are no tools that delete photos, albums or anything else. Undoing a change that made an album removes
  that album, and undoing an addition removes only the photos that were new to the album.
- Nothing leaves your computer or server except the answers sent to the assistant you connected.

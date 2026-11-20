---
title: Connect the desktop app to a server
description: Use the Lifer desktop app as a window onto your own Lifer server, and move a local library up to it.
---

# Connect the desktop app to a server

If you run a [Lifer server](./docker.md), the desktop app can show that server's library in a native window, the same as opening it in a browser. You can switch between the server and the app's own local library at any time.

## Connect on first launch

1. Open Lifer. Click **Get started**, then **On my Lifer server**.
2. Enter the **Server address**, including `http://` or `https://`, for example `https://lifer.example.com` or `http://192.168.1.50:4000`.
3. Click **Connect**. Lifer checks that the server answers.
4. Sign in with your server account.

If you see "Couldn't reach that address. Check the URL and that the server is running.", check the address in a browser on the same computer first.

## Connect from an existing local library

1. Open **Settings > Server**.
2. In **Sign in to a server**, enter the server address and click **Connect**.
3. When it says **Connected to** your server, enter your **Email** and **Password**.
4. Click **Sign in**. The window switches to the server's library, already signed in.

Once signed in, the desktop app also gets a key of its own on the server, listed under **Settings > Server > Linked devices** on the server as **Desktop app**, with when it last synced and a **Revoke** button. The app uses it to talk to the server for you in the background. Signing out of the server removes the key, and so does switching the app to a different server. If the old server can't be reached at the time, the app tries again each time it starts until it can.

To go back, open **Settings > Server** and click **Use local library** in the **Server** row. You can also use **Change Server / Library…** in the Lifer app menu to start over from the setup screen.

## Downloaded regions on both sides {#packs}

The desktop app and the server each keep their own [downloaded regions](../guides/offline-packs-and-map.md). Once the app is signed in to a server, it compares the two:

- Regions this computer has and the server doesn't are started on the server by themselves. Nothing to do.
- Regions the server has and this computer doesn't are offered in a dialog, **Regions on your server**, with a **Download** button. Say yes and they download here too, so your library looks the same when the server can't be reached. Say **Not Now** and you're asked again the next time you connect.

The check runs every time the app connects. While connected and signed in, the library on this computer keeps running in the background for this and for the sync features that build on it.

## Your collection on this computer {#mirror}

While the app is signed in to a server, the library on this computer keeps a copy of the server's collection: every photo's species, date, place, rating and tags, with a small thumbnail of each, and your seen and target marks. Not the original files. It refreshes in the background after you connect and every half hour while connected, so when the server can't be reached the app opens this computer's library and your collection is there to browse, search and filter. Full-size photos stay on the server.

Your albums and trips travel the same way, in both directions: one made, renamed or deleted on either side shows up on the other, and when you've changed the same one in both places the newer change wins. Photos you import into this computer's library while away, and anything you change there (species, ratings, tags, seen marks, albums, trips), go to the server by themselves the next time the app connects, and every half hour while connected. Your own changes go up before the server's copy comes down, so an edit made while away is never overwritten. The originals stay on this computer too.

## When the server can't be reached {#offline}

If the server doesn't answer as the app starts, or after about a minute without an answer while you're using it, the app opens this computer's library, which holds [your collection](#mirror). You can browse, search and filter it, and add photos while away; what you add and change goes to the server when it answers again. A dialog tells you when the server is back and offers to switch.

## If the server was reinstalled {#reinstalled}

Each server has an identity of its own, and the app only sends your library to the server it linked to. If the address now answers as a different server (for example after a reinstall), the sync stops and **Settings > Server** says **This server looks new**. Nothing on this computer is changed or deleted. Click **Send my library to it** to start over: the app then sends everything here to the new server.

## Automatic URL Switching {#url-switching}

At home, the fastest way to reach your server is its local address. Away from home, you need its public address. Lifer can switch between them for you.

**On first launch:** tick **Automatic URL Switching (connect locally over a designated Wi-Fi network)**, then fill in **Local address (home network)**, **Wi-Fi network name** and **External address (away from home)**.

**Later:**

1. While connected to the server, open **Settings > Server**.
2. In **Automatic URL Switching**, click **Set up**.
3. Under **Home network**, enter the server's local address and your home Wi-Fi name. **Use current connection** fills these in from the network you're on.
4. Under **Other addresses**, **Add** one or more public addresses. Lifer tries them from top to bottom, and you can drag to reorder them.
5. In **Save addresses**, click **Save**.

## Move your library to a server {#migrate}

Started on the desktop app and built a server later? Signing in to the server from the app is the whole move.

1. Set the server up and [create its account](./docker.md#first-account) in a browser first. The app never creates accounts.
2. In the desktop app, open **Settings > Server**, enter the server address, click **Connect**, then sign in.
3. The window switches to the server. In the background, the app sends every photo on this computer to it, with the species, dates, places, ratings, tags and seen marks, and the regions you have downloaded here. A large library takes a while; **Settings > Server > Sync** shows what's left.
4. Photos the server already has (imported there too) are recognised by their contents and not sent twice.

Your originals stay on this computer, and the app keeps working from it whenever the server can't be reached. Once **Sync** says nothing is waiting, **Delete local files** in the app's own library (**Use local library**, then **Settings > Server**) frees the space. It's refused while anything here hasn't been sent, and can't be undone.

## Faster species suggestions from the desktop app {#desktop-assisted-matching}

When the desktop app is connected to a server, it can do the heavy part of species recognition on your computer instead of on the server. On a small NAS this makes suggestions noticeably faster while you import. There's nothing to turn on.

How it works:

1. The first time you open **Import photos** while connected, the desktop app downloads the same models the server uses (about 620 MB) into its own app data folder. Each file is checked against the server's checksum. If the app's own local library already has them, it reuses them. Imports keep working while this downloads, with the server doing the matching as usual.
2. Once the models are ready, the region box on the **Import photos** page says **Matching on this computer or the server, whichever is faster**.
3. For each photo, the app either works out its matching data on your computer and sends it along with the photo, or leaves the work to the server, whichever has been faster. See [GPU acceleration](./hardware-acceleration.md#desktop-and-server).
4. The server only accepts that data when it's provably what it would have computed itself: the same model files, the same image processing version, and the same photo. If anything doesn't match, it ignores the data and does the work itself, so suggestions are never worse for it.

Keep in mind:

- **Keep the desktop app and the server on the same Lifer release.** Different releases can process images very slightly differently, and then the app can't help. If they don't match, the server does all the matching. [Update the server](./docker.md#updating) and the app to the same version to get the speed-up.
- **RAW files are matched on the preview image inside them**, on your computer or the server like any other photo. TIFF and HEIC files are always matched on the server, which makes the decoded copy they're matched on.
- **If anything goes wrong on your computer**, that photo is matched on the server instead, and the app tries again for the next one.

This only affects species recognition. Your photos are still uploaded to and stored on the server as usual.

## Reveal in Finder for the server's files {#reveal-in-finder}

If the server's photo folders are also shared to your Mac (for example a NAS share mounted at `/Volumes/NAS`), photo menus offer **Reveal in Finder** for the server's files too. There's nothing to set up: when you connect, the app looks for one of your photos under each mounted volume in `/Volumes`, up to four folders deep, and checks that it's the same size as on the server. Once found, it remembers where the share is, and looks again if the share moves.

When the share isn't mounted on this Mac, or the app can't find it, photo menus offer **Copy original's path** instead, which copies the file's path on the server. Mount the share in Finder (**Go > Connect to Server**) and reload the window to switch back to Reveal in Finder.

## What's different when connected

- You sign in with your server account, and the Settings **Account** tab appears.
- Photos are stored on the server, not on this computer.
- [Share links](../guides/albums-and-sharing.md#share-links) and [API keys](../settings.md#api-keys) are available, because they're server features.
- **Settings > Storage** shows the server's folders. They're set by the server's administrator.

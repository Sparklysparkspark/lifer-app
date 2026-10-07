---
title: Settings reference
description: Every Settings tab and card in Lifer, and what each option does.
slug: /settings
---

# Settings reference

Click **Settings** in the top bar. Each tab has its own address, like `/settings/storage` or `/settings/offline-data`, so you can bookmark a tab or link to it. You can also press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) and type a tab's name, like "Storage", to jump to it.

Some tabs only show up in certain setups:

| Tab | Desktop app (own library) | Desktop app (connected to a server) | Server in a browser |
|---|---|---|---|
| [General](#general) | Yes | Yes | Yes |
| [Account](#account) | No | Yes | Yes |
| [Species and import](#species-and-import) | Yes | Yes | Yes |
| [Library](#library) | Yes | Yes | Yes |
| [Storage](#storage) | Yes | Yes | Yes |
| [Server](#server) | Yes | Yes | No |
| [Integrations](#integrations) | Yes | Yes | Yes |
| [Offline data](#offline-data) | Yes | Yes | Yes |

The desktop app's own library has no login, so it has no Account tab. The Server tab is part of the desktop app, so it doesn't appear in a web browser. Some cards inside a tab also depend on the setup; each one below says when.

## General {#general}

### Appearance {#appearance}

Choose **Follow system**, **Light** or **Dark**. **Follow system** matches whatever your computer or phone is set to.

### Language {#language}

Lifer is English only for now, so this setting doesn't appear yet; more languages are on the [roadmap](./roadmap.md). Once there's a second language, you'll choose it here: **Automatic (match my system)** will follow your browser's or computer's language, and the choice will follow your account to other devices. Dates and numbers already follow your system's region.

### App updates {#app-updates}

Desktop app only. Shows the version you're running ("You're on version …") and checks for a newer one each time you open the card, and again when you come back online.

- **Check again** checks by hand.
- When a newer version exists, you see **Update available** with the installed and latest versions and the release notes. Click **Update now** to download and install it. Lifer restarts on its own when it's done.
- If you're offline, the card says so. Connect to the internet and try again.
- If the update can't install itself, the card shows how to install it by hand:
  - **Mac:** click **Download Lifer … (.zip)**, open the `.zip`, and drag Lifer into Applications to replace the old copy. If Lifer is running from a temporary location, move `Lifer.app` into Applications first and try again.
  - **Windows:** download the installer from the Releases page and run it.
  - **Linux:** download the latest version from the Releases page. A `.deb` install always updates this way.

  See [Updating the desktop app](./install/desktop.md#updating).

If your region packs have updates, this card also shows "Pack update available" with a **View packs** link.

### Getting started {#getting-started}

**Open the guide** opens a short in-app tour of how the collection, import and offline packs fit together. It's the same tour offered at the end of server setup.

## Account {#account}

Server accounts only, including the desktop app while it's connected to a server. Every change here except API keys asks for your current password.

### Email {#email}

Type a **New email** and your **Current password**, then click **Update email**. This signs out every other device and browser using your account. You stay signed in where you made the change.

### Password {#password}

Enter your **Current password**, a **New password** (at least 8 characters) and **Confirm new password**, then click **Update password**. Like changing your email, this signs out your other devices, so anyone who knew the old password loses access right away. If you forget it, see [Resetting a forgotten password](./troubleshooting.md#forgot-password).

### API keys {#api-keys}

Click **Manage API keys** to create keys for your own scripts and integrations. Keys are only available on a server.

1. Click **New key**.
2. Give it a **Name**, like "Home Assistant dashboard".
3. Under **Permissions**, tick **Read** or **Write** only for what the integration needs (Gallery, Species, Stats, Trips, Albums, Shares, Photos, Life list).
4. Click **Create key**.
5. Click **Copy** right away. Lifer shows the key only once.

Each key shows when it was last used (or "Never used"). **Revoke** turns a key off immediately, and can't be undone. The [API overview](./api/overview.md) explains what each permission allows.

## Species and import {#species-and-import}

### Species suggestions {#species-suggestions}

**Suggest species while importing photos** (on by default). Marked **Experimental**. While you import, Lifer suggests likely species for each photo by comparing it to your own past photos and to reference photos for that region. Nothing leaves your device. Every time you confirm or correct a suggestion, that photo becomes one more example, so suggestions get better for you over time.

This needs the species-matching model. If the model isn't downloaded, the checkbox is greyed out with a **Download it from Offline data** link to the [Species-matching model](#species-model) card.

### Any-taxa search {#any-taxa-search}

**Enable any-taxa search** (off by default). The offline packs cover birds, mammals, fish, reptiles and amphibians, and marine invertebrates. For everything else (insects, spiders, plants, fungi and more), turning this on lets you add species from iNaturalist. They appear under **Other Taxa** on the Collection page for the country, province or state you choose, marked **Added by you**, with a photo and description from iNaturalist. Only you see the ones you add. They have no rarity tier or occurrence data.

Once it's on, open the **Search iNaturalist** window in any of these ways:

- Click **Search iNaturalist for a species to add**, right in this card.
- Press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux), type at least two letters of a name, and choose the **Search iNaturalist** row. When nothing in Lifer matches, it reads "No local match for "…", search iNaturalist".
- On a region's empty **Other Taxa** view in the Collection, click **Search iNaturalist**.

The window has two tabs:

- **One species:** search by scientific or common name, pick a result, choose the region it should appear under, and click **Add species**. Lifer opens the new species page.
- **Import a list:** paste one entry per line, choose a region, and click **Start import**. Scientific names work best; common names and iNaturalist taxon IDs also work. There's no file upload, but you can copy a column from a spreadsheet or CSV and paste it straight in. The import runs in the background, so you can close the window. When it finishes it shows how many were added, how many were already on the list, and which names iNaturalist couldn't find.

See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

### Species naming {#species-naming}

Controls how species are named in folder names and in the tags Lifer writes into your photo files. Tick any combination and use the arrows to set the order:

- **Common name** (for example "American Robin")
- **Scientific (Latin) name** ("Turdus migratorius")
- **eBird code** (6 letters, every bird worldwide)
- **Full taxonomy tree** ("Aves / Passeriformes / Turdidae / Turdus migratorius")
- **ABA code** (4 letters, birds of North America, Mexico, Central America and the Caribbean). This option appears once you've downloaded a pack that covers those regions.

The first part a species actually has comes first, and the rest follow in parentheses. eBird and ABA codes are skipped for anything that isn't a bird. The default is **Common name** alone.

Changing this only affects new photos. Click **Update existing photos to match** to rename existing folders and refresh the tags in files you already have.

### Import eBird checklist data {#ebird}

Export `MyEBirdData.csv` from eBird's **Download My Data** page, then click **Choose CSV file…** here. Species you've seen but not photographed show as **seen**. Species you've already photographed are never downgraded. When it's done, the card shows how many species matched, how many are newly seen, and how many didn't match. See [Import from eBird](./guides/ebird-import.md).

### Obscure and inaccessible species {#obscure-species}

**Hide obscure/inaccessible species from region checklists** (on by default). Hides deep-water fish beyond diving depth and species with almost no historical records, mostly ones nobody will realistically encounter. Anything you've already collected or seen always stays visible.

### Technical diving {#technical-diving}

**Use technical diving depth range (120m) instead of recreational (60m)** (off by default). The obscure-species filter above treats fish deeper than about 60 m as out of reach. Turn this on if you're technical-dive certified and want fish down to 120 m on your checklists.

## Library {#library}

### Library {#library-links}

Shows your library folder and buttons for **Offline packs**, **Archived species**, **Hidden species**, **Trash** and **Manage tags**.

**Manage tags** lists every custom tag on your photos with how many photos carry it. **Rename** fixes a typo or merges one tag into another. **Delete** removes a tag from every photo (the photos themselves stay).

### Photo library organization {#photo-library-organization}

Controls where full-size originals are filed inside your library folder. See [Library folders](./guides/library-folders.md) for examples.

- **Organize into Wildlife &lt;year taken&gt;/Birds|Mammals|Fish/Species name folders** (off by default). Groups photos by the year each photo was taken.
- **Add an outermost folder named after the location you type in at import time** (off by default). Uses the location text you enter when importing, not GPS. Only applies to photos you gave a location.

The two stack, with the location folder outermost: for example `Prince George/Wildlife <year taken>/Birds/Species name`. They only change where new photos go. Click **Reorganize existing photos now** to move existing files to match.

### Reimport library {#reimport}

Rebuilds your Lifer records from photos already on disk. Use it after a fresh install or a server move, to repair links after a drive was reconnected under a different name, or to bring in photos organized some other way. It has two modes:

- **Reimport my existing library** scans one location: **Main library**, or one connected drive or library folder chosen under **Reimport from**. It never moves or changes your files. Click **Reimport library now**.
- **Import a library organized differently** points at any folder, like a Lightroom export or a folder of dated dumps. Lifer matches each photo to a species using tags already in the file (scientific name, common name, or an older name from before a rename). Photos it can't match stay where they are and are listed under **Review unmatched**, where **Ignore** keeps them out of future scans. Type the folder path or click **Browse…**. Tick **Organize matched photos into species folders in my library** to move matched photos into your library, or leave it off to add them without moving anything. Click **Import library now**.

Both modes read the picks and rejects a culling app left in your photos. **Photos a culling app marked rejected** chooses what happens to rejected ones: **Import them hidden** (the default) brings them in hidden, so photos you imported before aren't lost but stay out of the way (find them with the Gallery's **Hidden** filter); **Skip them** leaves them out; and **Import them anyway** ignores the mark. Skipped photos stay on disk untouched, and the results say how many were skipped or hidden. See [Culling with other apps](./guides/culling-with-other-apps.md). Tags you gave photos in Lifer come back too, for photos whose files Lifer wrote them into.

On a server you can only pick folders inside the library folder or an extra [library folder](#library-folders). A running reimport can be stopped with **Cancel**; files already in progress still finish. If recovered species are missing reference photos, the results link to the packs that would restore them.

## Storage {#storage}

### Storage location {#storage-location}

Where your photo library lives.

- **Desktop app:** click **Choose a different folder…** and confirm **Move library**. Lifer moves every file and updates its records. Restart Lifer afterwards for the new location to take effect.
- **Server:** read only. It shows the folder inside the container. To move the library, change `LIFER_STORAGE_DIR` and redeploy. See [Install with Docker](./install/docker.md#volumes).

### External drives {#external-drives}

Desktop app with its own library only. Register a drive that holds part of your library. Lifer keeps a thumbnail of every photo, so you can still browse when the drive is unplugged and see which drive to go find.

1. Click **Add a drive…** and pick the folder on the drive.
2. Type a name, for example "Red 2TB drive".
3. Click **Register this folder**. If the drive already has photos Lifer knew about, it says how many it recognized.

Each drive shows **Connected** or **Not connected** (with when it was last seen). You can **Rename**, **Set as default** or **Remove** a drive. Removing only stops tracking it; imported photos stay in your library.

### Library folders {#library-folders}

Server only, including the desktop app while it's connected to a server. Extra folders on the server that Lifer can import from, build trips from, and save photos to. They are set with `LIFER_LIBRARY_ROOTS`, so this card is read only and shows each folder as **Connected** or **Not found**. With none set up, it shows the steps to add one. See [Extra library folders](./install/docker.md#extra-library-folders).

## Server {#server}

Desktop app only. What you see depends on whether the app is using its own library or a server. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md) for step by step instructions.

### Sign in to a server {#sign-in-to-a-server}

Shown while using the app's own library. Enter the server address and click **Connect**, then your **Email** and **Password** and click **Sign in**. **Keep an offline cache after connecting** (on by default) keeps low-resolution covers and your collected and seen status browsable if you lose the connection. **Use a different address** goes back a step. A plain `http://` address on a public network gets a warning, since your password would travel unencrypted.

### Migrate your library to a server {#migrate}

Appears once **Connect** has reached the server. Uploads your whole local library to the server. Enter the server address, the **Email on that server** and **Password**, click **Migrate my library**, and wait for it to finish. It shows how many photos were migrated, skipped and failed. Then click **Switch this window to the server**. Your local copies stay until you choose **Delete local files now that they're on the server**, which only appears after a run with nothing failed or skipped.

### Connect a server {#connect-a-server}

Shown while connected to a server. **Switch to local library** goes back to the app's own library, the one you used last, without asking for a folder. Signing out of the server does the same, and so does **Use This Computer's Library** in the Lifer menu. Lifer remembers the server, so you can connect again from **Sign in to a server**.

**Keep an offline cache** shows when the cache last synced, how many species and covers it holds, and its size. Untick it to delete the cache from this computer. See [Offline cache](./install/connect-desktop-to-server.md#offline-cache).

### Automatic URL switching {#url-switching}

Shown while connected to a server. Lets the app use a fast local address on your home Wi-Fi and a public address everywhere else. Click **Set up**, then:

- Under **Local network**, enter the server's local address and your Wi-Fi network name. **Use current connection** fills both in for you.
- Under **External networks**, **Add** one or more addresses. Lifer tests each one and marks it with a tick or a cross. Away from your Wi-Fi it uses the first one it can reach, top to bottom. Drag to reorder.
- Click **Save**.

### When the server is offline {#server-offline}

If the desktop app can't reach your server when it opens, or loses it for about a minute while you're using it, it says **Server disconnected** and switches to the library on this computer, so you can keep working. The first time, that library is set up and its species catalog loaded, which takes a minute or two.

When the server answers again, Lifer offers:

- **Push My Photos** opens **Settings > Server** in this computer's library. Connect and run [Migrate your library to a server](#migrate); it only sends photos the server doesn't have yet.
- **Switch to Server** goes straight back to the server.
- **Not Now** stays on this computer. Push later from **Settings > Server**.

The app stays set to your server: next time it opens, it connects to the server if it can.

## Integrations {#integrations}

- **iNaturalist:** sending your sightings to iNaturalist as observations is [coming soon](./guides/inaturalist.md#observations).

## Offline Data {#offline-data}

### Species catalog updates {#species-catalog}

Refreshes rarity tiers, occurrence stats and endemic labels from the latest published data. It never touches reference photos you've downloaded. Lifer checks when you open the card; **Check again** checks by hand. If a newer catalog exists, click **Update catalog** (it shows the download size). A running update can be cancelled.

### Offline map {#offline-map}

The offline basemap (about 550 MB) is what draws the maps showing roughly where a species is found within a region. Maps don't show without it, even online. Everything else works the same either way. Click **Download offline map (~550 MB)**, or **Offload** to free the space.

### Species-matching model {#species-model}

Powers species suggestions while importing and searching the Gallery by what's in a photo (like "water bird"). Without it, Lifer is smaller and Gallery search matches species names, ABA and eBird codes and camera details only.

- **Download models (~620 MB)** installs both the general model and the species identification model (BioCLIP 2).
- **Download the identification model (~310 MB)** appears when only the general model is installed.
- The status line says which model suggestions currently use, and whether matching runs on the CPU or a GPU. **Re-test hardware** checks for a GPU again. See [GPU acceleration](./install/hardware-acceleration.md).
- **Offload** frees the space, turns species suggestions off, and makes Gallery search fall back to names, codes and camera details. You can download again any time.

If a download fails, see [Model download failures](./troubleshooting.md#model-download).

### Downloaded packs {#downloaded-packs}

Lists the region packs you've downloaded and how much space they use. **Update**, **Update all** and **Offload** work here. To download new regions, use **Browse regions** (when nothing is downloaded yet) or **Manage in Offline packs**. See [Offline packs and the map](./guides/offline-packs-and-map.md).

### Photos packs can't include {#withheld-photos}

Some photos can't be included in packs for licensing reasons: their photographer kept all rights, or chose a license Lifer can't share. With **Fetch withheld photos in the background** on (the default), Lifer downloads the main photo of those species from iNaturalist for your own viewing, so the species in your downloaded packs have a photo offline too. It's the same as opening the species online, with the photographer's credit and license kept with the photo.

It runs quietly after a pack download and each time Lifer starts, one species every few seconds and at most 2,000 a day, so it goes easy on iNaturalist. If iNaturalist asks it to slow down, it waits an hour. A species it couldn't get a photo for is tried again after 30 days. Only the main photo is fetched, not the extra gallery photos. The setting covers the whole install, every account on it, and turning it off stops a fetch that's running.

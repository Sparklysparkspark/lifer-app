---
title: Settings reference
description: Every Settings tab in Lifer, and what each option does.
slug: /settings
---

# Settings reference

Click **Settings** in the top bar. Each tab has its own address, like `/settings/storage` or `/settings/offline-data`, so you can bookmark a tab or link to it. You can also press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) and type a tab's name, like "Storage", to jump to it.

![The Species and import tab in Settings](/img/settings.jpg)

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

The desktop app's own library has no login, so it has no Account tab. The Server tab is part of the desktop app, so it doesn't appear in a web browser.

Each tab groups its settings into panels of rows. Most on/off options are switches. Some rows also depend on the setup; each one below says when.

## General {#general}

### Theme {#appearance}

In the **Appearance** panel, choose **Follow system**, **Light** or **Dark**. **Follow system** matches whatever your computer or phone is set to.

### Language {#language}

Lifer is English only for now, so this setting doesn't appear yet; more languages are on the [roadmap](./roadmap.md). Once there's a second language, you'll choose it under **Appearance**: **Automatic (match my system)** will follow your browser's or computer's language, and the choice will follow your account to other devices. Dates and numbers already follow your system's region.

### App updates {#app-updates}

Desktop app only, in the **About** panel. Shows the version you're running and checks for a newer one each time you open the tab, and again when you come back online.

- **Check for updates** or **Check again** checks by hand.
- When a newer version exists, the row says which version is available and which you have, with the release notes. Click **Update now** to download and install it. Lifer restarts on its own when it's done.
- If you're offline, the row says so. Connect to the internet and try again.
- If the update can't install itself, the row shows how to install it by hand:
  - **Mac:** click **Download Lifer … (.zip)**, open the `.zip`, and drag Lifer into Applications to replace the old copy. If Lifer is running from a temporary location, move `Lifer.app` into Applications first and try again.
  - **Windows:** download the installer from the Releases page and run it.
  - **Linux:** download the latest version from the Releases page. A `.deb` install always updates this way.

  See [Updating the desktop app](./install/desktop.md#updating).

If your region packs have updates, an **Offline packs** row also shows how many are ready, with a **View packs** link.

### Getting started {#getting-started}

In the **About** panel. **Open the guide** opens a short in-app tour of how the collection, import and offline packs fit together. It's the same tour offered at the end of server setup.

## Account {#account}

Server accounts only, including the desktop app while it's connected to a server. Every change here except API keys asks for your current password.

### Email {#email}

In the **Sign-in** panel. Type a **New email** and your **Current password**, then click **Update email**. This signs out every other device and browser using your account. You stay signed in where you made the change.

### Password {#password}

In the **Sign-in** panel. Enter your **Current password**, a **New password** (at least 8 characters) and **Confirm new password**, then click **Update password**. Like changing your email, this signs out your other devices, so anyone who knew the old password loses access right away. If you forget it, see [Resetting a forgotten password](./troubleshooting.md#forgot-password).

### API keys {#api-keys}

In the **Scripts and integrations** panel, click **Manage API keys** to create keys for your own scripts and integrations. Keys are only available on a server.

1. Click **New key**.
2. Give it a **Name**, like "Home Assistant dashboard".
3. Under **Permissions**, tick **Read** or **Write** only for what the integration needs (Gallery, Species, Stats, Trips, Albums, Shares, Photos, Life list).
4. Click **Create key**.
5. Click **Copy** right away. Lifer shows the key only once.

Each key shows when it was last used (or "Never used"). **Revoke** turns a key off immediately, and can't be undone. The [API overview](./api/overview.md) explains what each permission allows.

## Species and import {#species-and-import}

### Suggest species while importing {#species-suggestions}

In the **Identification** panel (on by default). While you import, Lifer suggests likely species for each photo by comparing it to your own past photos and to reference photos for that region. Nothing leaves your device. Every time you confirm or correct a suggestion, that photo becomes one more example, so suggestions get better for you over time.

This needs the species-matching model. If the model isn't downloaded, the switch is off and grayed out, with a **Download it in Offline data** link to the [Species-matching model](#species-model) row.

### Search iNaturalist for other species {#any-taxa-search}

In the **Identification** panel (off by default). The offline packs cover birds, mammals, fish, reptiles and amphibians, and marine invertebrates. For everything else (insects, spiders, plants, fungi and more), turning this on lets you add species from iNaturalist. Your searches are sent to iNaturalist. Species you add appear under **Other Taxa** on the Collection page for the country, province or state you choose, marked **Added by you**, with a photo and description from iNaturalist. Only you see the ones you add. They have no rarity tier or occurrence data.

Once it's on, open the **Search iNaturalist** window in any of these ways:

- Click **Search** in the **Add a species from iNaturalist** row, right below the switch.
- Press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux), type at least two letters of a name, and choose the **Search iNaturalist** row. When nothing in Lifer matches, it reads "No local match for "…", search iNaturalist".
- On a region's empty **Other Taxa** view in the Collection, click **Search iNaturalist**.

The window has two tabs:

- **One species:** search by scientific or common name, pick a result, choose the region it should appear under, and click **Add species**. Lifer opens the new species page.
- **Import a list:** paste one entry per line, choose a region, and click **Start import**. Scientific names work best; common names and iNaturalist taxon IDs also work. There's no file upload, but you can copy a column from a spreadsheet or CSV and paste it straight in. The import runs in the background, so you can close the window. When it finishes it shows how many were added, how many were already on the list, and which names iNaturalist couldn't find.

See [Add insects, plants, fungi and more](./guides/inaturalist.md#any-taxa).

### Name format {#species-naming}

In the **Species names** panel. Controls how species are named in folder names and in the tags Lifer writes into your photo files. Tick any combination and use the arrows to set the order:

- **Common name** (for example "American Robin")
- **Scientific (Latin) name** ("Turdus migratorius")
- **eBird code** (6 letters, every bird worldwide)
- **Full taxonomy tree** ("Aves / Passeriformes / Turdidae / Turdus migratorius")
- **ABA code** (4 letters, birds of North America, Mexico, Central America and the Caribbean). This option appears once you've downloaded a pack that covers those regions.

The first part a species actually has comes first, and the rest follow in brackets. eBird and ABA codes are skipped for anything that isn't a bird. The default is **Common name** alone.

Changing this only affects new photos. In **Rename existing photos**, click **Update photos** to rename existing folders and refresh the tags in files you already have.

### Import from eBird {#ebird}

In the **Checklists** panel. Export `MyEBirdData.csv` from eBird's **Download My Data** page, then click **Choose file** here. Species you've seen but not photographed show as **seen**. Species you've already photographed are never downgraded. When it's done, the row shows how many species were in the file, how many are newly seen, how many were already seen or collected, and how many didn't match. See [Import from eBird](./guides/ebird-import.md).

### Hide obscure species {#obscure-species}

In the **Checklists** panel (on by default). Hides deep-water fish beyond diving depth and species with almost no historical records, mostly ones nobody will realistically encounter. Anything you've already collected or seen always stays visible.

### Technical diving depths {#technical-diving}

In the **Checklists** panel (off by default). **Hide obscure species** treats fish deeper than about 60 m as out of reach. Turn this on if you're technical-dive certified and want fish down to 120 m on your checklists.

## Library {#library}

### Location and Manage {#library-links}

The **Library** panel starts with your library folder (**Location**) and a **Manage** row with links to **Offline packs**, **Archived species**, **Hidden species**, **Trash** and **Tags**.

**Tags** lists every custom tag on your photos with how many photos carry it. **Rename** fixes a typo or merges one tag into another. **Delete** removes a tag from every photo (the photos themselves stay).

### Folders by year and location {#photo-library-organization}

Also in the **Library** panel. These switches control where full-size originals are filed inside your library folder. See [Library folders](./guides/library-folders.md) for examples.

- **Folders by year** (off by default) files originals under `Wildlife <year taken>/Birds/Species name` instead of just `Species name`.
- **Folders by location** (off by default) adds an outer folder named after the location you type in at import time. It uses that text, not GPS, and only applies to photos you gave a location.

The two stack, with the location folder outermost: for example `Prince George/Wildlife <year taken>/Birds/Species name`. They only change where new photos go. In **Reorganize existing photos**, click **Reorganize** to move existing files to match.

### Reimport {#reimport}

The **Reimport** panel rebuilds your Lifer records from photos already on disk. Use it after a fresh install or a server move, to repair links after a drive was reconnected under a different name, or to bring in photos organized some other way. Pick a **Source**:

- **Lifer library** rebuilds your own library. It never moves or changes your files. If you have connected drives or library folders, **Scan** chooses one location: **Main library** or one drive. Click **Reimport**.
- **Another folder** points at any folder, like a Lightroom export or a folder of dated dumps. Lifer matches each photo to a species using tags already in the file (scientific name, common name, or an older name from before a rename). Type the path in **Folder to import** or click **Browse**. Turn on **Move into species folders** to move matched photos into your library, or leave it off to add them where they are. Click **Import**.

Photos Lifer can't match to one species stay where they are. After the run, **Unmatched photos** lists them: click **Review**, and **Ignore** keeps a photo out of future scans.

Both sources read the picks and rejects a culling app left in your photos. **Rejected photos** chooses what happens to rejected ones: **Import them hidden** (the default) brings them in hidden, so photos you imported before aren't lost but stay out of the way (find them with the Gallery's **Hidden** filter); **Skip them** leaves them out; and **Import them anyway** ignores the mark. Skipped photos stay on disk untouched, and the results say how many were skipped or hidden. See [Culling with other apps](./guides/culling-with-other-apps.md). Tags you gave photos in Lifer come back too, for photos whose files Lifer wrote them into.

On a server you can only pick folders inside the library folder or an extra [library folder](#library-folders). A running reimport can be stopped with **Cancel**; files already in progress still finish. If recovered species are missing reference photos, the results link to the packs that would restore them.

## Storage {#storage}

### Library folder {#storage-location}

In the **Where photos live** panel. Shows where your photo library lives.

- **Desktop app:** click **Move**, pick the new folder and confirm **Move library**. Lifer moves every file and updates its records. Restart Lifer afterwards for the new location to take effect.
- **Server:** read only. It shows the folder inside the container. To move the library, change `LIFER_STORAGE_DIR` and redeploy. See [Install with Docker](./install/docker.md#volumes).

### External drives {#external-drives}

Desktop app with its own library only, in the **Where photos live** panel. Register a drive that holds part of your library. Lifer keeps a thumbnail of every photo, so you can still browse when the drive is unplugged and see which drive to go find.

1. Click **Add a drive** and pick the folder on the drive.
2. Type a name, for example "Red 2TB drive".
3. Click **Add drive**. If the drive already has photos Lifer knew about, it says how many it recognized.

Each drive has its own row showing **Connected** or **Not connected** (with when it was last seen). You can **Rename**, **Make default** or **Remove** a drive. Removing only stops tracking it; imported photos stay in your library.

### Extra library folders {#library-folders}

Server only, including the desktop app while it's connected to a server. Extra folders on the server that Lifer can import from, build trips from, and save photos to. They are set with `LIFER_LIBRARY_ROOTS`, so this row is read only and shows each folder as **Connected** or **Not found**. With none set up, it shows the steps to add one. See [Extra library folders](./install/docker.md#extra-library-folders).

### Remove all Lifer data {#remove-all-data}

Desktop app with its own library only, in the **Uninstall** panel. Deletes everything Lifer keeps on this computer, then quits. Your photos stay where they are. See [Uninstalling](./install/desktop.md#uninstalling).

## Server {#server}

Desktop app only. What you see depends on whether the app is using its own library or a server. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md) for step by step instructions.

### Sign in to a server {#sign-in-to-a-server}

Shown while using the app's own library. Enter the server address and click **Connect**, then your **Email** and **Password** and click **Sign in**. **Keep an offline cache** (on by default) keeps low-resolution covers and your collected and seen status browsable if you lose the connection. **Use a different address** goes back a step. A plain `http://` address on a public network gets a warning, since your password would travel unencrypted.

### Migrate this library {#migrate}

Appears in the **Migrate** panel once **Connect** has reached the server. Uploads your whole local library to the server. Enter the server address, the **Email on that server** and **Password**, click **Migrate**, and wait for it to finish. It shows how many photos were migrated, skipped and failed. Then click **Switch** in **Switch to the server**. Your local copies stay until you click **Delete** in **Delete local files**, which only appears after a run with nothing failed or skipped.

### Server connection {#connect-a-server}

Shown in the **Connection** panel while connected to a server. The **Server** row shows which server you're using. **Use local library** goes back to the app's own library, the one you used last, without asking for a folder. Signing out of the server does the same, and so does **Use This Computer's Library** in the Lifer menu. Lifer remembers the server, so you can connect again from **Sign in to a server**.

**Offline cache** shows when the cache last synced, how many species and covers it holds, and its size. Turn it off to delete the cache from this computer. See [Offline cache](./install/connect-desktop-to-server.md#offline-cache).

### Automatic address switching {#url-switching}

Shown while connected to a server. Lets the app use a fast local address on your home Wi-Fi and other addresses everywhere else. Click **Set up**, then:

- Under **Home network**, enter the server's local address and your Wi-Fi network name. **Use current connection** fills both in for you.
- Under **Other addresses**, **Add** one or more addresses. Lifer tests each one and marks it with a tick or a cross. Away from your Wi-Fi it uses the first one that answers, top to bottom. Drag to reorder.
- In **Save addresses**, click **Save**. It needs a home address and at least one other.

### When the server is offline {#server-offline}

If the desktop app can't reach your server when it opens, or loses it for about a minute while you're using it, it says **Server disconnected** and switches to the library on this computer, so you can keep working. The first time, that library is set up and its species catalog loaded, which takes a minute or two.

When the server answers again, Lifer offers:

- **Push My Photos** opens **Settings > Server** in this computer's library. Connect and run [Migrate this library](#migrate); it only sends photos the server doesn't have yet.
- **Switch to Server** goes straight back to the server.
- **Not Now** stays on this computer. Push later from **Settings > Server**.

The app stays set to your server: next time it opens, it connects to the server if it can.

## Integrations {#integrations}

- **iNaturalist:** sending your sightings to iNaturalist as observations is [coming soon](./guides/inaturalist.md#observations).

## Offline data {#offline-data}

### Species catalog {#species-catalog}

In the **Species data** panel. Refreshes rarity tiers, occurrence stats and endemic labels from the latest published data. It never touches reference photos you've downloaded. Lifer checks when you open the tab; **Check again** checks by hand. If a newer catalog exists, the row shows its download size. Click **Update**. A running update can be cancelled.

### Species-matching model {#species-model}

In the **Species data** panel. Powers species suggestions while importing and searching the Gallery by what's in a photo (like "water bird", or scenes and colors such as "sky", "fence" or "purple"). Without it, Lifer is smaller and Gallery search matches species names, ABA and eBird codes and camera details only.

- **Download** installs the general model, the species identification model (BioCLIP 2) and the scene model, which finds scenes and colors for Gallery search. That's about 680 MB.
- If only part is installed, the row says what's missing (the identification model, about 370 MB, or the scene model, about 61 MB), and **Download** gets it.
- The row says which model suggestions currently use.
- **Hardware** says whether matching runs on the CPU or a GPU. **Test again** checks for a GPU again. See [GPU acceleration](./install/hardware-acceleration.md).
- **Remove** frees the space, turns species suggestions off, and makes Gallery search fall back to names, codes and camera details. You can download again any time.

If a download fails, see [Model download failures](./troubleshooting.md#model-download).

### Offline map {#offline-map}

In the **Species data** panel. The offline basemap (about 550 MB) draws the maps showing roughly where a species is found within a region. Maps don't show without it, even online. Everything else works the same either way. Click **Download**, or **Remove** to free the space.

### Downloaded packs {#downloaded-packs}

In the **Region packs** panel. Lists the region packs you've downloaded and how much space they use. **Update**, **Update all** and **Remove** work here. To download new regions, use **Browse regions** (when nothing is downloaded yet) or **Manage packs**. See [Offline packs and the map](./guides/offline-packs-and-map.md).

### Fetch photos packs can't include {#withheld-photos}

In the **Region packs** panel. Some photos can't be included in packs for licensing reasons: their photographer kept all rights, or chose a license Lifer can't share. With this switch on (the default), Lifer downloads the main photo of those species from iNaturalist for your own viewing, so the species in your downloaded packs have a photo offline too. It's the same as opening the species online, with the photographer's credit and license kept with the photo.

It runs quietly after a pack download and each time Lifer starts, one species every few seconds and at most 2,000 a day, so it goes easy on iNaturalist. If iNaturalist asks it to slow down, it waits an hour. A species it couldn't get a photo for is tried again after 30 days. Only the main photo is fetched, not the extra gallery photos. The setting covers the whole install, every account on it, and turning it off stops a fetch that's running.

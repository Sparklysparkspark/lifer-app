---
title: Settings reference
description: Every Settings tab in Lifer, and what each option does.
slug: /settings
---

# Settings reference

Click **Settings** in the top bar. Each tab has its own address, like `/settings/storage` or `/settings/offline-data`, so you can bookmark a tab or link to it. You can also press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) and type a tab's name, like "Storage", to jump to it.

![The Species and import tab in Settings](/img/settings.jpg)

Some tabs only show up in certain setups:

| Tab                                       | Desktop app (own library) | Desktop app (connected to a server) | Server in a browser |
| ----------------------------------------- | ------------------------- | ----------------------------------- | ------------------- |
| [General](#general)                       | Yes                       | Yes                                 | Yes                 |
| [Account](#account)                       | No                        | Yes                                 | Yes                 |
| [Species and import](#species-and-import) | Yes                       | Yes                                 | Yes                 |
| [Library](#library)                       | Yes                       | Yes                                 | Yes                 |
| [Storage](#storage)                       | Yes                       | Yes                                 | Yes                 |
| [Server](#server)                         | Yes                       | Yes                                 | No                  |
| [Integrations](#integrations)             | Yes                       | Yes                                 | Yes                 |
| [Offline data](#offline-data)             | Yes                       | Yes                                 | Yes                 |

The desktop app's own library has no login, so it has no Account tab. The Server tab is part of the desktop app, so it doesn't appear in a web browser.

Each tab groups its settings into panels of rows. Most on/off options are switches. Some rows also depend on the setup; each one below says when.

## General {#general}

### Theme {#appearance}

In the **Appearance** panel, choose **Follow system**, **Light** or **Dark**. **Light** is the default. **Follow system** matches whatever your computer or phone is set to.

### Map and places {#map}

- **Online map:** **Automatic** (the default) loads street and trail detail from OpenFreeMap when you zoom the photo map in and are online; **Off** keeps the map fully offline; **Satellite** shows EOX imagery. The same choice is in the map's layers button. What it sends is on the [Privacy](./privacy.md#map-tiles) page.
- **Online place names and search:** **Automatic** (the default) also searches places online and names places from a point, through Photon by komoot, when you're online; **Off** keeps place search on your device. The same choice is in the map's layers button.
- **Satellite imagery URL:** optional, a tile address from your own imagery provider, with `{z}`, `{x}` and `{y}` in it and usually your key. It shows as dots like a password (the eye button reveals it) and is saved only on that device. Empty uses the free imagery.

### Names and labels {#names-and-labels}

How species cards name each species, everywhere in Lifer:

- **Main name:** lead with the **Common** or the **Scientific** name.
- **Also show:** the other name, the **ABA code** and the **eBird code** below it (codes only appear on birds that have one).
- **Show card tags:** the small tags on species cards, such as Endemic, Vagrant, Rare here and Added by you. On by default.

The name choices are saved to your account too, so your share pages use them. **Hide names** stays in the Collection's **View** menu as a quick switch.

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

If your downloaded regions have updates, a **Species downloads** row also shows how many are ready, with a **View regions** link.

### Getting started {#getting-started}

In the **About** panel. **Open the guide** opens the longer written guide to how imports, trips and downloaded regions fit together.

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

At the top, **Download more countries and animal groups** opens [Species downloads](#regions).

### Suggest species while importing photos {#species-suggestions}

In the **Identification** panel (on by default). While you import, Lifer suggests likely species for each photo by comparing it to your own past photos and to reference photos for that region. Nothing leaves your device. Every time you confirm or correct a suggestion, that photo becomes one more example, so suggestions get better for you over time.

This needs species recognition. If it isn't downloaded, the switch is off and grayed out, with a **Download it in Offline data** link to the [Species recognition](#species-model) row.

### Search iNaturalist for other species {#any-taxa-search}

In the **Identification** panel (on by default). Downloaded regions cover birds, mammals, fish, reptiles and amphibians, and marine invertebrates. For everything else (insects, spiders, plants, fungi and more), this lets you add species from iNaturalist. Importing an existing library also uses it to suggest a species for photos Lifer can't match, from their tags and folder names. Those names and your searches are sent to iNaturalist; turn this off and Lifer doesn't contact it for either. Species you add appear under **Other species** on the Collection page for the country, province or state you choose, marked **Added by you**, with a photo and description from iNaturalist. Only you see the ones you add. They have no rarity or occurrence data.

Once it's on, open the **Search iNaturalist** window in any of these ways:

- Click **Search** in the **Add a species from iNaturalist** row, right below the switch.
- Press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux), type at least two letters of a name, and choose the **Search iNaturalist** row. When nothing in Lifer matches, it reads "No local match for "…", search iNaturalist".
- On a region's empty **Other species** view in the Collection, click **Search iNaturalist**.

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
- **ABA code** (4 letters, birds of North America, Mexico, Central America and the Caribbean). This option appears once you've downloaded a region that covers them.

The first part a species actually has comes first, and the rest follow in brackets. eBird and ABA codes are skipped for anything that isn't a bird. The default is **Common name** alone.

Changing this only affects new photos. In **Rename existing photos**, click **Update photos** to rename existing folders and refresh the tags in files you already have.

### Import from eBird {#ebird}

In the **Checklists** panel. Export `MyEBirdData.csv` from eBird's **Download My Data** page, then click **Choose file** here. Species you've seen but not photographed show as **seen**. Species you've already photographed are never downgraded. When it's done, the row shows how many species were in the file, how many are newly seen, how many were already seen or photographed, and how many didn't match. See [Import from eBird](./guides/ebird-import.md).

### Hide species almost nobody photographs {#obscure-species}

In the **Checklists** panel (on by default). Hides deep-water fish beyond diving depth and species with almost no historical records, mostly ones nobody will realistically encounter. Anything you've already photographed or seen always stays visible.

### Technical diving depths {#technical-diving}

In the **Checklists** panel (off by default). **Hide species almost nobody photographs** treats fish deeper than about 60 m as out of reach. Turn this on if you're technical-dive certified and want fish down to 120 m on your checklists.

## Library {#library}

### Location and Manage {#library-links}

The **Library** panel starts with your library folder (**Location**) and a **Manage** row with links to **Archived species**, **Hidden species**, **Trash**, **Tags** and **Places**.

**Tags** lists every custom tag on your photos with how many photos carry it (hidden photos aren't counted). Search from the field at the top right. Each tag's **⋯** menu (or a right-click) has **Rename** and **Delete**. **Rename** fixes a typo or merges one tag into another. **Delete** removes a tag from every photo, after saying how many it affects (the photos themselves stay). Both include hidden photos, but not photos in the Trash.

**Places** lists every place name on your photos, with its most common region and how many photos carry it. Click a row to see those photos in the Gallery. Each name's **⋯** menu (or a right-click) has **Rename** and **Remove**. **Rename** fixes a typo on every photo at once; renaming to a name you already use merges the two, and Lifer asks first. **Remove** says how many photos it affects, then takes the name off them; their regions stay. Both include hidden photos (which the list doesn't count), but not photos in the Trash. Lifer writes the new name into the photo files it keeps, as IPTC Sublocation. With country, province or place folders in your [folder layout](#photo-library-organization), the files also move to the folder for the new name (or out of the place folder after a remove), and Lifer reports how many moved. Only files Lifer keeps move; files on a drive that isn't connected stay put, and a file is never moved over another one.

### Folder layout {#photo-library-organization}

Also in the **Library** panel. **Folder layout** decides where full-size originals are filed inside your library folder. See [Library folders](./guides/library-folders.md) for examples. Pick a preset:

- **Species** (the default): `Birds/American Robin/`.
- **Order, then family**: `Birds/Passeriformes/Turdidae/American Robin/`, so related species sit together.
- **Year, then species**: `Wildlife 2025/Birds/American Robin/`. Photos with no date go under `Wildlife Undated`.
- **Date (like Lightroom)**: `2025/2025-06-14/`.
- **Trip**: `Trips/Alaska 2025/Birds/American Robin/`. Photos that aren't in a trip are filed as in **Species**.
- **Location**: `Canada/Alberta/Pigeon Lake/Birds/American Robin/`. The country and province or state come from the photo's region; the place name is the one you type at import, not GPS.

Or pick **Custom** and build your own: tick the levels you want (year, month, date, trip, country, province, place name, group, order, family, species) and use the arrows to set their order. A level a photo has no value for, like a trip or place name it doesn't have, is left out for that photo. The RAW, Adjusted and Video folders always come last. Under the menu, Lifer shows where one of your recent photos would go.

The layout applies to new imports. With country, province or place folders in the layout, changing a photo's region or place name, or renaming a place in **Places**, moves that photo's files too. To move everything else you already have, click **Reorganize** in **Reorganize existing photos**. Moving files affects other apps that catalogue the same files, like Lightroom: they'll need to find the files again.

### Import a library {#reimport}

The **Import a library** panel brings in photos already on disk. Use it for a library organized some other way, another Lifer library, or after a fresh install or a server move.

- **Folder** is any folder, like a Lightroom export or a folder of dated dumps. Type the path or click **Choose…**. Lifer matches each photo to a species from the tags in the file (scientific name, common name, or an older name from before a rename) and from file and folder names. When the folder is another Lifer library, the panel says so, and its seen species, targets, card covers, trips and albums come back with the photos.
- **Move photos into my library** is off by default, so photos stay where they are. To move them in later, import the same folder again with it on.
- Click **Import**.

**Rescan this library** reads your own library and adds any photos Lifer is missing, without changing your files. Use it after a fresh install, or to repair links after a drive was reconnected under a different name. With connected drives, pick **Main library** or one drive first.

Photos Lifer can't match to one species stay where they are. After the run, **Unmatched photos** lists them: click **Review**. When a photo's tags or folder name a species, Lifer looks it up on iNaturalist and suggests it, so a folder named "Fuzzy-horned Bumble Bee" suggests that bee. Click **Import** to confirm, or **Import all** for every photo with the same suggestion. Species missing from your regions are added as hand-added species. **Ignore** keeps a photo out of future imports.

Imports read the picks and rejects a culling app left in your photos. **Rejected photos** chooses what happens to rejected ones: **Import them hidden** (the default) brings them in hidden, so photos you imported before aren't lost but stay out of the way (find them with the Gallery's **Hidden** filter); **Skip them** leaves them out; and **Import them anyway** ignores the mark. Skipped photos stay on disk untouched, and the results say how many were skipped or hidden. See [Culling with other apps](./guides/culling-with-other-apps.md). Tags you gave photos in Lifer come back too, for photos whose files Lifer wrote them into. So does a date you set on a photo that had none.

On a server you can only pick folders inside the library folder or an extra [library folder](#library-folders). A running import can be stopped with **Cancel**; files already in progress still finish. If recovered species are missing reference photos, the results link to the regions that would restore them.

## Storage {#storage}

### Library folder {#storage-location}

In the **Where photos live** panel. Shows where your photo library lives.

- **Desktop app:** click **Move**, pick the new folder and confirm **Move and restart**. Lifer moves every file, updates its records and restarts itself on the new folder.
- **Server:** read only. It shows the folder inside the container. To move the library, change `LIFER_STORAGE_DIR` and redeploy. See [Install with Docker](./install/docker.md#volumes).

### External drives {#external-drives}

Desktop app with its own library only, in the **Where photos live** panel. Register a drive that holds part of your library. Lifer keeps a thumbnail of every photo, so you can still browse when the drive is unplugged and see which drive to go find.

1. Click **Add a drive** and pick the folder on the drive.
2. Type a name, for example "Red 2TB drive".
3. Click **Add drive**. If the drive already has photos Lifer knew about, it says how many it recognized.

Each drive has its own row showing **Connected** or **Not connected** (with when it was last seen). You can **Rename**, **Make default** or **Remove** a drive. Removing only stops tracking it; imported photos stay in your library.

### Extra library folders {#library-folders}

Server only, including the desktop app while it's connected to a server. Extra folders on the server that Lifer can import from, build trips from, and save photos to. They are set with `LIFER_LIBRARY_ROOTS`, so this row is read only and shows each folder as **Connected** or **Not found**. With none set up, it shows the steps to add one. See [Extra library folders](./install/docker.md#extra-library-folders).

### Archive health {#archive-health}

**Check archive health** is on by default, on the desktop app and on a server. In the background Lifer reads every photo file about once every 90 days and compares it with how it was last time, to catch files that silently went bad. It reads slowly (about 50 MB a second) and waits while you import, so it never gets in your way. Quitting part way loses nothing: it carries on from where it stopped.

The row says how long ago the last check finished ("Last checked 3 days ago") and that all files were OK, or how far along a check is. Files on a drive that isn't plugged in are counted as not checked and wait for the drive.

When something is wrong, a second row, **N files have problems**, opens a list of them:

- **Contents changed**: the file's bytes changed but it wasn't edited (its modification date is the same). This is usually damage on the disk. Restore it from a backup if you have one.
- **Can't be read**: the disk refused to read it.
- **Missing**: the file is gone but the folder it was in is still there. Files a trip scan couldn't find are listed here too.

Editing a photo, in Lightroom or in Lifer, is never flagged. Each file in the list has **Reveal in Finder** (or **Copy original's path**) and **Ignore**. Ignore on a changed file accepts its contents as they are now; on a missing or unreadable one it hides it until the file is back, and then it clears itself. **Ignore all**, at the top of the list, does the same for every file on it, including any past the first 2,000 shown, after a confirmation that says how many.

When Lifer runs from a server whose library folder is also mounted on your Mac (a NAS share under /Volumes), **Reveal in Finder** opens the file there. The Mac finds the share by looking for a sample file the server names, so it only ever looks for the server's own library folders. Mounting or moving the share is picked up when you come back to Lifer's window, or when a reveal misses, with no reload needed.

### Remove all Lifer data {#remove-all-data}

Desktop app with its own library only, in the **Uninstall** panel. Deletes everything Lifer keeps on this computer, then quits. Your photos stay where they are. See [Uninstalling](./install/desktop.md#uninstalling).

## Server {#server}

Desktop app only. What you see depends on whether the app is using its own library or a server. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md) for step by step instructions.

### Sign in to a server {#sign-in-to-a-server}

Shown while using the app's own library. Enter the server address and click **Connect**, then your **Email** and **Password** and click **Sign in**. **Use a different address** goes back a step. A plain `http://` address on a public network gets a warning, since your password would travel unencrypted.

### Sync {#sync}

Shown on both sides once this library is linked to a server, that is, once you've signed in to one from this app. The **Linked server** row says why anything is still waiting and what the last copy of the server's collection did. **Photos** and **Albums and trips** each say how many changes are waiting to go up (or **Up to date**) and what the last send did. **Sync now** runs a send and a copy straight away; otherwise they run when the app connects and every half hour. If the server looks new (for example it was reinstalled), a row asks before anything is sent. See [If the server was reinstalled](./install/connect-desktop-to-server.md#reinstalled). **Keep medium previews too** keeps a 1,024 px copy of each of the server's photos on this computer as well as the thumbnail, for a better-looking grid when the server can't be reached, at about ten times the space. See [Connect the desktop app to a server](./install/connect-desktop-to-server.md#mirror).

### Linked devices {#linked-devices}

Shown on a server. Lists each desktop app linked to it with when it was linked and last synced. **Revoke** stops that computer syncing; its photos stay on it, and signing in again links it once more.

### Delete local files {#delete-local-files}

Shown while using the app's own library. Frees this computer's space once everything here is on the linked server. Refused while any photo here hasn't been sent yet, or the last send stopped with an error. It can't be undone.

### Server connection {#connect-a-server}

Shown in the **Connection** panel while connected to a server. The **Server** row shows which server you're using. **Use local library** goes back to the app's own library, the one you used last, without asking for a folder. Signing out of the server does the same, and so does **Use This Computer's Library** in the Lifer menu. Lifer remembers the server, so you can connect again from **Sign in to a server**.

### Automatic URL Switching {#url-switching}

Shown while connected to a server. Lets the app use a fast local address on your home Wi-Fi and other addresses everywhere else. Click **Set up**, then:

- Under **Home network**, enter the server's local address and your Wi-Fi network name. **Use current connection** fills both in for you.
- Under **Other addresses**, **Add** one or more addresses. Lifer tests each one and marks it with a tick or a cross. Away from your Wi-Fi it uses the first one that answers, top to bottom. Drag to reorder.
- In **Save addresses**, click **Save**. It needs a home address and at least one other.

### When the server is offline {#server-offline}

If the desktop app can't reach your server when it opens, or loses it for about a minute while you're using it, it says **Server disconnected** and switches to the library on this computer, so you can keep working. The first time, that library is set up and its species catalog loaded, which takes a minute or two.

When the server answers again, Lifer offers:

- What you added or changed on this computer is sent to the server in the background either way; **Settings > Server > Sync** shows the progress.
- **Switch to Server** goes straight back to the server.
- **Not Now** stays on this computer. Push later from **Settings > Server**.

The app stays set to your server: next time it opens, it connects to the server if it can.

## Integrations {#integrations}

- **iNaturalist account:** click **Connect** to link your iNaturalist account, so you can [send photos as observations](./guides/inaturalist.md#observations). The row then shows the account it's linked to and a **Disconnect** button.

## Species downloads {#regions}

Opened from the top of **Species and import**, with **Download more countries and animal groups**. This is where you download, update and remove regions: pick countries on the map or by name, choose animal groups, and click **Download selected**. Your downloaded regions are listed below the picker. See [Downloaded regions and the map](./guides/offline-packs-and-map.md).

### Offline map {#offline-map}

In the **Other downloads** panel. The offline basemap (about 640 MB) draws the maps showing roughly where a species is found within a region. Maps don't show without it, even online. Everything else works the same either way. It downloads by itself on a new install, in the background. **Remove** frees the space and keeps it off; **Download** brings it back.

### Download missing reference photos {#withheld-photos}

In the **Other downloads** panel. Some photos can't be included in region downloads for licensing reasons: their photographer kept all rights, or chose a license Lifer can't share. With this switch on (the default), Lifer downloads the main photo of those species from iNaturalist for your own viewing, so the species in your downloaded regions have a photo offline too. It's the same as opening the species online, with the photographer's credit and license kept with the photo.

It runs quietly after a region download and each time Lifer starts, one species every few seconds and at most 2,000 a day, so it goes easy on iNaturalist. If iNaturalist asks it to slow down, it waits an hour. A species it couldn't get a photo for is tried again after 30 days. Only the main photo is fetched, not the extra gallery photos. The setting covers the whole install, every account on it, and turning it off stops a fetch that's running.

## Offline data {#offline-data}

### Species catalog {#species-catalog}

In the **Species data** panel. Refreshes rarity, occurrence stats and endemic labels from the latest published data. It never touches reference photos you've downloaded. Lifer checks when you open the tab; **Check again** checks by hand. If a newer catalog exists, the row shows its download size. Click **Update**. A running update can be cancelled.

### Species recognition {#species-model}

In the **Species data** panel. Powers species suggestions while importing and searching the Gallery by what's in a photo (like "water bird", or scenes and colors such as "sky", "fence" or "purple"). Without it, Lifer is smaller and Gallery search matches species names, ABA and eBird codes and camera details only.

- The models download by themselves on a new install, in the background, so suggestions work from your first import. **Download** gets them if they were removed: the general model, the species identification model (BioCLIP 2) and the scene model, which finds scenes and colors for Gallery search. That's about 680 MB.
- If only part is installed, the row says what's missing (the identification model, about 370 MB, or the scene model, about 61 MB), and **Download** gets it.
- The row says which model suggestions currently use.
- **Recognition speed** says whether species recognition runs on the CPU or a GPU. **Test again** checks for a GPU again. See [GPU acceleration](./install/hardware-acceleration.md).
- **Remove** frees the space, turns species suggestions off, and makes Gallery search fall back to names, codes and camera details. Removed models stay removed, so this is the way to opt out of them; **Download** brings them back any time.

If a download fails, see [Model download failures](./troubleshooting.md#model-download).

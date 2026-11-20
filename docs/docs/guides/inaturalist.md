---
title: iNaturalist
description: Add insects, plants, fungi and other species from iNaturalist, one at a time or as a pasted list, and send your sightings to iNaturalist as observations.
---

# iNaturalist

Lifer uses iNaturalist to add species outside its own checklists, and can send your sightings to iNaturalist as observations under your own account.

## Add insects, plants, fungi and more {#any-taxa}

Lifer has its own checklists for birds, mammals, fish, reptiles, turtles, amphibians and many marine invertebrates (see [what the checklists cover](./collection-and-checklists.md#groups)). For anything else, like insects, spiders, plants or fungi, you can add species from iNaturalist, either one at a time or a whole list at once. You don't need an iNaturalist account.

### Turn it on

1. Open **Settings > Species and import**.
2. In the **Identification** panel, turn on **Search iNaturalist for other species**.
3. In **Add a species from iNaturalist**, click **Search**. The **Search iNaturalist** window opens.

With the setting on, you can also open this window from [quick search](./gallery-and-search.md#quick-search): type a species Lifer doesn't have and choose **Search iNaturalist**.

The window has two tabs: **One species** and **Import a list**.

### Add one species

1. On **One species**, type a scientific or common name.
2. Click the right result. Each shows its photo, names and group.
3. Under **Which region should this appear under?**, pick a country, or a province or state inside one. World and the continents have no checklist of their own.
4. Leave **Mark as seen** ticked to count it as seen, or untick it to only add it to the list.
5. Click **Add species** (or press <kbd>Enter</kbd>). Lifer opens the new species' page.

### Import a list {#import-list}

Use this to add many species in one go, like every bee in your state, or a target list someone shared with you.

1. On **Import a list**, paste one entry per line. Each entry can be:
   - a scientific name (works best), like `Bombus impatiens`,
   - a common name, like `Monarch`, or
   - an iNaturalist taxon ID, like `48662`.
2. Under **Which region should these appear under?**, pick a country, or a province or state.
3. Click **Start import** (or press <kbd>Enter</kbd>).

There's no file upload, but a list from a spreadsheet or CSV works fine: copy the column of names and paste it into the box. Blank lines and repeated names are skipped.

The import runs in the background, one name at a time, with a progress bar. Click **Cancel** to stop it partway. The species added so far stay added. When it's done, Lifer reports how many were **added**, were **already on the list**, and were **not found**, and lists the names it couldn't find so you can fix and paste them again.

For each name, Lifer takes iNaturalist's top species match. Common names can be ambiguous, so use scientific names or taxon IDs when it matters. Only one list import can run at a time.

### Where they show up

The species appear on that region's Collection page, marked **Added by you**, and on the checklists of the regions that contain it (a species added to a province also shows on its country). They're your own [checklist additions](./collection-and-checklists.md#add-to-checklist): other people on the same server don't see them unless they add them too, and catalog updates and offline packs never remove them. Use the **Taxon** filter to show just one group, like **Insects** or **Plants**. Each has a photo and description from iNaturalist, but no rarity tiers or occurrence data. Its page shows IUCN status where iNaturalist has one.

Import photos of them as usual.

To add a species to another region, open its page, click **Add to another checklist**, pick the region and click **Add to** it. See [Adding a species to a checklist](./collection-and-checklists.md#add-to-checklist). To remove one you haven't photographed, use **Remove species** on its card's **⋯** menu or its page. This takes it off all your checklists, along with your seen, target and archive marks for it. On a server, anyone else who added it keeps it, and the species is deleted only once nobody has it any more.

## Sending observations to iNaturalist {#observations}

Link your iNaturalist account, then pick photos of one sighting and send them as an observation under your own account.

### Link your account {#link-account}

1. Open **Settings > Integrations**.
2. Next to **iNaturalist account**, click **Connect**. iNaturalist opens in your browser.
3. Sign in to iNaturalist if asked, and click **Authorize**.
4. iNaturalist sends you back to Lifer, which says which account it linked. Close that tab and return to Lifer. Until then, Settings says to finish signing in on iNaturalist.

This works the same on the desktop app and on a server. On a server, open Lifer at an `https` address, or at a local network address like `http://192.168.1.20:30080`: for your safety, sign-in won't send you back to a public address over plain `http`.

To unlink, click **Disconnect** in the same place. If the sign-in page says the link isn't valid or has expired, go back to Lifer and click **Connect** again.

### Find photos that aren't on iNaturalist {#find-unsent}

Once an account is linked, an **iNaturalist** item appears in the sidebar (the top bar on the web app). In the Gallery, open **Filters** and tick **Not on iNaturalist** to see only the photos you haven't sent.

### The iNaturalist page {#page}

Open **iNaturalist** in the sidebar. The page shows which account is linked (click the name to open your iNaturalist profile) and has three tabs, each with a count:

- **To send:** sightings in your library that aren't on iNaturalist yet.
- **To finish:** observations sent without a location or date, waiting for you to add it on iNaturalist.
- **Completed:** observations on iNaturalist with everything they need.

The page opens on **To finish** when something is waiting there, and on **To send** otherwise.

### Find, sort and group {#toolbar}

Each tab has the same toolbar as the Collection page:

- **Search** finds species by name, and places.
- **Select** turns on select mode, like the Gallery's: each card shows a tick and a click selects it. Then **Select** has **Select every sighting** (or observation, or species) and **Select none**, and **Done** leaves select mode. Cmd-click or Shift-click a card also starts selecting.
- **View** sets **Group** (**No grouping**, the default, lists every sighting or observation; **Species** shows one card per species), **Sort** (newest, oldest, common name, and **Most first** when grouped) and the card size. Lifer remembers your choices.
- **Filters** narrows the list, and shows how many filters are on. **Clear all** turns them off.
  - **To send:** **Location** and **Date** (has one, or needs one), **Species on iNaturalist** (matched, or not matched yet, which can't be sent), **Show** (waiting, ignored, or both), and **Group of life**.
  - **To finish:** **Needs** (a location or a date) and **Group of life**.
  - **Completed:** where the **Location** and **Date** came from (the photo, or iNaturalist), **Added by** (sent by Lifer, or found on iNaturalist), and **Group of life**.

Grouped by species, each species card shows a few of its photos, how many sightings or observations it has and their photos, their date range, and what still needs doing (such as **3 need a location**). Filters apply to the sightings or observations, so each species card counts only the ones that match.

- **Select species** like any card in select mode: click, Shift-click for a range, or Cmd-click (Ctrl-click on Windows and Linux). A selected species stands for all its sightings or observations, and the bar counts both, for example **2 species, 41 observations selected**. **Send**, **Ignore**, **Restore** and **Check now** then act on all of them.
- **Open a species:** click it (outside select mode), press <kbd>Enter</kbd>, or choose **Open** from its menu. Its **Preview** button (the magnifying glass) and <kbd>Space</kbd> show its pictures instead, one from each sighting or observation first. Its sightings or observations show, with the same cards, actions and window. Go back with **All species** at the top, <kbd>Esc</kbd>, or your browser's or mouse's Back.

### Send photos {#send}

- **One photo:** open its **⋯** menu and choose **Send to iNaturalist**. A photo already there shows **View on iNaturalist** instead.
- **Several photos:** select them, then choose **Send to iNaturalist** from **More** in the selection bar. Lifer groups them into one observation per species and session (photos of one species within an hour of each other), skips photos already sent, and sends in the background. A toast shows progress, with **Cancel**. Ignored photos you pick here are sent too, and leave **Ignored**.
- **From the iNaturalist page:** the **To send** tab shows every unsent sighting as a card, grouped the same way, with a few of its photos, the species, the photo count and the date.

On the **To send** tab:

- **Select:** click **Select**, then click cards to select them and click again to deselect. Shift-click selects a range, and Cmd-click (Ctrl-click on Windows and Linux) adds or removes one card. **Select every sighting** in the **Select** menu or <kbd>Cmd</kbd>+<kbd>A</kbd> (<kbd>Ctrl</kbd>+<kbd>A</kbd>) selects every card the search and filters leave.
- **Deselect:** while anything is selected, the bar at the top says how many and has **Clear selection**. You can also choose **Select none**, press <kbd>Esc</kbd> (a second <kbd>Esc</kbd> leaves select mode) or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>), or click the empty space between or around the cards. A search or filter that hides a selected card deselects it, switching tabs clears the selection, and so does sending or ignoring.
- **Preview the pictures:** outside select mode, click a card, or click its **Preview** button (the magnifying glass), or press <kbd>Space</kbd> on it, as in the Gallery. The photos open full size; the arrow keys step through them and <kbd>Esc</kbd> closes the view.
- **Choose photos:** press <kbd>Enter</kbd> on a card, double-click it in select mode, or choose **Choose photos** from its menu, to open the sighting's window with all its photos and its **Send** and **Ignore** buttons.
- **Card menu:** right-click a card, or click its **⋯** button, for **Choose photos**, **Preview**, **Select**, **Set place**, **Send to iNaturalist** and **Ignore sighting** (**Restore** for an ignored one).
- **Send:** **Send N sightings** sends each selected sighting as one observation. With nothing selected, **Send all** sends every listed sighting after asking once. Sending runs in the background.
- **Pick photos:** in the sighting window, click a photo to leave it out, and click it again to put it back. Photos that will be sent have a tick and an outline; photos left out are greyed and marked **Left out**. **Send N photos** sends exactly the photos that are in, as one observation.

Each card says what its photos don't record: **No date yet** means you'll add it on iNaturalist afterwards. **Can't be sent yet** means the species has no iNaturalist match. **Already on iNaturalist** means one of its photos looks the same as an observation you made there yourself: check it under **Maybe on iNaturalist** (see [Photos already on iNaturalist](#existing)).

### Send with a place {#place}

A sighting with no location shows **Set place** instead of a missing note. Choose one of your named places (see [Named places](./photo-map.md#places)) and the photos are filed under it, with **Undo** in the toast. Photos with their own GPS keep it; if some were taken far from the place, Lifer asks first.

- **One sighting:** **Set place** on its card or in its menu, or pick a place in its window.
- **Many:** select them, then **Set place and send**: choose the place, then **Send**. **Set place** alone files them without sending.
- **From the Gallery:** sending photos without a location asks for a place first. **Send without a location** sends them as they are.
- **A place you've been before:** when the photos were taken at one of your places, Lifer offers it: "This looks like King Fisher Pond." **Use it** files them there. It's never applied without you.

A place found online, or **New place from the map**, is saved as one of your places first, with its name and town filled in.

The send takes the place's centre, its size as the location's accuracy, and its privacy. A card whose place is obscured or private says **Will be sent obscured** or **Will be sent private**. An obscured or private place sends only its town, never your name for it. iNaturalist also hides threatened species' locations by itself.

### Ignore photos {#ignore}

Some photos you don't want on iNaturalist, at least for now. Ignore them so they stop showing up on **To send**:

- a whole sighting: **Ignore sighting** in its window,
- some of its photos: leave them out in its window, then **Ignore N left-out photos**,
- many sightings: select them, then **Ignore N sightings**.

Each ignore shows a toast with **Undo**. Ignored photos are never sent by **Send all**, and the Gallery's **Not on iNaturalist** filter leaves them out.

They're still there whenever you want them: on the **To send** tab, open **Filters** and set **Show** to **Ignored** (or **Waiting and ignored**). Ignored cards say **Ignored**. From there you can:

- **Send** them: select sightings and click **Send N sightings**, or preview one, pick its photos and click **Send N photos**. Sending takes them out of **Ignored**.
- **Restore** them without sending: select sightings and click **Restore N sightings**, or preview one and click **Restore**.

Sending an ignored photo on purpose from the Gallery (its **⋯** menu, or the selection bar) works too, and also takes it out of **Ignored**.

### How sending works

- **What's sent:** the photos, the species you filed them under, the date your camera recorded, and the place or region they're filed under as the place name. Coordinates are sent when the photo has GPS or a place you chose. Lifer never guesses a location or a date.
- **Photos with a location and a date:** the observation is complete as sent and goes straight to **Completed**.
- **Photos without GPS or a date:** the observation arrives without them and waits on **To finish**. When you send just one, Lifer opens it on iNaturalist so you can place it on iNaturalist's map. Until then it stays Casual there.
- **Species** suggestions from Lifer's matching are never sent on their own: the species on the observation is always the one you chose.

### Photos already on iNaturalist {#existing}

If you added some photos to iNaturalist yourself, outside Lifer, Lifer can find them so they don't show up in **To send** and are never sent twice.

- **When:** by itself, once in the background right after you link your account, then whenever the iNaturalist page is open and a check is due (Lifer asks every few minutes while the page is open and in view, and checks at most once a day). It runs quietly; you only see a note under the toolbar if it couldn't finish or couldn't compare pictures.
- **What's downloaded:** your own observations (species, date and time, place, photo sizes), then a small preview (1,024 pixels) of each observation photo that might match, so Lifer can compare the pictures. Each preview is read once and only its comparison data is kept. Nothing from your library is uploaded, and later checks only ask for what changed.
- **Linked photos** count as on iNaturalist everywhere: they leave **To send** and the Gallery's **Not on iNaturalist** filter, photo menus show **View on iNaturalist**, and the observation shows on **Completed** (or on **To finish**, when it has no location on iNaturalist yet). A toast says how many were linked. The **Added by** filter on **Completed** shows only these.
- **Location and date** follow the same rules as observations you send: a photo with no location takes the observation's, a photo with no date takes its day, and a location or date from your camera, or one you typed, is never replaced.
- **Deleted on iNaturalist:** a photo that was only linked because Lifer found it goes back to **To send**.
- **Unlink:** **Undo** on the toast after a link (yours, or the **Linked N photos** toast after a check), or **Unlink from iNaturalist** in the menu or window of an observation found there. The photos go back to **To send** exactly as they were before linking: a location or date the link added is removed again, also from the photo's files. One you changed since stays as you left it. An unlinked photo is offered again under **Maybe on iNaturalist**, but never linked by itself again. Unlink only exists for observations Lifer found, not ones it sent.

#### How Lifer decides {#existing-matching}

1. **A quick filter**, before any download: the observation must be the photo's species (or a subspecies of it), from the same day, allowing for a time zone mistake on the camera or on iNaturalist. A place far from the photo's GPS rules it out. The photo size and a close time are noted, but a cropped or edited upload can change them, so they never rule a photo out on their own.
2. **The pictures**, using the same species-matching model Lifer uses for suggestions. The observation's preview is compared with your whole photo, its subject crop, and overlapping tiles of it at two sizes. The tiles matter because an upload is often a crop: compared only as whole pictures, a crop can look more like a neighbouring frame of the same bird than like the photo it came from.
3. **Linked by itself** only when one photo clearly stands out: it looks the same, and no other photo comes close. Two frames of the same bird taken seconds apart look almost identical, so a burst is never linked by itself. Those go to **Maybe on iNaturalist** side by side, for you to pick.

Without the species-matching model (**Settings > Offline Data**), Lifer can't compare pictures. It then links nothing by itself and only offers photos taken within a couple of minutes of an observation.

#### Maybe on iNaturalist {#maybe}

On the **To send** tab, **Maybe on iNaturalist** (shown when there's something to check, with a count) lists possible matches as cards: the iNaturalist photo beside yours, how alike they look (**Looks the same** or **Probably the same**), and what else matched (species, time or day, size, place).

- **Link** links your photo to that observation. Its other suggestions go away. The toast has **Undo**.
- **Not a match** removes the suggestion, and Lifer never suggests that pair again. The toast has **Undo**, which brings the card back.
- **View on iNaturalist** opens the observation.

#### Before sending {#duplicates}

Before Lifer creates an observation, it asks iNaturalist for your observations of that species around those days. If your photos are clearly already there, Lifer links them instead of sending them again, and the toast says so. If they might be, it holds them back and says **This looks like it may already be on iNaturalist.**, with two choices:

- **Check Maybe on iNaturalist** opens the list of possible matches to compare.
- **Send anyway** sends them as a new observation. Only this button skips the check: **Send all** never does, and the next send of those photos is checked again.

On the **To send** tab the choice shows above the cards. Sends from the Gallery or a photo's menu show it in a toast.

### Finish on iNaturalist {#pending}

**To finish** and **Completed** use the same cards, toolbar and window as **To send**: photo previews, the species, the photo count and date, and the place when the photos have one. Click a card, **Preview** or <kbd>Space</kbd> to see its pictures full size, <kbd>Enter</kbd> or **Details** in its menu to open its window, and **Select** to pick several. An observation whose photos aren't on this computer, such as one found on iNaturalist, previews iNaturalist's own picture.

Each card on **To finish** says what it still needs (**Needs a location**, **Needs a date**, or both). The **Needs** filter shows only those missing a location or a date. To add it, choose **Open on iNaturalist** from the card's menu (right-click or **⋯**), or from its window.

You don't need to tell Lifer when you're done. Lifer checks with iNaturalist by itself: when the page opens, when you switch back to Lifer, and every so often while **To finish** is showing (less often while nothing changes). It asks about each observation at most every 30 seconds. **Check now** asks straight away: with nothing selected it checks them all, and with cards selected **Check N now** checks just those. It's also in each card's menu and window. Once iNaturalist has the location and date, the observation moves to **Completed** and a toast says so. One that isn't finished yet keeps a note saying what's missing.

For a photo with no location, or only a region such as British Columbia, Lifer takes the location you placed, marks it as placed on iNaturalist, fills in the region if the photo had none, and writes it into the photo's files like any other pin. A location from your camera, or one you typed or picked in Lifer, is never replaced.

For a photo with no date, Lifer takes the day you added on iNaturalist (the day only, like a date you type for a photo in Lifer) and writes it into the photo's files the same way. A date from your camera, or one you typed, is never replaced.

### Completed observations {#completed}

Each card on **Completed** shows its photo count, the day you saw it, and the place when the photos have one. Where its location and date came from (the photo, or iNaturalist) is in its window, and the **Location** and **Date** filters show only one source.

To open one on iNaturalist, choose **View on iNaturalist** from its menu or window, or select it and click **View on iNaturalist** in the bar. Nothing on Completed works in bulk, and nothing there can be deleted from Lifer.

### Placing photos without iNaturalist {#place-without}

Locations don't need iNaturalist. Add coordinates to any photo in Lifer (see [Adding coordinates](./gallery-and-search.md#coordinates)), and the photo shows on the Gallery map.

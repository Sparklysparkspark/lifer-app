---
title: Lifer for Lightroom Classic
description: A free Lightroom Classic plugin that tags photos with your Lifer species and sends photos to Lifer.
---

# Lifer for Lightroom Classic

The Lifer plugin for Lightroom Classic does two things:

- **Tag selection with a Lifer species** adds the species as a keyword to the photos you selected, plus "lifer", "target" and "needs a better photo" keywords where they apply.
- **Send selection to Lifer** makes full-size JPEG copies of the photos you selected, with your keywords and ratings, and Lifer adds them and works out the species. Your Lightroom photos aren't changed.

The plugin only talks to your own Lifer: the Lifer app on this computer, or your own server. It never contacts anything else, and it can only see your species list and add photos. It can't read your photos' files or change your Lifer library otherwise.

## Install

1. Download `Lifer-Lightroom-Classic-plugin.zip` from the [latest release](https://github.com/Sparklysparkspark/lifer-app/releases/latest) and unzip it. You get a folder called `lifer.lrplugin`.
2. In Lightroom Classic, choose **File > Plug-in Manager**, click **Add**, and pick the `lifer.lrplugin` folder.

Keep that folder where it is. Lightroom loads the plugin from it each time it starts.

## Connect

1. Open Lifer, then in Lightroom choose **Library > Plug-in Extras > Connect to Lifer**.
2. Leave the address as it is for the Lifer app on this computer, and click **Connect**.
3. Lifer shows a window asking if you want to allow the plugin. Check that the code matches the one in Lightroom, then choose **Allow**.

For your own Lifer server, type its address and, in the server's **Settings > Integrations > Connected apps**, choose **Pair an app** and type the code it shows.

Lightroom keeps the connection in your computer's password store. To disconnect, remove the plugin in Settings > Integrations > Connected apps in Lifer.

## Tag photos with a species

1. Select photos in Lightroom's Library.
2. Choose **Library > Plug-in Extras > Tag selection with a Lifer species**.
3. Type part of the scientific name, pick the species, and click **Tag**.

You can choose how the keywords are filed in **File > Plug-in Manager > Lifer**: in a **Species** list (Species > Ardea herodias), or flat (Ardea herodias). Keywords use the scientific name, which is also what Lifer writes into its own files, so Lifer matches the species again when the photos come back.

| Keyword | Added when |
|---|---|
| **lifer** | You haven't photographed the species yet |
| **target** | The species is one of your targets |
| **needs a better photo** | You've photographed the species, but your best photo is under 3 stars or unrated |

Tick **Give unrated photos Lifer's best star rating for this species** to also copy that rating onto selected photos that have none.

## Send photos to Lifer

Choose **Library > Plug-in Extras > Send selection to Lifer**. Lightroom prepares the copies and Lifer adds them in the background, so you can carry on working in both apps. This works with the Lifer app on this computer. For a server, use Lifer's own import page.

## Good to know

- Lightroom Classic has no way for a plugin to run after an import, so the plugin runs when you choose it from the menu.
- Common names aren't added: Lifer's connected-app access covers your own marks and photos, and a species' common name belongs to the catalog.

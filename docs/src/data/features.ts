import siteStats from "./siteStats.json";

// The landing page's copy. Say only what Lifer does today, and each fact once.

/** A region's checklist, then one real trip there in detail. Images are static/img/<image>.jpg;
 *  the beat marked `tree` shows the Tree of life instead. */
export interface Beat {
  kicker: string;
  title: string;
  text: string;
  image?: string;
  alt?: string;
  tree?: boolean;
}

export const trip = {
  title: "Belize",
  intro: "One country's checklist, then one trip there in detail: 310 photos from thirteen days in November 2026.",
};

export const beats: Beat[] = [
  {
    kicker: "The checklist",
    title: "79 of 2,791 species",
    text: `Every region's checklist fills in from your photos, with how rare each species still out there is. ${siteStats.species.toLocaleString("en-US")} species come ready, and any of the over ${siteStats.inatSpecies.toLocaleString("en-US")} observed on iNaturalist can join your lists, plants, fungi and insects included.`,
    image: "collection",
    alt: "Belize's checklist on the Collection page",
  },
  {
    kicker: "Before import",
    title: "Culled with Preen, right inside Lifer",
    text: "Preen is a culling app that plugs into Lifer: it opens as a page of its own, with its menus in the menu bar and shortcuts that never clash. It finds the sharp shots and the eyes, flags new lifers, and hands the keepers straight to import, leaving out what you rejected. Lifer stays free and complete without it.",
  },
  {
    kicker: "Naming them",
    title: "Your photo beside the species",
    text: "Lifer suggests the species in each photo, on your own computer. Check it against reference photos side by side, zoom both together, and confirm.",
    image: "identify",
    alt: "A toucan photo compared with a reference photo of Keel-billed Toucan, a 100% match",
  },
  {
    kicker: "Back home",
    title: "Sorted by species",
    text: "Import the card or point Lifer at the folder, on any drive. 310 photos became 78 species and 72 lifers, kept together as a trip.",
    image: "trip",
    alt: "The Belize 2026 trip: 78 species and 72 lifers",
  },
  {
    kicker: "Finding them again",
    title: "Search the way you'd describe it",
    text: "Type “bird in flight against blue sky” and Lifer finds them, on your own computer. Species, places, months, trips and tags work too.",
    image: "gallery",
    alt: "The Gallery searching for bird in flight against blue sky",
  },
  {
    kicker: "The map",
    title: "Where each one was",
    text: "Every photo on the map, even offline.",
    image: "map",
    alt: "The photo map, zoomed to Belize",
  },
  {
    kicker: "Sharing",
    title: "Sent to iNaturalist in one click",
    text: "Lifer groups the photos into sightings with the species, date and place filled in. Send one, or all 114.",
    image: "inaturalist",
    alt: "The iNaturalist page with sightings ready to send",
  },
  {
    kicker: "In your files",
    title: "Captions and keywords, your way",
    text: "Build titles, captions and keywords from species, place, trip, camera or lens, check them on a real photo, and Lifer writes them into the files Lightroom and Bridge read.",
    image: "metadata",
    alt: "Caption and keyword templates with a preview on a real photo",
  },
  {
    kicker: "The numbers",
    title: "How you shoot",
    text: "Every photo plotted by focal length, aperture, ISO or shutter speed. Click a dot to see the photos behind it.",
    image: "stats-scatter",
    alt: "A scatter plot of focal length against shutter speed",
  },
  {
    kicker: "The life list",
    title: "Explore your life list by taxonomy to see what species you want to target next",
    text: "Green is what's photographed. Hover a group for a photo, click to zoom in, and click the middle to step back out.",
    tree: true,
  },
];

export const details = [
  {
    title: "Your folders, your layout",
    text: "Imports are filed by the folder layout and file names you choose. Reorganize applies them to the photos already there.",
  },
  {
    title: "Across several drives",
    text: "Spread the library over drives and network shares. Lifer remembers which drive each photo is on, even when one is unplugged.",
  },
  { title: "Watched folders", text: "New photos in your folders are added where they are, once they finish copying." },
  {
    title: "Bring your history",
    text: "Lightroom Classic catalogues with ratings, keywords and collections, your eBird life list, and Immich photos.",
  },
  { title: "Photo versions", text: "The original, the RAW and your edits stay together as one photo." },
  {
    title: "Any group of life",
    text: "Add insects, spiders, plants or fungi from iNaturalist, one species or a whole group.",
  },
  { title: "Works offline", text: "Checklists, reference photos and maps stay on your computer." },
  { title: "Portfolio", text: "Export your best photos and life list as a website, without exact locations." },
  { title: "Your own server", text: "Run it on a NAS with Docker or TrueNAS, and share albums with a link." },
];

export const faq = [
  {
    q: "Does Lifer upload my photos anywhere?",
    a: "No. There's no Lifer cloud. Lifer only goes online to download regions, models, maps and updates, and to reach iNaturalist when you use it.",
  },
  {
    q: "Is this a sightings log?",
    a: "No. A species counts once you've attached your own photo of it. Species you've seen but not photographed can be marked as seen, or brought in from eBird.",
  },
  {
    q: "Which species are covered?",
    a: "Birds, mammals, fish, reptiles, amphibians and marine invertebrates come with full regional checklists. Any other species observed on iNaturalist can be added, from insects to plants and fungi.",
  },
  {
    q: "Should I use the desktop app or a server?",
    a: "The desktop app is simplest for one computer. A server suits photos on a NAS, several devices, or share links. You can move from one to the other later.",
  },
  {
    q: "Will Lifer rearrange my photo folders?",
    a: "Only if you ask. Imports are copied into species folders, and photos you link where they are stay put. The image itself is never changed.",
  },
  {
    q: "What if I stop using Lifer?",
    a: "Your photos are ordinary files in ordinary folders, with the species written into each one. Any photo app can read them.",
  },
];

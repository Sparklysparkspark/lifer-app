// The landing page's copy. Say only what Lifer does today, and each fact once.

export const steps = [
  {
    title: "Download your regions",
    text: "Pick the countries and seas you care about. Their checklists, reference photos and maps then work offline.",
  },
  {
    title: "Import a card or a folder",
    text: "Copy or move photos into your library, or leave them where they are. Network drives work too.",
  },
  {
    title: "Confirm the species",
    text: "Lifer suggests the species in each photo, on your own computer. You pick.",
  },
  {
    title: "Watch your list grow",
    text: "Your life list and every region's checklist fill in from your photos.",
  },
];

export interface TourStop {
  title: string;
  text: string;
  image: string;
  alt: string;
}

export const tour: TourStop[] = [
  {
    title: "Collection",
    text: "Every species of a country, province or ocean area, with what you've photographed, what you've only seen and what's left.",
    image: "collection",
    alt: "The Collection page, showing a region's checklist",
  },
  {
    title: "Species pages",
    text: "Your photos beside a reference photo, a description, where the species lives and when you found it.",
    image: "species-detail",
    alt: "A species page with photos and details",
  },
  {
    title: "Photo map",
    text: "Every photo on a quiet, shaded map that works offline. Drop photos on it to place them, and save the spots you visit often.",
    image: "map",
    alt: "The photo map",
  },
  {
    title: "Photo viewer",
    text: "Big and calm, with the time each photo was taken, camera details, ratings and Lightroom's keys.",
    image: "photo-viewer",
    alt: "A photo open in the viewer",
  },
  {
    title: "Stats",
    text: "Totals, highlights, and Photos over time split by animal group, month by month or year by year.",
    image: "stats",
    alt: "The Stats page with Photos over time",
  },
  {
    title: "Gallery, albums and trips",
    text: "Search by species, place, month or trip. Albums and trips keep shoots together, and smart albums fill themselves.",
    image: "gallery",
    alt: "The Gallery",
  },
];

export const details = [
  { title: "Photo versions", text: "The original, the RAW and your edits stay together as one photo." },
  { title: "HDR in the viewer", text: "Bright highlights on a screen that can show them. Turn it on in Settings." },
  {
    title: "Keywords for Lightroom and Bridge",
    text: "Species keywords, titles and captions go into your files, or XMP sidecars for RAW.",
  },
  { title: "Target a group", text: "Make every owl or warbler of a place a target in one go." },
  { title: "Lists from iNaturalist", text: "Add insects, spiders, plants or fungi, one species or a whole group." },
  { title: "Watched folders", text: "New photos in your library folders are picked up on their own." },
  { title: "Similar photos", text: "Compare a burst side by side, with Undo for every choice." },
  { title: "Share links", text: "On a server, share an album with a link, with or without downloads." },
  { title: "Portfolio", text: "Export your best photos and life list as a website, without exact locations." },
  { title: "Sensitive species", text: "Their locations are hidden by region whenever a photo leaves Lifer." },
  { title: "Archive health", text: "Find photo files that changed, can't be read or went missing." },
  {
    title: "Open in your editor",
    text: "Send a photo to Lightroom Classic, Photoshop, darktable or GIMP from its menu.",
  },
];

export const integrations = [
  { name: "iNaturalist", text: "Sign in to see your observations next to your photos." },
  { name: "eBird", text: "Import your eBird life list and checklists." },
  { name: "Lightroom Classic", text: "Bring in a catalogue's photos, ratings and keywords." },
  { name: "Immich", text: "Use your Immich photos as a source." },
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
    q: "Which animals are covered?",
    a: "Birds, mammals, fish, reptiles, amphibians and marine invertebrates come with full regional checklists. Anything else on iNaturalist can be added.",
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

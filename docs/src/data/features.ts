export interface Feature {
  title: string;
  text: string;
  image: string;
  alt: string;
}

export const features: Feature[] = [
  {
    title: "Your photos, sorted by species",
    text: "Point Lifer at your photo folders and it finds the species in each picture. You confirm what it suggests, and your files stay where they are.",
    image: "/img/import.jpg",
    alt: "Lifer importing a folder of wildlife photos",
  },
  {
    title: "A life list built from your own photos",
    text: "Seen and photographed are kept apart, so you can tell which species you still need a photo of. Regional checklists fill in as you go.",
    image: "/img/collection.jpg",
    alt: "The Collection page, showing a region's checklist",
  },
  {
    title: "Search the whole archive",
    text: "Look up a species, a place, a month or a trip, and find the photo you are thinking of.",
    image: "/img/gallery.jpg",
    alt: "The Gallery with a search",
  },
  {
    title: "Species pages and offline maps",
    text: "Each species has a page with your photos, where it lives and when you saw it. Download a region once and the maps and checklists work without internet.",
    image: "/img/species-detail.jpg",
    alt: "A species page with photos and details",
  },
  {
    title: "Stats and your year in wildlife",
    text: "See your totals, your best months and how your list has grown over the years.",
    image: "/img/stats.jpg",
    alt: "The Stats page",
  },
];

export const integrations = [
  { name: "iNaturalist", text: "Sign in to see your observations next to your photos." },
  { name: "eBird", text: "Import your eBird life list and checklists." },
  { name: "Lightroom Classic", text: "Bring in photos you already organised there." },
  { name: "Immich", text: "Use your Immich photos as a source." },
];

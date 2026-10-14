import { Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";

interface Step {
  title: string;
  body: React.ReactNode;
}

function PageLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} state={{ backLabel: "Getting started" }} className="font-medium text-ink underline">
      {children}
    </Link>
  );
}

const STEPS: Step[] = [
  {
    title: "Download your regions",
    body: (
      <>
        Before anything else, go to <PageLink to="/offline-packs">Settings → Offline packs</PageLink> and download the
        region(s) you'll actually be shooting in. A region only shows real reference photos and habitat info once its
        pack is downloaded.
      </>
    ),
  },
  {
    title: "Upload a species",
    body: (
      <>
        Browse to a region (or search directly), pick a species, and hit <strong>Upload</strong> on its page. Or go to
        the <PageLink to="/import">Import</PageLink> page and bulk import a bunch of photos at once.
        <br />
        <br />A species only counts as "collected" once you've attached a real photo of your own. You can also mark a
        species as "seen" in case you didn't manage to get a photo. Photos will be automatically sorted into labelled
        folders in the directory of your choosing.
      </>
    ),
  },
  {
    title: "Bulk import",
    body: (
      <>
        One species at a time is fine for a handful of photos, but for a whole session's worth, use{" "}
        <PageLink to="/import">Import</PageLink>. Drop in a batch of photos, assign a species to each one, and upload
        them all together. That way you don't need to navigate to each species page one by one.
      </>
    ),
  },
  {
    title: "Match RAW files",
    body: (
      <>
        On a species page's upload panel, use <strong>"Choose RAW files"</strong> or point{" "}
        <strong>"Choose a folder"</strong> at your whole SD card. Lifer automatically matches RAW files to uploaded
        JPEGs using filename and capture time. A RAW that doesn't match anything already uploaded is simply left alone
        on your card rather than guessed at. You can also add RAWs you haven't edited yet but want to save.
      </>
    ),
  },
  {
    title: "Import a trip",
    body: (
      <>
        Trips references an existing folder you have in place. It never copies or moves your photos. The{" "}
        <PageLink to="/trips">Trips</PageLink> page lets you point Lifer at an entire trip folder, and re-scanning the
        same trip later picks up any new photos, and their matching RAWs, automatically. On a server install, the folder
        has to be inside the library folder or a folder the admin declared with LIFER_LIBRARY_ROOTS.
        <br />
        <br />
        For this feature you'll want to organize the files into "Adjusted" and "RAW" folders so that the app knows where
        to look.
      </>
    ),
  },
  {
    title: "Browse & organize",
    body: (
      <>
        The <PageLink to="/gallery">Gallery</PageLink> shows every photo you've taken across every species, searchable
        by species name, camera details (try "600mm"), or a natural-language description of what's in the shot ("fox
        playing", "bird eating"). Group your favorites into a named <PageLink to="/albums">Album</PageLink>. On a server
        install, an album can also be turned into a public link to share, with an optional password and expiration.{" "}
        <PageLink to="/stats">Stats</PageLink> breaks down your collection by gear, species, and year.
      </>
    ),
  },
];

export default function GuidePage() {
  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title="Getting started" backFallbackTo="/settings" backLabel="Settings" />
      <main className="mx-auto max-w-3xl space-y-section p-page">
        <section className="space-y-item">
          <h2 className="text-lg font-semibold text-ink">Recommended usage flow</h2>
          <ol className="divide-y divide-line rounded-panel border border-line bg-surface">
            {STEPS.map((step, index) => (
              <li key={step.title} className="p-panel">
                <h3 className="text-sm font-semibold text-ink">
                  <span className="mr-2 text-accent">{index + 1}.</span>
                  {step.title}
                </h3>
                <p className="mt-1 text-sm text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-ink">Your library structure</h2>
          <div className="rounded-panel border border-line bg-surface p-panel text-sm text-muted">
            <p>
              Every original photo you upload goes straight into your library's <strong>Storage location</strong>,
              grouped by taxon (Birds/Mammals/Fish/Other) then species, so your library stays usable outside Lifer too:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-surface-muted p-2 text-xs text-ink">
              {"Birds/<species name>/Adjusted/<your edited JPEG>\nBirds/<species name>/RAW/<matching RAW file>"}
            </pre>
            <p className="mt-2">
              Turning on <PageLink to="/settings/library">"Organize by year"</PageLink> nests that same structure one
              level deeper, under <code className="text-xs">Wildlife &lt;year taken&gt;/</code>, using each photo's own
              capture year, not the year you uploaded it.
            </p>
            <p className="mt-2">
              A library spread across several drives can register each one in{" "}
              <PageLink to="/settings/storage">Settings → Storage</PageLink>, and Lifer remembers which drive each photo
              is on. Most people never need this.
            </p>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-ink">F.A.Q.</h2>
          <div className="divide-y divide-line rounded-panel border border-line bg-surface">
            <FaqItem question="What's the difference between uploading on a species page, Import, and Trips?">
              All three end up with the same organized folder structure, they're just different starting points. A
              species page's upload is for a photo (or a few) of one specific species. Import is for a big batch where
              you'll assign species one by one afterward. Trips is for a whole folder from an outing that references
              files in place rather than copying them in.
            </FaqItem>
            <FaqItem question="Do I need to register an external drive?">
              No. Only register one if your library is actually split across more than one physical drive. If everything
              fits on your computer's own storage location, there's nothing to set up.
            </FaqItem>
            <FaqItem question="What happens if I open a region I haven't downloaded a pack for?">
              You can still search for a species by name, but its detail page will prompt you to download that region's
              pack before showing reference photos or habitat info. That reference data is bundled into the pack itself
              rather than fetched on demand, so it only shows up once the pack is downloaded from{" "}
              <PageLink to="/offline-packs">Settings → Offline packs</PageLink>.
            </FaqItem>
            <FaqItem question="What do the rarity tiers (common, occasional, uncommon, rare, legendary) mean?">
              A tier is how hard a species is to find and photograph in that place:
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <span className="font-medium text-ink">Common:</span> an everyday species, seen anywhere, anytime
                  (House Sparrows, Mallards, crows).
                </li>
                <li>
                  <span className="font-medium text-ink">Occasional:</span> findable with a little effort in the right
                  habitat (an Osprey over a lake, a Great Blue Heron in a marsh).
                </li>
                <li>
                  <span className="font-medium text-ink">Uncommon:</span> needs a dedicated search; it won't turn up on
                  a casual outing.
                </li>
                <li>
                  <span className="font-medium text-ink">Rare:</span> needs travel and patience; getting a shot is a
                  notable achievement.
                </li>
                <li>
                  <span className="font-medium text-ink">Legendary:</span> once in a lifetime; very local or extremely
                  elusive (a Wolverine, a vagrant far from home).
                </li>
              </ul>
              <br />
              Common is kept tight on purpose, to genuine everyday species, so each tier means something in the field
              instead of most species piling up at the easy end. The same species can be Common in one place and
              Occasional in the next: Great Blue Herons are on every Florida pond, but take a trip to the right marsh in
              most other states.
              <br />
              <br />
              A species card can show two tiers. The plain badge ("Rare") is the worldwide tier: how hard the species is
              where it's easiest to find. On a region's checklist a second badge ("Occasional here") is its tier in that
              region, and "Rarity here" in Group and Sort uses it. Lifer rates each species against the most-reported
              species of its group in each province or state: eBird and GBIF sightings for birds, iNaturalist photos for
              mammals, reptiles, amphibians and fish. A country's tier is its easiest well-surveyed province. Tap a tier
              badge to see the numbers behind it.
              <br />
              <br />A tier isn't how endangered a species is: an endangered wader can be on every mudflat, and a species
              of no conservation concern can be legendary if it lives in one hard-to-reach spot. The IUCN status is
              shown beside the tier instead. Where there are too few records or photos to tell, a species shows "Not
              enough data" instead of a guess. Marine invertebrates aren't rated yet.
            </FaqItem>
            <FaqItem question="Can I share photos with someone who doesn't use Lifer?">
              On a server/self-hosted install, yes: group photos into an <PageLink to="/albums">Album</PageLink> and
              share it as a public link, no account needed to view. You control whether the link requires a password,
              when it expires, and whether visitors can download the photos. Location data is never included in a shared
              link, even if you turn on the camera-info option. This isn't available in desktop mode, since a local
              install has no public address to hand out.
            </FaqItem>
            <FaqItem question="I archived a species by mistake, or don't want to see it anymore. What now?">
              Archiving only hides a species from your checklist and counts, it never deletes anything. Find it again
              any time from <PageLink to="/archived">Settings → Archived species</PageLink> and unarchive it.
            </FaqItem>
            <FaqItem question="Can I add species for a group Lifer doesn't have a dataset for (insects, plants, fungi, and the like)?">
              Yes, turn on "Enable any-taxa search" under{" "}
              <PageLink to="/settings/species">Settings → Species &amp; Import</PageLink>. After that, jumping to a
              species from the header search box will offer a "Search iNaturalist" option whenever there's no local
              match, searching by scientific name works best, then you pick which region it belongs to. It shows up
              under its own group (Insects, Fungi, Plants, and so on) on your Collection page, without rarity tiers or
              occurrence data, since Lifer has no real dataset behind those groups yet.
            </FaqItem>
          </div>
        </section>
      </main>
    </div>
  );
}

function FaqItem({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <details className="group p-4">
      <summary className="cursor-pointer list-none text-sm font-medium text-ink marker:content-none">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
        {question}
      </summary>
      <p className="mt-2 pl-4 text-sm text-muted">{children}</p>
    </details>
  );
}

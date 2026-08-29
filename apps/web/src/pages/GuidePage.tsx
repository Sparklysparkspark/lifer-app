import { Link } from "react-router-dom";
import BackToCollectionLink from "../components/BackToCollectionLink";

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
    title: "1. Download the region(s) you care about",
    body: (
      <>
        Before anything else, go to <PageLink to="/offline-packs">Settings → Offline packs</PageLink> and
        download the region(s) you'll actually be shooting in. A region only shows real reference photos
        and habitat info once its pack is downloaded.
      </>
    ),
  },
  {
    title: "2. Adding photos",
    body: (
      <>
        Browse to a region (or search directly), pick a species, and hit <strong>Upload</strong> on its
        page. Or go to the <PageLink to="/import">Import</PageLink> page and bulk import a bunch of photos
        at once.
        <br />
        <br />
        A species only counts as "collected" once you've attached a real photo of your own. You can also
        mark a species as "seen" in case you didn't manage to get a photo. Photos will be automatically
        sorted into labelled folders in the directory of your choosing.
      </>
    ),
  },
  {
    title: "3. Bulk import",
    body: (
      <>
        One species at a time is fine for a handful of photos, but for a whole session's worth, use{" "}
        <PageLink to="/import">Import</PageLink>. Drop in a batch of photos, assign a species to each one,
        and upload them all together. That way you don't need to navigate to each species page one by one.
      </>
    ),
  },
  {
    title: "4. Bring in RAW files",
    body: (
      <>
        On a species page's upload panel, use <strong>"Choose RAW files…"</strong> or point{" "}
        <strong>"Choose a folder…"</strong> at your whole SD card. Lifer matches each RAW to the right
        JPEG by filename and camera timestamp automatically. A RAW that doesn't match anything already
        uploaded is simply left alone on your card rather than guessed at. You can also add RAWs you
        haven't edited yet but want to save.
      </>
    ),
  },
  {
    title: "5. Importing a whole trip",
    body: (
      <>
        Instead of uploading species by species, the <PageLink to="/trips">Trips</PageLink> page lets you
        point Lifer at an entire trip folder. Files stay exactly where they already are on disk (nothing
        gets copied or moved), and re-scanning the same trip later picks up any new photos, and their
        matching RAWs, automatically.
        <br />
        <br />
        For this feature you'll want to organize the files into "Adjusted" and "RAW" folders so that the
        app knows where to look.
      </>
    ),
  },
];

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header border-b border-line bg-surface px-6 py-4">
        <BackToCollectionLink fallbackTo="/settings" label="Settings" className="text-sm text-muted hover:underline" />
        <h1 className="mt-1 text-xl font-semibold text-ink">Getting started</h1>
      </header>
      <main className="mx-auto max-w-2xl space-y-8 p-6">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-ink">Recommended usage flow</h2>
          {STEPS.map((step) => (
            <section key={step.title} className="rounded-lg border border-line bg-surface p-4">
              <h3 className="text-sm font-medium text-ink">{step.title}</h3>
              <p className="mt-1 text-sm text-muted">{step.body}</p>
            </section>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-ink">How your files are stored</h2>
          <div className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
            <p>
              Every original photo you upload goes under a <strong>Lifer Photos</strong> folder inside your
              library's <strong>Storage location</strong>, so your library stays usable outside Lifer too:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-surface-muted p-2 text-xs text-ink">
              {"Lifer Photos/<species name>/Adjusted/<your edited JPEG>\nLifer Photos/<species name>/RAW/<matching RAW file>"}
            </pre>
            <p className="mt-2">
              Turning on <PageLink to="/settings">"Organize by year"</PageLink> nests that same structure
              one level deeper, under <code className="text-xs">Wildlife &lt;year taken&gt;/Birds|Mammals|Fish/</code>,
              using each photo's own capture year, not the year you uploaded it.
            </p>
            <p className="mt-2">
              Thumbnails and the smaller "display" copy shown while browsing are separate, regenerable
              cache files kept in the app's own private data folder, they're never part of your library
              folder, and never something you need to manage by hand.
            </p>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-ink">Using multiple drives (optional)</h2>
          <div className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
            <p>
              This is <strong>not</strong> a normal part of getting started, most people just use one
              storage location and never touch this. It exists for photographers whose library has already
              outgrown a single disk, spread across a few external hard drives instead of one spot.
            </p>
            <p className="mt-2">
              Register a drive from <PageLink to="/settings">Settings → External drives</PageLink>. From
              then on, when you upload a photo Lifer will offer that drive as a destination (alongside your
              main storage location), and remembers which drive each photo actually lives on. Unplug that
              drive later, and its photos still show a thumbnail with a note on which drive to go
              reconnect, instead of just breaking. When you're ready to consolidate onto one drive or a
              NAS, <PageLink to="/settings">Settings → Reimport library</PageLink> can move everything over
              in one step.
            </p>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-ink">F.A.Q.</h2>
          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            <FaqItem question="What's the difference between uploading on a species page, Import, and Trips?">
              All three end up with the same organized folder structure, they're just different starting
              points. A species page's upload is for a photo (or a few) of one specific species. Import is
              for a big batch where you'll assign species one by one afterward. Trips is for a whole folder
              from an outing that references files in place rather than copying them in.
            </FaqItem>
            <FaqItem question="Do I need to register an external drive?">
              No. Only register one if your library is actually split across more than one physical drive.
              If everything fits on your computer's own storage location, there's nothing to set up.
            </FaqItem>
            <FaqItem question="What happens if I open a region I haven't downloaded a pack for?">
              You can still search for a species by name, but its detail page will prompt you to download
              that region's pack before showing reference photos or habitat info. Lifer never fetches from
              iNaturalist or GBIF directly on your device, all of that data is compiled ahead of time into
              the packs you download from <PageLink to="/offline-packs">Settings → Offline packs</PageLink>.
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

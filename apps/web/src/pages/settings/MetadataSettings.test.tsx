// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
const start = vi.fn();
const cancel = vi.fn();
let jobStatus: unknown = null;
vi.mock("../../hooks/useJobPoll", () => ({
  useJobPoll: () => ({ status: jobStatus, start, cancel, starting: false, cancelling: false, actionError: null }),
}));

const { default: MetadataSettings, FileNameRow } = await import("./MetadataSettings");
const { ConfirmContext } = await import("../../hooks/useConfirm");

const template = { creator: "", copyright: "", credit: "", usageTerms: "", caption: "", replaceExisting: false };
const example = {
  values: { species: "Osprey", place: "Pigeon Lake", year: "2026", original: "IMG_4411" },
  fileName: "IMG_4411.jpg",
  sample: false,
};

function serve(over: object = {}) {
  get.mockImplementation((path: string) =>
    Promise.resolve(
      path.startsWith("/settings/template-example")
        ? { ...example, fileName: path.includes("species") ? "2026-05-03_Osprey_0001.jpg" : "IMG_4411.jpg" }
        : {
            template: { ...template, ...over },
            fileNameTemplate: "{original}",
            sensitiveSpecies: { enabled: true },
          },
    ),
  );
}

const confirmFn = vi.fn();
function renderIt(ui: React.ReactNode) {
  render(
    <ConfirmContext.Provider value={confirmFn}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ConfirmContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  jobStatus = null;
  confirmFn.mockResolvedValue(true);
  serve();
  serveTemplates();
  put.mockImplementation((path: string, body: { template?: string }) =>
    Promise.resolve(
      path === "/settings/file-name-template"
        ? { fileNameTemplate: body.template }
        : path === "/settings/metadata-fields"
          ? { fields: body }
          : { template: body },
    ),
  );
});
afterEach(cleanup);

const fields = {
  title: { template: "{names}", rule: "replace" },
  headline: { template: "", rule: "replace" },
  caption: { template: "", rule: "replace" },
  keywords: { template: "", rule: "replace" },
  multiSpecies: "all",
};
const variables = ["species", "scientific", "place", "longdate", "names", "count", "focal", "aperture"];

function serveTemplates(applyCounts = { updated: 12, edited: 3 }) {
  const base = get.getMockImplementation()!;
  get.mockImplementation((path: string) => {
    if (path === "/settings/metadata-fields")
      return Promise.resolve({
        fields,
        variables,
        captionPresets: { place: "{species}, {place}", imageOf: "An image of a {species}[[ taken on {longdate}]]" },
      });
    if (path.startsWith("/settings/metadata-preview"))
      return Promise.resolve({
        sample: false,
        captureId: "c1",
        values: { names: "Osprey", species: "Osprey", longdate: "3 May 2026", original: "IMG_4411" },
        fields: {},
      });
    if (path.startsWith("/gallery")) return Promise.resolve({ items: [{ captureId: "c1" }, { captureId: "c2" }] });
    return base(path);
  });
  post.mockResolvedValue(applyCounts);
}

describe("MetadataSettings", () => {
  it("previews every field on a real photo, rendered from the unsaved draft", async () => {
    renderIt(<MetadataSettings />);
    expect(
      await screen.findByText("Using IMG_4411. Changes show here before you save.", {}, { timeout: 5000 }),
    ).toBeTruthy();
    // The default title is today's behaviour: every species name.
    expect(screen.getByText("Osprey")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /A photo of a species/ }));
    expect(screen.getByText("An image of an Osprey taken on 3 May 2026")).toBeTruthy();
    // Unsaved: saving is offered, applying waits.
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains each write rule and saves the field templates", async () => {
    renderIt(<MetadataSettings />);
    const rule = await screen.findByRole("combobox", { name: "When writing Headline" });
    fireEvent.change(rule, { target: { value: "off" } });
    expect(screen.getByText("Leaves this field alone.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/settings/metadata-fields", {
        ...fields,
        headline: { template: "", rule: "off" },
      }),
    );
  });

  it("won't save a token Lifer can't fill", async () => {
    renderIt(<MetadataSettings />);
    const boxes = await screen.findAllByRole("textbox", { name: "Headline" });
    fireEvent.change(boxes[0], { target: { value: "{photographer}" } });
    expect(screen.getByRole("alert").textContent).toContain("{photographer}");
    expect((screen.getAllByRole("button", { name: "Save" })[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches to the main species only and asks the preview for it", async () => {
    renderIt(<MetadataSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "Name every species in a photo" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/settings/metadata-preview?multiSpecies=main"));
  });

  it("tries another photo for the preview", async () => {
    renderIt(<MetadataSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Try another photo" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/settings/metadata-preview?captureId=c2&multiSpecies=all"));
  });

  it("shows the dry-run count before applying to all photos, then runs the job", async () => {
    renderIt(<MetadataSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("/settings/metadata-template/apply?background=1"));
    expect(post).toHaveBeenCalledWith("/settings/metadata-template/apply?dryRun=1");
    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Updates 12 photos, keeps 3 you edited elsewhere") }),
    );
  });

  it("says so, and doesn't start a job, when nothing would change", async () => {
    serveTemplates({ updated: 0, edited: 0 });
    renderIt(<MetadataSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(await screen.findByText("Every photo is already up to date.")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it("previews the credits, inserts variables at the cursor, and won't save an unknown one", async () => {
    renderIt(<MetadataSettings />);
    const copyright = await screen.findByLabelText("Copyright notice");
    expect(await screen.findByText("Preview on IMG_4411:")).toBeTruthy();
    fireEvent.change(copyright, { target: { value: "(c) " } });
    fireEvent.focus(copyright);
    fireEvent.click(screen.getByRole("button", { name: "Insert place" }));
    expect((copyright as HTMLInputElement).value).toBe("(c) {place}");
    expect(screen.getByText("(c) Pigeon Lake")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Creator"), { target: { value: "{photographer}" } });
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("{photographer}"))).toBe(true);
    expect((screen.getAllByRole("button", { name: "Save" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the credits, and the Replace switch at once, keeping the saved caption", async () => {
    serveTemplates();
    get.mockImplementation(
      ((orig) => (path: string) =>
        path === "/settings/metadata"
          ? Promise.resolve({
              template: { ...template, caption: "{species}" },
              fileNameTemplate: "{original}",
              sensitiveSpecies: { enabled: true },
            })
          : orig(path))(get.getMockImplementation()!),
    );
    renderIt(<MetadataSettings />);
    fireEvent.change(await screen.findByLabelText("Creator"), { target: { value: "Judah" } });
    fireEvent.click(screen.getByRole("switch", { name: "Replace existing creator and copyright" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/settings/metadata-template", {
        ...template,
        caption: "{species}",
        replaceExisting: true,
      }),
    );
  });

  it("shows the apply job's progress with a way to stop it", async () => {
    jobStatus = { running: true, phase: "writing", processed: 40, total: 1200, finishedAt: null, error: null };
    renderIt(<MetadataSettings />);
    await screen.findByLabelText("Creator");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click((await screen.findAllByRole("button", { name: /Stop|Cancel/ }))[0]);
    expect(cancel).toHaveBeenCalledWith("/settings/metadata-template/apply/cancel");
  });
});

describe("FileNameRow", () => {
  it("saves a preset at once and shows the example name", async () => {
    renderIt(<FileNameRow />);
    const select = await screen.findByRole("combobox", { name: "Name new photos" });
    fireEvent.change(select, { target: { value: "dateSpecies" } });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/settings/file-name-template", { template: "{date}_{species}_{seq}" }),
    );
    expect(await screen.findByText("2026-05-03_Osprey_0001.jpg")).toBeTruthy();
  });

  it("edits a custom template, saving on Enter", async () => {
    renderIt(<FileNameRow />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Name new photos" }), {
      target: { value: "custom" },
    });
    const field = screen.getByRole("textbox", { name: "File name template" });
    fireEvent.change(field, { target: { value: "{species}-{seq}" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/settings/file-name-template", { template: "{species}-{seq}" }),
    );
  });
});

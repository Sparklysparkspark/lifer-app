// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const put = vi.fn();
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) },
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

function renderIt(ui: React.ReactNode) {
  render(
    <ConfirmContext.Provider value={vi.fn().mockResolvedValue(true)}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ConfirmContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  jobStatus = null;
  serve();
  put.mockImplementation((path: string, body: { template?: string }) =>
    Promise.resolve(path === "/settings/file-name-template" ? { fileNameTemplate: body.template } : { template: body }),
  );
});
afterEach(cleanup);

describe("MetadataSettings", () => {
  it("previews each field on a real photo as it's typed, and inserts variables at the cursor", async () => {
    renderIt(<MetadataSettings />);
    const caption = await screen.findByLabelText("Caption");
    expect(await screen.findByText("Preview on IMG_4411:")).toBeTruthy();
    fireEvent.change(caption, { target: { value: "At " } });
    fireEvent.focus(caption);
    fireEvent.click(screen.getByRole("button", { name: "Insert place" }));
    expect((caption as HTMLTextAreaElement).value).toBe("At {place}");
    expect(screen.getByText("At Pigeon Lake")).toBeTruthy();
  });

  it("won't save a variable Lifer can't fill", async () => {
    renderIt(<MetadataSettings />);
    fireEvent.change(await screen.findByLabelText("Creator"), { target: { value: "{photographer}" } });
    expect(screen.getByRole("alert").textContent).toContain("{photographer}");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the text, and the Replace switch at once without the unsaved text", async () => {
    renderIt(<MetadataSettings />);
    fireEvent.change(await screen.findByLabelText("Creator"), { target: { value: "Judah" } });
    fireEvent.click(screen.getByRole("switch", { name: "Replace existing creator and copyright" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/settings/metadata-template", { ...template, replaceExisting: true }),
    );
    // Applying needs the text saved first.
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(put).toHaveBeenLastCalledWith("/settings/metadata-template", {
        ...template,
        creator: "Judah",
        replaceExisting: true,
      }),
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("/settings/metadata-template/apply?background=1"));
  });

  it("shows the apply job's progress with a way to stop it", async () => {
    jobStatus = { running: true, phase: "writing", processed: 40, total: 1200, finishedAt: null, error: null };
    serve({ creator: "Judah" });
    renderIt(<MetadataSettings />);
    await screen.findByLabelText("Creator");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Stop|Cancel/ }));
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

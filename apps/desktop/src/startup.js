// The startup page's status line (index.html). pg_upgrade.rs calls this through
// window.eval while it upgrades the embedded database, before the library opens.
window.__liferStartupStatus = (title, detail) => {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("startup-title", title);
  set("startup-detail", detail);
  const note = document.getElementById("startup-note");
  if (note) note.hidden = false;
};

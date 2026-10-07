// The cached collection, read-only, while the connected server can't be reached. The data comes
// from offline_cache.rs; nothing here talks to the network. lib.rs's watcher switches the window
// back to the server as soon as it answers.
(function () {
  const { invoke } = window.__TAURI__.core;
  const PAGE_SIZE = 240;

  if (window.__LIFER_PLATFORM__ === "darwin") {
    document.documentElement.setAttribute("data-mac-app", "");
  }

  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const more = $("more");
  const empty = $("empty");
  const count = $("count");
  const search = $("search");
  let items = [];
  let filter = "all";
  let shown = 0;
  let matches = [];

  const stateLabel = { collected: "Collected", seen: "Seen", unseen: "Not seen" };

  // Thumbnails load as cards scroll into view, one IPC call each.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        observer.unobserve(img);
        invoke("offline_cache_thumb", { speciesId: img.dataset.speciesId })
          .then((src) => {
            if (src) img.src = src;
          })
          .catch(() => {});
      }
    },
    { rootMargin: "400px" },
  );

  function formatSynced(ms) {
    const date = new Date(ms);
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function card(item) {
    const el = document.createElement("div");
    el.className = "card";
    const img = document.createElement("img");
    img.className = "thumb";
    img.alt = "";
    if (item.thumbKey) {
      img.dataset.speciesId = item.speciesId;
      observer.observe(img);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.commonName || item.scientificName;
    name.title = name.textContent;
    const sci = document.createElement("div");
    sci.className = "sci";
    sci.textContent = item.commonName ? item.scientificName : "";
    const state = document.createElement("div");
    state.className = "state " + item.state;
    state.textContent = stateLabel[item.state] || stateLabel.unseen;
    meta.append(name, sci, state);
    el.append(img, meta);
    return el;
  }

  function normalize(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function render() {
    const q = normalize(search.value.trim());
    matches = items.filter(
      (i) =>
        (filter === "all" || i.state === filter) &&
        (!q || normalize(i.commonName).includes(q) || normalize(i.scientificName).includes(q)),
    );
    grid.replaceChildren();
    shown = 0;
    showMore();
    const collected = items.filter((i) => i.state === "collected").length;
    const seen = items.filter((i) => i.state === "seen").length;
    count.textContent = `${matches.length} shown. ${collected} collected, ${seen} seen of ${items.length}.`;
    empty.hidden = matches.length > 0;
    empty.textContent = items.length ? "No species match." : "";
  }

  function showMore() {
    const next = matches.slice(shown, shown + PAGE_SIZE);
    grid.append(...next.map(card));
    shown += next.length;
    more.hidden = shown >= matches.length;
  }

  more.addEventListener("click", showMore);
  search.addEventListener("input", render);
  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      for (const b of document.querySelectorAll("[data-filter]")) {
        b.setAttribute("aria-pressed", String(b === button));
      }
      render();
    });
  }

  $("retry").addEventListener("click", async () => {
    const button = $("retry");
    button.disabled = true;
    $("retry-status").textContent = "Checking your server…";
    try {
      const back = await invoke("offline_retry");
      $("retry-status").textContent = back ? "Reconnecting…" : "Still can't reach your server.";
    } catch (e) {
      $("retry-status").textContent = String(e);
    } finally {
      button.disabled = false;
    }
  });

  $("use-local").addEventListener("click", async () => {
    $("use-local").disabled = true;
    try {
      await invoke("offline_use_local_library");
    } catch (e) {
      $("retry-status").textContent = String(e);
      $("use-local").disabled = false;
    }
  });

  invoke("offline_cache_snapshot")
    .then((snapshot) => {
      if (!snapshot) {
        $("headline").textContent = "Offline: no synced collection on this computer";
        $("detail").textContent =
          "Lifer can't reach your server, and there's no offline copy of your collection here. It will reconnect when the server is back.";
        empty.hidden = false;
        empty.textContent = "Nothing cached.";
        return;
      }
      $("headline").textContent = `Offline: showing your last synced collection (${formatSynced(snapshot.syncedAt)})`;
      $("detail").textContent =
        `Read-only copy from ${snapshot.server}. Changes are turned off until the server is back, and Lifer switches back to it automatically.`;
      items = snapshot.items;
      render();
    })
    .catch((e) => {
      $("headline").textContent = "Offline";
      $("detail").textContent = String(e);
    });
})();

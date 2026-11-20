// Mirrors ThemeProvider: a saved light or dark wins, anything else follows the OS.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("lifer-theme");
  } catch (e) {
    // Storage blocked: follow the OS.
  }
  var dark = stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
})();

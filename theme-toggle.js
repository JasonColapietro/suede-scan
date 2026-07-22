// Click handling for the light/dark toggle button. The no-flash sync (read
// localStorage, set data-theme on <html> before first paint) is a separate
// inline script in each page's <head> since it must run synchronously
// before this deferred file loads - see the inline script next to
// <link rel="stylesheet" href="/styles.css"> in index.html / method.html /
// privacy.html.
(function () {
  var STORAGE_KEY = "suede-audit-theme";

  function toggle() {
    var root = document.documentElement;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch (e) {
      // localStorage unavailable (private browsing); theme still applies for this session.
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) btn.addEventListener("click", toggle);
  });
})();

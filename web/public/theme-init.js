// Apply saved colors before the stylesheet and application load (CSP: self).
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("pi-loop-observer-theme");
    if (["dark", "light", "system"].includes(saved)) preference = saved;
  } catch {}
  document.documentElement.dataset.theme =
    preference === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
})();

const api = globalThis.browser ?? globalThis.chrome;
const toggle = document.getElementById("toggle");
const ads = document.getElementById("ads");

api.storage.local.get({ enabled: true, hideAds: true }).then((v) => {
  toggle.checked = v.enabled !== false;
  ads.checked = v.hideAds !== false;
});

// The content script watches storage, so open tabs update immediately.
toggle.addEventListener("change", () => {
  api.storage.local.set({ enabled: toggle.checked });
});

ads.addEventListener("change", () => {
  api.storage.local.set({ hideAds: ads.checked });
});

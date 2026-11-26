const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

// Checkbox id -> storage key, with its default.
const SWITCHES = {
  toggle: ["enabled", true],
  ads: ["hideAds", true],
  autoload: ["autoLoadComments", true],
  newtab: ["newTabPosts", false],
};
const keywords = $("keywords");

const defaults = { hideKeywords: "" };
for (const [key, def] of Object.values(SWITCHES)) defaults[key] = def;

api.storage.local.get(defaults).then((v) => {
  for (const [id, [key]] of Object.entries(SWITCHES)) $(id).checked = v[key] === true;
  keywords.value = v.hideKeywords || "";
});

// The content script watches storage, so open tabs update immediately.
for (const [id, [key]] of Object.entries(SWITCHES)) {
  $(id).addEventListener("change", () => api.storage.local.set({ [key]: $(id).checked }));
}

// Save shortly after typing stops, so tabs don't re-filter on every keystroke.
let timer;
keywords.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => api.storage.local.set({ hideKeywords: keywords.value }), 400);
});
keywords.addEventListener("change", () => {
  clearTimeout(timer);
  api.storage.local.set({ hideKeywords: keywords.value });
});

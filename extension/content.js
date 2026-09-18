/*
 * Reddit Unblock -- content script, runs at document_start.
 *
 * Reddit renames its classes constantly, so this deliberately does not depend
 * on one magic selector. Three passes run over every DOM mutation:
 *
 *   1. Name match   -- anything whose tag/id/class/bundlename smells like the
 *                      app promo.
 *   2. Shape match  -- a big fixed overlay whose text is asking you to open
 *                      the app. Catches renames the name match misses.
 *   3. Scroll unlock -- undo the inline overflow/position lock left behind.
 *
 * Offenders are hidden, not removed: Reddit's web components re-render nodes
 * that vanish, which turns removal into an endless fight with the framework.
 */

const api = globalThis.browser ?? globalThis.chrome;

const KILL_MARK = "data-ru-killed";
const OFF_ATTR = "data-reddit-unblock";
const ADS_OFF_ATTR = "data-ru-ads";

// Known offenders. Attribute-contains selectors survive most renames.
const PROMO_SELECTORS = [
  '[bundlename*="xpromo" i]',
  '[bundlename*="app_promo" i]',
  '[bundlename*="app_selector" i]',
  '[id*="xpromo" i]',
  '[class*="xpromo" i]',
  "shreddit-app-promo",
  "shreddit-experience-tree",
  "xpromo-app-selector",
  "xpromo-nsfw-blocking-container",
  // The mweb blocking modal, confirmed live:
  //   <configured-xpromo-modal data-faceplate-tracking-context='{"experience":
  //     {"name":"mweb3x_mid_funnel_blocking_v1_30s"}}' actioned>
  // The tag scan below also catches any <*-xpromo-*> sibling of it.
  "configured-xpromo-modal",
  '[data-faceplate-tracking-context*="mid_funnel_blocking" i]',
  '[data-faceplate-tracking-context*="xpromo" i]',
  // <-- add anything specific here; it will be picked up automatically.
];

// Promoted posts. Confirmed live in the feed: <shreddit-ad-post promoted>
// sits as a bare sibling of the <article> wrappers real posts use, and does
// not contain a <shreddit-post>, so hiding it collapses without a gap.
const AD_SELECTORS = [
  "shreddit-ad-post",
  "shreddit-sidebar-ad",
  "shreddit-comments-page-ad",
  "[promoted]",
  ".promotedlink",
  '[bundlename*="_ad" i]',
];

// Matches <shreddit-ad-post>, <shreddit-sidebar-ad> and future <*-ad-*> tags,
// without matching words that merely contain "ad" (header, thread, ...).
const AD_TAG = /(^|-)AD(-|$)/;

// The visible "Ad" flag, as a safety net if the custom element gets renamed.
const AD_LABEL = /^(ad|promoted|sponsored)$/i;

// Text that marks an overlay as an app nag rather than real UI.
const PROMO_TEXT = /(open|continue|keep reading|view|use)[\s\S]{0,32}\bapp\b|open reddit/i;
// Text that means "this is a dialog the user actually asked for" -- never touch.
const KEEP_TEXT = /(log ?in|sign ?up|create (a )?post|comment|report|share|settings)/i;

let enabled = true;
let hideAds = true;

/* ---------- helpers ---------- */

const isDead = (el) => el.hasAttribute?.(KILL_MARK);

function kill(el, reason) {
  if (!el || isDead(el) || el === document.body || el === document.documentElement) return;
  el.setAttribute(KILL_MARK, reason);
  el.style.setProperty("display", "none", "important");
}

// Collect open shadow roots so the scans reach inside web components.
function rootsUnder(root, acc = [root], depth = 0) {
  if (depth > 6) return acc;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      acc.push(el.shadowRoot);
      rootsUnder(el.shadowRoot, acc, depth + 1);
    }
  }
  return acc;
}

/* ---------- pass 1: name match ---------- */

function killBySelectors(root, selectors, reason) {
  for (const sel of selectors) {
    let found;
    try {
      found = root.querySelectorAll(sel);
    } catch {
      continue; // selector unsupported in this engine
    }
    for (const el of found) kill(el, reason);
  }
}

function killByName(root) {
  killBySelectors(root, PROMO_SELECTORS, "name");
  if (hideAds) killBySelectors(root, AD_SELECTORS, "ad");

  // Tag-name matches that CSS can't express as a wildcard. One walk covers
  // both cases -- a busy feed is thousands of nodes, so don't walk it twice.
  for (const el of root.querySelectorAll("*")) {
    if (isDead(el)) continue;
    if (el.tagName.includes("XPROMO")) kill(el, "tag");
    else if (hideAds && AD_TAG.test(el.tagName)) kill(el, "ad-tag");
  }

  if (hideAds) killByAdLabel(root);
}

// Fallback for an ad format that stops using a recognisable tag: find the
// literal "Ad" flag and hide the post unit around it. Deliberately narrow --
// feed only, leaf nodes only, and never a post's own title text.
function killByAdLabel(root) {
  let flags;
  try {
    flags = root.querySelectorAll("shreddit-feed span, shreddit-feed faceplate-screen-reader-content");
  } catch {
    return;
  }
  for (const el of flags) {
    if (el.children.length || !AD_LABEL.test((el.textContent || "").trim())) continue;
    if (el.closest("h1, h2, h3, a[slot='title'], a[slot='full-post-link']")) continue;
    const unit = el.closest("shreddit-ad-post, article");
    if (unit && !isDead(unit)) kill(unit, "ad-label");
  }
}

/* ---------- pass 2: shape match ---------- */

function killByShape(root) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!vw || !vh) return;

  for (const el of root.querySelectorAll("div, section, aside, dialog, [role='dialog']")) {
    if (isDead(el)) continue;

    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;

    const rect = el.getBoundingClientRect();
    const wide = rect.width >= vw * 0.6;
    const tall = rect.height >= vh * 0.25;
    if (!wide || !tall) continue;

    // Never hide something that contains the actual page content.
    if (el.querySelector("shreddit-app, #main-content, main, shreddit-feed")) continue;

    const text = (el.textContent || "").slice(0, 400);
    if (!PROMO_TEXT.test(text)) continue;
    if (KEEP_TEXT.test(text) && !/\bapp\b/i.test(text.slice(0, 80))) continue;

    kill(el, "shape");
  }
}

/* ---------- pass 3: scroll unlock ---------- */

// The stylesheet handles this with !important; this also strips the inline
// properties so Reddit's own code sees an unlocked page when it re-checks.
function unlockScroll() {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const s = el.style;
    if (s.overflow === "hidden" || s.overflowY === "hidden") {
      s.removeProperty("overflow");
      s.removeProperty("overflow-y");
    }
    if (s.position === "fixed") {
      s.removeProperty("position");
      s.removeProperty("top");
      s.removeProperty("width");
    }
  }
}

/* ---------- driver ---------- */

let queued = false;

function sweep() {
  if (!enabled) return;
  queued = false;
  try {
    for (const root of rootsUnder(document)) {
      killByName(root);
      killByShape(root);
    }
    unlockScroll();
  } catch (e) {
    console.warn("[reddit-unblock]", e);
  }
}

function scheduleSweep() {
  if (queued || !enabled) return;
  queued = true;
  requestAnimationFrame(sweep);
}

const observer = new MutationObserver(scheduleSweep);

// document_start can fire before <html> exists; don't assume documentElement.
function start() {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "bundlename"],
  });
  sweep();
}

if (document.documentElement) {
  start();
} else {
  document.addEventListener("readystatechange", start, { once: true });
}

// Reddit is a SPA: re-sweep after client-side navigation.
for (const method of ["pushState", "replaceState"]) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    scheduleSweep();
    return result;
  };
}
window.addEventListener("popstate", scheduleSweep);
document.addEventListener("DOMContentLoaded", scheduleSweep);
window.addEventListener("load", scheduleSweep);

// Interstitials often mount a beat after load; a few late passes are cheap.
for (const delay of [250, 750, 1500, 3000]) setTimeout(scheduleSweep, delay);

/* ---------- popup kill switch ---------- */

function reviveAds() {
  for (const el of document.querySelectorAll("[" + KILL_MARK + "^='ad']")) {
    el.removeAttribute(KILL_MARK);
    el.style.removeProperty("display");
  }
}

function applyHideAds(value) {
  hideAds = value !== false;
  if (hideAds) {
    document.documentElement.removeAttribute(ADS_OFF_ATTR);
    sweep();
  } else {
    document.documentElement.setAttribute(ADS_OFF_ATTR, "off");
    reviveAds();
  }
}

function applyEnabled(value) {
  enabled = value !== false;
  if (enabled) {
    document.documentElement.removeAttribute(OFF_ATTR);
    sweep();
  } else {
    document.documentElement.setAttribute(OFF_ATTR, "off");
  }
}

try {
  const read = api?.storage?.local?.get?.({ enabled: true, hideAds: true });
  if (read?.then)
    read.then((v) => {
      applyEnabled(v?.enabled);
      applyHideAds(v?.hideAds);
    }, () => {});

  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) applyEnabled(changes.enabled.newValue);
    if (changes.hideAds) applyHideAds(changes.hideAds.newValue);
  });
} catch (e) {
  console.warn("[reddit-unblock] storage unavailable", e);
}

/*
 * Reddit Unblock -- content script, runs at document_start.
 *
 * Reddit renames its classes constantly, so this deliberately does not depend
 * on one magic selector. Four passes run over every DOM mutation:
 *
 *   1. Name match   -- anything whose tag/id/class/bundlename smells like the
 *                      app promo.
 *   2. Shape match  -- a big fixed overlay whose text is asking you to open
 *                      the app. Catches renames the name match misses.
 *   3. Playback release -- drop the "pause all videos" flag a hidden wall
 *                      leaves behind.
 *   4. Scroll unlock -- undo the inline overflow/position lock left behind.
 *
 * It also puts back the comment tools mobile Reddit leaves out (sort,
 * search, more comments per page). See "comment tools" below.
 *
 * Offenders are hidden, not removed: Reddit's web components re-render nodes
 * that vanish, which turns removal into an endless fight with the framework.
 */

const api = globalThis.browser ?? globalThis.chrome;

const KILL_MARK = "data-ru-killed";
const OFF_ATTR = "data-reddit-unblock";
const ADS_OFF_ATTR = "data-ru-ads";

// Reddit's video playback policy, as defined in its bundle:
//   {attribute: "data-blocks-background-playback",
//    requestEvent: "shreddit-sync-playback-policy"}
// A blocking modal sets the attribute on its portal container (the bottom
// sheet, a sibling of <configured-xpromo-modal>) and fires the event. Every
// <shreddit-player> pauses, and stays paused, while any element in the
// document carries the attribute. Reddit clears it only when the modal runs its
// own hide(), which a CSS-hidden modal never does -- so without pass 3 a
// hidden wall still stops every video on the page.
const PLAYBACK_BLOCK_ATTR = "data-blocks-background-playback";
const PLAYBACK_POLICY_EVENT = "shreddit-sync-playback-policy";

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
let autoLoadComments = true;
let newTabPosts = false;
let keywordRe = null; // compiled from the popup's "hide posts containing" list
let keywordVersion = 0;

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

/* ---------- keyword filter ---------- */

// "taylor swift, crypto" -> one case-insensitive regex. Each phrase must
// stand on its own (no letter or digit touching either end), so "swift"
// hides "Taylor Swift" but not "swiftly". Inner whitespace matches any run of
// whitespace, so line breaks in a title don't defeat it.
function compileKeywords(raw) {
  const phrases = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!phrases.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const edge = /[\p{L}\p{N}]/u;
  const parts = phrases.map(
    (p) =>
      (edge.test(p[0]) ? "(?<![\\p{L}\\p{N}])" : "") +
      esc(p) +
      (edge.test(p[p.length - 1]) ? "(?![\\p{L}\\p{N}])" : ""),
  );
  return new RegExp(parts.join("|"), "iu");
}

// The post this page is about, if it is a post page: never hide that one.
const currentPostId = () => {
  const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
  return m ? "t3_" + m[1] : null;
};

// Each post is checked once per keyword list; the version bumps on change.
const keywordChecked = new WeakMap();

function killByKeyword() {
  if (!keywordRe) return;
  const self = currentPostId();
  for (const post of document.querySelectorAll("shreddit-post")) {
    if (keywordChecked.get(post) === keywordVersion) continue;
    keywordChecked.set(post, keywordVersion);
    if (post.id === self) continue;
    // Title, flair and the text preview: the parts of a card a person reads.
    // Not the whole card, whose button labels ("Share", "Join") would match.
    const text = [
      post.getAttribute("post-title") || "",
      ...[...post.querySelectorAll("shreddit-post-flair, [slot='text-body'], [slot='title']")].map(
        (e) => e.textContent,
      ),
    ].join(" \n ");
    if (keywordRe.test(text)) kill(post.closest("article") || post, "keyword");
  }

  // Search results aren't <shreddit-post>. Confirmed live: each result is
  // <search-telemetry-tracker data-testid="search-sdui-post"> followed by an
  // <hr> divider, with the title in a[data-testid="post-title-text"].
  // A search that itself names a filtered phrase is a deliberate request
  // for those posts, so the filter steps aside there.
  const query = new URLSearchParams(location.search).get("q");
  if (query && keywordRe.test(query)) return;
  for (const unit of document.querySelectorAll('search-telemetry-tracker[data-testid="search-sdui-post"]')) {
    if (keywordChecked.get(unit) === keywordVersion) continue;
    keywordChecked.set(unit, keywordVersion);
    const title = unit.querySelector('[data-testid="post-title-text"], [data-testid="post-title"]');
    if (!title || !keywordRe.test(title.textContent)) continue;
    kill(unit, "keyword");
    if (unit.nextElementSibling?.tagName === "HR") kill(unit.nextElementSibling, "keyword");
  }
}

function reviveKeywords() {
  for (const el of document.querySelectorAll("[" + KILL_MARK + "='keyword']")) {
    el.removeAttribute(KILL_MARK);
    el.style.removeProperty("display");
  }
}

/* ---------- open posts in a new tab ---------- */

// Optional. iOS Safari's swipe-back on a tab opened from a link closes it and
// returns to the opener, so the feed tab is never reloaded or re-scrolled.
// Runs in the capture phase on window, ahead of Reddit's own card handlers.
// Only plain taps on the card itself count: anything interactive inside it
// (votes, menus, share, media, links elsewhere) behaves normally.
const INTERACTIVE =
  "button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], " +
  "[role='checkbox'], [role='slider'], faceplate-dropdown-menu, shreddit-player, " +
  "shreddit-player-2, gallery-carousel, shreddit-post-overflow-menu, award-button, " +
  "shreddit-post-share-button, shreddit-join-button";

function onPostClick(e) {
  if (!enabled || !newTabPosts || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const path = e.composedPath();
  const post = path.find((n) => n.tagName === "SHREDDIT-POST");
  if (!post || post.id === currentPostId()) return;
  const permalink = post.getAttribute("permalink");
  if (!permalink) return;
  const target = new URL(permalink, location.origin);
  for (const n of path) {
    if (n === post) break;
    if (!(n instanceof Element)) continue;
    if (n.matches(INTERACTIVE)) return;
    // A link to somewhere other than this post (user, sub, outbound) is the
    // user's choice; leave it alone.
    if (n.tagName === "A" && n.href && new URL(n.href).pathname !== target.pathname) return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  window.open(target.href, "_blank");
}

window.addEventListener("click", onPostClick, true);

/* ---------- feed scroll restore ---------- */

// Tapping a post on mobile is a full page load, and Back reloads the feed
// whenever Safari's back-forward cache didn't keep the page. On that reload
// Reddit sets history.scrollRestoration = "manual", which turns off Safari's
// own restore, and then never restores the position itself, so Back usually
// lands at the top. (When the cache does keep the page, nothing reloads and
// none of this runs.)
//
// So: on leaving a feed, remember the post at the top of the screen and its
// offset; on returning via Back, bring that post back to the same spot. If
// it was further down than the first page, scroll to the bottom so Reddit's
// infinite scroll loads more, until it appears.

const SCROLL_KEY = "ru-feed-scroll:";
const RESTORE_FOR_MS = 12000; // give up on finding the post after this
// Tracking and bot-check parameters differ between visits to the same feed.
const NOISE_PARAM = /^(utm_|solution$|js_challenge$|jsc_|screen_view_count$|mweb_loid$)/;
const feedKey = () => {
  const params = new URLSearchParams(location.search);
  for (const k of [...params.keys()]) if (NOISE_PARAM.test(k)) params.delete(k);
  return SCROLL_KEY + location.pathname + (params.size ? "?" + params : "");
};
const feedPosts = () => [...document.querySelectorAll("shreddit-post")].filter((p) => p.id !== currentPostId());
// shreddit-post can be display:contents in feeds; the <article> has the box.
const cardOf = (post) => post.closest("article") || post;

function saveFeedPosition() {
  if (!enabled || currentPostId() || !document.querySelector("shreddit-feed")) return;
  const posts = feedPosts();
  let anchor = null;
  for (const p of posts) {
    const r = cardOf(p).getBoundingClientRect();
    if (r.height && r.bottom > 80) {
      anchor = { id: p.id, top: Math.round(r.top) };
      break;
    }
  }
  try {
    sessionStorage.setItem(
      feedKey(),
      JSON.stringify({ y: Math.round(scrollY), count: posts.length, anchor, at: Date.now() }),
    );
  } catch {}
}

function restoreFeedPosition() {
  const nav = performance.getEntriesByType?.("navigation")?.[0];
  if (!enabled || nav?.type !== "back_forward") return;
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(feedKey()));
  } catch {}
  if (!saved || Date.now() - saved.at > 60 * 60 * 1000 || saved.y < 100) return;

  // The moment the reader touches the screen, it's theirs again.
  let cancelled = false;
  const cancel = () => (cancelled = true);
  for (const type of ["touchstart", "wheel", "keydown"]) addEventListener(type, cancel, { once: true, passive: true });

  const deadline = Date.now() + RESTORE_FOR_MS;
  const align = (unit) => {
    const off = unit.getBoundingClientRect().top - saved.anchor.top;
    if (Math.abs(off) >= 1) scrollBy(0, off);
  };

  (function attempt() {
    if (cancelled) return;
    const post = saved.anchor && document.getElementById(saved.anchor.id);
    if (post) {
      const unit = cardOf(post);
      align(unit);
      // Media above it can still be loading and shift the page; re-align a
      // few times while that settles.
      for (const ms of [250, 700, 1500]) setTimeout(() => cancelled || align(unit), ms);
      return;
    }
    const count = feedPosts().length;
    if (!saved.anchor || count >= saved.count || Date.now() > deadline) {
      // The post is gone (the feed reordered) or never loaded: fall back to
      // the raw offset.
      scrollTo(0, saved.y);
      return;
    }
    // Not loaded yet: the bottom of the feed is where Reddit loads more.
    scrollTo(0, document.documentElement.scrollHeight);
    setTimeout(attempt, 500);
  })();
}

// Saved continuously rather than only on pagehide: when a post is tapped,
// Reddit has already switched the URL to the post's by the time pagehide
// fires, and the save has to be keyed to the feed.
let saveTimer = 0;
addEventListener(
  "scroll",
  () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFeedPosition, 150);
  },
  { passive: true },
);
addEventListener("click", saveFeedPosition, true); // before Reddit navigates
addEventListener("pagehide", saveFeedPosition);
document.addEventListener("DOMContentLoaded", () => setTimeout(restoreFeedPosition, 0));

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

/* ---------- pass 3: playback release ---------- */

// Only for walls we hid. A dialog the user opened themselves (login, share)
// should still pause the video behind it, so those keep the attribute.
// Light DOM only, because that is all Reddit's own check looks at.
function releasePlayback() {
  for (const el of document.querySelectorAll("[" + PLAYBACK_BLOCK_ATTR + "]")) {
    if (el.closest("[" + KILL_MARK + "]")) el.removeAttribute(PLAYBACK_BLOCK_ATTR);
  }
}

/* ---------- pass 4: scroll unlock ---------- */

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

/* ---------- comment tools ---------- */

// Mobile Reddit leaves out the comment sort dropdown and comment search that
// desktop has, and shows 4 top-level comments where desktop shows ~25. Its
// server never sends those controls, so there is nothing to unhide. But the
// backend still accepts everything desktop's controls send, so they are
// rebuilt on top of it:
//   sort      -> ?sort=confidence|top|new|controversial|old|qa
//   search    -> ?q=<text>&type=comments   (results are server-rendered)
//   load more -> click Reddit's own "View more comments" button as it nears
//                the viewport (6 more top-level comments per click)
// The bar is only added when the native controls are missing, so desktop
// layouts (the macOS build) are left alone.

const TOOLS_ID = "ru-comment-tools";
const SORTS = [
  ["confidence", "Best"],
  ["top", "Top"],
  ["new", "New"],
  ["controversial", "Controversial"],
  ["old", "Old"],
  ["qa", "Q&A"],
];
// How far below the viewport the "View more comments" button can be before
// it is clicked, so new comments arrive before the reader reaches the end.
const AUTOLOAD_MARGIN = 800;

// Confirmed live: <div id="comment-tree-content-anchor-<postId>"> wraps the
// comment tree, and search results replace the tree inside it.
const commentAnchor = () => document.querySelector('[id^="comment-tree-content-anchor-"]');
const hasNativeTools = () =>
  !!document.querySelector("shreddit-comments-sort-dropdown, pdp-comment-search-input");

function currentSort(params) {
  const valid = (v) => SORTS.some(([s]) => s === v);
  const fromUrl = (params.get("sort") || "").toLowerCase();
  if (valid(fromUrl)) return fromUrl;
  // No ?sort= means the post's default, which some subs set to New or Q&A.
  // Reddit's own "more replies" loaders request that default, so read it there.
  const loader = document.querySelector('faceplate-partial[src*="more-comments"][src*="sort="]');
  const m = loader && loader.getAttribute("src").match(/[?&]sort=([A-Z_]+)/i);
  const fromLoader = m ? m[1].toLowerCase() : "";
  return valid(fromLoader) ? fromLoader : "confidence";
}

function commentsUrl(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
}

function buildTools(key) {
  const params = new URLSearchParams(location.search);
  const query = params.get("q") || "";
  // Search runs against the post itself, even from a single-comment permalink.
  const postPath =
    (location.pathname.match(/^\/(?:r|u|user)\/[^/]+\/comments\/[^/]+/) || [location.pathname])[0] + "/";

  const bar = document.createElement("div");
  bar.id = TOOLS_ID;
  bar.dataset.key = key;

  const sort = document.createElement("label");
  sort.className = "ru-sort";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Sort comments");
  const active = currentSort(params);
  for (const [value, text] of SORTS) select.add(new Option(text, value, false, value === active));
  select.addEventListener("change", () =>
    location.assign(commentsUrl(location.pathname, { sort: select.value })),
  );
  sort.append(select);

  const form = document.createElement("form");
  form.className = "ru-search";
  form.setAttribute("role", "search");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search comments";
  input.value = query;
  input.setAttribute("enterkeyhint", "search");
  input.setAttribute("aria-label", "Search comments");
  form.append(input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    location.assign(q ? commentsUrl(postPath, { q, type: "comments" }) : commentsUrl(postPath, {}));
  });
  if (query) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => location.assign(commentsUrl(postPath, {})));
    form.append(clear);
  }

  bar.append(sort, form);
  return bar;
}

function ensureCommentTools() {
  const anchor = commentAnchor();
  const existing = document.getElementById(TOOLS_ID);
  if (!anchor || hasNativeTools()) {
    existing?.remove();
    return;
  }
  // Rebuild only when the post or query changes (SPA navigation), so a
  // mutation-driven sweep never wipes what the user is typing.
  const key = anchor.id + location.search;
  if (existing && existing.dataset.key === key && existing.nextElementSibling === anchor) return;
  existing?.remove();
  anchor.before(buildTools(key));
}

// Confirmed live: <shreddit-comment-tree> <section data-comment-section-anchor>
// ...comments... <button>View more comments</button>. The text match is
// only a fallback in case the structure changes.
function moreCommentsButton(tree) {
  const direct = tree.querySelector("section[data-comment-section-anchor] > button");
  if (direct) return direct;
  for (const b of tree.querySelectorAll("button")) {
    if (/view more comments/i.test(b.textContent)) return b;
  }
  return null;
}

// After the first batch Reddit keeps the button but collapses it to zero
// height, so its position says nothing. A click on it still loads the next
// batch, though. So the trigger is a marker placed right after the comment
// tree: when it comes within AUTOLOAD_MARGIN of the viewport, load more.
const END_ID = "ru-comments-end";
let watchedEnd = null;
const loadObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) autoLoadMore();
  },
  { rootMargin: "0px 0px " + AUTOLOAD_MARGIN + "px 0px" },
);

function commentsEnd(tree) {
  let end = document.getElementById(END_ID);
  if (!end) {
    end = document.createElement("div");
    end.id = END_ID;
    end.setAttribute("aria-hidden", "true");
  }
  if (end.previousElementSibling !== tree) tree.after(end);
  if (end !== watchedEnd) {
    if (watchedEnd) loadObserver.unobserve(watchedEnd);
    loadObserver.observe(end);
    watchedEnd = end;
  }
  return end;
}

const SETTLE_MS = 700; // quiet time that means a batch has finished landing
const RETRY_MS = 8000; // how long a click gets before it counts as a miss

let loadState = { btn: null, seen: -1, clicked: -1, at: 0, misses: 0 };
let loadTimer = 0;
const recheck = (ms) => {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(autoLoadMore, ms);
};

function autoLoadMore() {
  if (!enabled || !autoLoadComments) return;
  const tree = document.querySelector("shreddit-comment-tree");
  if (!tree) return;
  const end = commentsEnd(tree);
  const btn = moreCommentsButton(tree);
  if (!btn || btn.disabled) return;
  // Only while the end of the comments is near: not before the reader gets
  // close, and not once they've scrolled well past it into the related posts
  // below (loading then would shove what they're reading down the page).
  const endTop = end.getBoundingClientRect().top;
  if (endTop > innerHeight + AUTOLOAD_MARGIN || endTop < -innerHeight) return;
  if (btn !== loadState.btn) loadState = { btn, seen: -1, clicked: -1, at: 0, misses: 0 };

  // A batch arrives as a burst of insertions, and Reddit ignores a click
  // while one is still landing. So only click once the count has held still
  // for SETTLE_MS.
  const count = tree.querySelectorAll("shreddit-comment").length;
  if (count !== loadState.seen) {
    loadState.seen = count;
    return recheck(SETTLE_MS);
  }

  // A click that loaded nothing is retried twice, RETRY_MS apart, then this
  // button is left alone: there are no more comments to load.
  if (count === loadState.clicked) {
    if (loadState.misses >= 2) return;
    const wait = RETRY_MS - (Date.now() - loadState.at);
    if (wait > 0) return recheck(wait);
    loadState.misses++;
  } else {
    loadState.misses = 0;
  }
  loadState.clicked = count;
  loadState.at = Date.now();
  btn.click();
  recheck(RETRY_MS);
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
    releasePlayback();
    unlockScroll();
    killByKeyword();
    ensureCommentTools();
    autoLoadMore();
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
    attributeFilter: ["style", "class", "bundlename", PLAYBACK_BLOCK_ATTR],
  });
  sweep();
}

// The modal fires this right after flagging itself, and the players react in
// a bubble listener on document. A capture listener on window runs before
// them, so sweeping synchronously here hides the wall and clears its flag in
// time -- the players find nothing blocking and never pause at all. (The
// rAF sweep alone would clear it a frame late, leaving videos paused until
// tapped.)
window.addEventListener(PLAYBACK_POLICY_EVENT, sweep, true);

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

function applyAutoLoad(value) {
  autoLoadComments = value !== false;
  if (autoLoadComments) autoLoadMore();
}

function applyKeywords(value) {
  keywordRe = compileKeywords(value);
  keywordVersion++;
  reviveKeywords();
  sweep();
}

const DEFAULTS = {
  enabled: true,
  hideAds: true,
  autoLoadComments: true,
  newTabPosts: false,
  hideKeywords: "",
};

// Storage can answer before <html> exists at document_start, and the apply*
// functions set attributes on it -- wait for the root first.
const whenRoot = (fn) =>
  document.documentElement ? fn() : document.addEventListener("readystatechange", fn, { once: true });

try {
  const read = api?.storage?.local?.get?.(DEFAULTS);
  if (read?.then)
    read.then(
      (v) =>
        whenRoot(() => {
          newTabPosts = v?.newTabPosts === true;
          applyAutoLoad(v?.autoLoadComments);
          applyHideAds(v?.hideAds);
          applyKeywords(v?.hideKeywords);
          applyEnabled(v?.enabled);
        }),
      () => {},
    );

  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) applyEnabled(changes.enabled.newValue);
    if (changes.hideAds) applyHideAds(changes.hideAds.newValue);
    if (changes.autoLoadComments) applyAutoLoad(changes.autoLoadComments.newValue);
    if (changes.newTabPosts) newTabPosts = changes.newTabPosts.newValue === true;
    if (changes.hideKeywords) applyKeywords(changes.hideKeywords.newValue);
  });
} catch (e) {
  console.warn("[reddit-unblock] storage unavailable", e);
}

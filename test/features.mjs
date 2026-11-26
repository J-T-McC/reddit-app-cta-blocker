// Live check of the mobile feature set against real reddit.com, in WebKit
// with an iPhone profile. Prints PASS/FAIL per feature.
//
//   PLAYWRIGHT=/path/to/playwright/index.mjs node test/features.mjs [post-url] [subreddit-url]
//
// The post should have a few hundred comments, so there is something to load
// and search. Settings normally read from extension storage are stubbed here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { webkit, devices } = await import(process.env.PLAYWRIGHT || "playwright");
const EXT = resolve(here, "../extension");
const js = readFileSync(`${EXT}/content.js`, "utf8");
const css = readFileSync(`${EXT}/content.css`, "utf8");

const POST =
  process.argv[2] ||
  "https://www.reddit.com/r/Damnthatsinteresting/comments/1y5cv2l/convoy_transporting_nuclear_warheads_moves/";
const FEED = process.argv[3] || "https://www.reddit.com/r/Damnthatsinteresting/";

const inject = (settings) => `
globalThis.browser = { storage: {
  local: { get: async (d) => ({ ...d, ...${JSON.stringify(settings)} }), set: async () => {} },
  onChanged: { addListener() {} } } };
(() => {
  const add = () => {
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) add();
  else document.addEventListener('readystatechange', add, { once: true });
})();
${js}`;

const browser = await webkit.launch();
const results = [];
const check = (name, ok, detail = "") => results.push([ok ? "PASS" : "FAIL", name, detail]);
const settle = (page, ms = 3500) => page.waitForTimeout(ms);
const path = (u) => u.replace(/^https:\/\/www\.reddit\.com/, "").replace(/[?&](solution|js_challenge|jsc_token|jsc_orig_r)=[^&]*/g, "");

async function open(url, settings = {}, device = devices["iPhone 13"]) {
  const ctx = await browser.newContext(device);
  await ctx.addInitScript(inject(settings));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(page);
  return { ctx, page, errors };
}
const tools = (page) =>
  page.evaluate(() => {
    const bar = document.getElementById("ru-comment-tools");
    return bar && {
      sort: bar.querySelector("select").value,
      q: bar.querySelector("input").value,
      clear: !!bar.querySelector("button"),
      shown: bar.getBoundingClientRect().height > 0,
    };
  });
const topLevel = (page) => page.evaluate(() => document.querySelectorAll("shreddit-comment[depth='0']").length);
const tapTitle = async (page, post) => {
  await post.scrollIntoViewIfNeeded();
  const box = await post.locator("a[slot='title']").first().boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};

try {
  // Comment tools on a mobile post page.
  {
    const { ctx, page, errors } = await open(POST);
    const t = await tools(page);
    check("comment bar injected, Best selected", t?.shown && t.sort === "confidence", JSON.stringify(t));

    const before = await topLevel(page);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => scrollBy(0, innerHeight * 2));
      await page.waitForTimeout(1200);
    }
    const after = await topLevel(page);
    check("more comments load while scrolling", after > before + 6, `top-level ${before} -> ${after}`);

    await page.evaluate(() => scrollTo(0, 0));
    await Promise.all([page.waitForNavigation(), page.selectOption("#ru-comment-tools select", "new")]);
    await settle(page);
    check("sort -> New", /[?&]sort=new/.test(page.url()) && (await tools(page))?.sort === "new", path(page.url()));

    await page.fill("#ru-comment-tools input", "the");
    await Promise.all([page.waitForNavigation(), page.press("#ru-comment-tools input", "Enter")]);
    await settle(page);
    const hits = await page.evaluate(() => document.querySelectorAll("[data-testid='search-comment']").length);
    const t3 = await tools(page);
    check("comment search shows results", hits > 0 && t3?.q === "the" && t3.clear, `results=${hits}`);

    await Promise.all([page.waitForNavigation(), page.click("#ru-comment-tools button")]);
    await settle(page);
    check("clear search -> comments again", !/[?&]q=/.test(page.url()) && (await topLevel(page)) > 0, path(page.url()));

    const ours = errors.filter((e) => /documentElement|ru-/.test(e));
    check("no page errors from the extension", ours.length === 0, ours.join(" | "));
    await ctx.close();
  }

  // Desktop keeps Reddit's own controls.
  {
    const { ctx, page } = await open(POST, {}, { ...devices["Desktop Safari"], viewport: { width: 1440, height: 1000 } });
    check("desktop: no injected comment bar", (await tools(page)) === null);
    await ctx.close();
  }

  // Keyword filter: pick a distinctive word from a live title, then hide it.
  {
    const probe = await open(FEED);
    const titles = await probe.page.evaluate(() => [...document.querySelectorAll("shreddit-post")].map((p) => p.getAttribute("post-title") || ""));
    await probe.ctx.close();
    const word = (titles[1] || "").split(/[^\p{L}\p{N}]+/u).sort((a, b) => b.length - a.length)[0] || "";
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "iu");
    const expected = titles.filter((t) => re.test(t)).length;

    const { ctx, page } = await open(FEED, { hideKeywords: ` ${word.toUpperCase()} , zzqxnotaword ` });
    const hidden = await page.evaluate(() => document.querySelectorAll("article[data-ru-killed='keyword']").length);
    check(`keyword "${word}" hides only matching posts`, word && hidden === expected && hidden > 0, `hidden=${hidden} expected=${expected}`);
    await ctx.close();
  }

  // Open in new tab, and buttons inside cards still behave as buttons.
  {
    const { ctx, page } = await open(FEED, { newTabPosts: true });
    const feedUrl = page.url();
    const post = page.locator("shreddit-post").nth(1);
    const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null), tapTitle(page, post)]);
    await page.waitForTimeout(1000);
    check("tap post -> new tab, feed stays put", !!tab && page.url() === feedUrl, tab ? path(tab.url()) : "no new tab");

    const pages = ctx.pages().length;
    await page.locator("shreddit-post").nth(2).locator("button").first().tap({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    check("tap a button in a card -> no new tab", ctx.pages().length === pages, `pages ${pages} -> ${ctx.pages().length}`);
    await ctx.close();
  }

  // Back from a post returns to the same place in the feed.
  {
    const { ctx, page } = await open(FEED);
    await page.evaluate(() => scrollTo(0, 3000));
    await page.waitForTimeout(1000);
    // Bring the post to tap on screen first, so the position recorded here is
    // the one the reader actually leaves from.
    const target = page.locator("shreddit-post").filter({ has: page.locator("a[slot='title']") }).nth(8);
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    const anchor = await page.evaluate(() => {
      const p = [...document.querySelectorAll("shreddit-post")].find((p) => {
        const r = (p.closest("article") || p).getBoundingClientRect();
        return r.height && r.bottom > 80;
      });
      return p && { id: p.id, top: Math.round((p.closest("article") || p).getBoundingClientRect().top) };
    });
    await tapTitle(page, target);
    await page.waitForURL(/\/comments\//, { timeout: 15000 });
    await settle(page, 2500);
    await page.goBack();
    await settle(page, 5000);
    const back = await page.evaluate((id) => {
      const p = document.getElementById(id);
      return { y: Math.round(scrollY), top: p ? Math.round((p.closest("article") || p).getBoundingClientRect().top) : null };
    }, anchor.id);
    check("Back restores feed position", back.y > 500 && (back.top === null || Math.abs(back.top - anchor.top) < 40),
      `anchor ${anchor.id}@${anchor.top} -> ${back.top === null ? "gone, raw offset" : back.top}, y=${back.y}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

for (const [status, name, detail] of results) console.log(status, "-", name, detail ? `\n      ${detail}` : "");
process.exitCode = results.some(([s]) => s === "FAIL") ? 1 : 0;

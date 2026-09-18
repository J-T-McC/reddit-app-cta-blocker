// Point PLAYWRIGHT at an install whose browsers are actually downloaded:
//   PLAYWRIGHT=~/.agents/skills/playwright/node_modules/playwright-core node test/check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pwPath = process.env.PLAYWRIGHT || 'playwright';
const { webkit, devices } = await import(pwPath);

const EXT = resolve(here, '../extension');
const js = readFileSync(`${EXT}/content.js`, 'utf8');
const css = readFileSync(`${EXT}/content.css`, 'utf8');

// Reproduce what the manifest does at document_start.
const inject = `(() => {
  const add = () => {
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) add();
  else document.addEventListener('readystatechange', add, { once: true });
})();
${js}`;

async function run(label, url, withExt) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const errors = [];
  if (withExt) await ctx.addInitScript(inject);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    const r = await page.evaluate(() => {
      const cs = el => el ? getComputedStyle(el).overflowY : null;
      const modal = document.querySelector('configured-xpromo-modal');
      const before = window.scrollY;
      window.scrollTo(0, 500);
      const scrolled = window.scrollY !== before || window.scrollY === 500;
      return {
        htmlOverflow: cs(document.documentElement),
        bodyOverflow: cs(document.body),
        modalPresent: !!modal,
        modalVisible: modal ? getComputedStyle(modal).display !== 'none' : false,
        scrollable: document.documentElement.scrollHeight > window.innerHeight,
        didScroll: scrolled,
        scrollY: window.scrollY,
        textLen: (document.body.innerText || '').length,
        killed: [...document.querySelectorAll('[data-ru-killed]')]
          .map(e => e.tagName.toLowerCase() + '#' + (e.id||'-') + '.' +
                    (String(e.className||'-').slice(0,40)) +
                    ' [' + e.getAttribute('data-ru-killed') + ']'),
        postCount: document.querySelectorAll('shreddit-post, article, [data-testid]').length,
      };
    });
    console.log(label, JSON.stringify({ ...r, errors: errors.slice(0, 3) }, null, 1));
  } catch (e) {
    console.log(label, 'FAILED:', e.message.split('\n')[0]);
  }
  await browser.close();
}

const target = process.argv[2] || `file://${resolve(here, 'fixture.html')}`;
await run('[no-ext]  ', target, false);
await run('[with-ext]', target, true);

# Reddit Unblock

A Safari Web Extension that hides Reddit's "open in the app" wall, undoes the
scroll lock it leaves behind, and hides promoted posts — so reddit.com stays
usable while logged out. On mobile it also puts back what the mobile site
leaves out: comment sort, comment search, and comments that keep loading as
you scroll. Builds for **iOS and macOS** from one Xcode project.

Unofficial and not affiliated with Reddit. [MIT licensed](LICENSE).

## Requirements

- A Mac with **Xcode 15 or newer** (developed against Xcode 26).
- An **Apple ID**. A free one works; a paid Developer Program membership
  ($99/yr) only changes how long the build lasts on your device — see
  [How long it lasts](#how-long-it-lasts).
- For the iOS build, an iPhone or iPad and a cable.

You do not need to know Swift. No code is edited to install this.

## Quick start

```sh
git clone <this repo>
cd reddit-viewer
./setup.sh
```

`setup.sh` asks for two things and writes them to `Local.xcconfig`:

- **Apple Team ID** — 10 characters. The script auto-detects it if you have
  ever built anything in Xcode. Otherwise find it at
  [developer.apple.com/account](https://developer.apple.com/account) under
  Membership.
- **Bundle ID prefix** — any reverse-DNS string you control, e.g.
  `com.yourname`. It just has to be unique to you.

You can also skip the prompts: `./setup.sh ABCDE12345 com.yourname`

Then open `Reddit Unblock/Reddit Unblock.xcodeproj` and follow the platform
steps below. You should not need to touch Signing & Capabilities at all —
`Local.xcconfig` feeds every target.

> **First build may fail with** `Build input file cannot be found: ...
> .mobileprovision`. This is an Xcode race the first time it creates a
> provisioning profile. **Just build again** and it succeeds.

## Install on iPhone / iPad

1. Plug the device in and unlock it. If it asks "Trust This Computer?", tap
   **Trust**.
2. In Xcode, pick the **`Reddit Unblock (iOS)`** scheme and your device from
   the dropdown at the top, then press **Run** (⌘R).
3. If iOS says the developer is untrusted: on the device, Settings → General →
   **VPN & Device Management** → tap your Apple ID → **Trust**. Then Run again.
4. Enable the extension: Settings → **Apps** → **Safari** → **Extensions** →
   **Reddit Unblock** → toggle on.
   *(iOS 17 and older: Settings → Safari → Extensions.)*
5. On that same screen, set the permission for **reddit.com** to **Allow**.

   **Do not skip step 5.** The extension will be switched on but silently do
   nothing without it. This is the single most common mistake.

6. Open Safari → reddit.com and confirm you can scroll freely.

The app icon that gets installed is just a container. You never need to open
it on iOS — everything is in Settings and Safari.

## Install on Mac

1. Pick the **`Reddit Unblock (macOS)`** scheme and press **Run** (⌘R).
2. Safari → Settings → **Advanced** → tick **Show features for web
   developers**.
3. Safari → **Develop** → **Allow Unsigned Extensions**.
   Only needed for unsigned builds, and it resets every time Safari restarts.
   Signing with a real Team ID avoids this.
4. Safari → Settings → **Extensions** → enable **Reddit Unblock**, and set its
   reddit.com permission to **Allow**.

## Using it

The toolbar popup (the **ᴀA** or puzzle-piece icon in Safari's address bar)
holds the settings. All of them take effect in open tabs immediately.

| Setting | Default | What it does |
|---|---|---|
| Enabled | on | The whole extension. |
| Hide ads in feed | on | Hides promoted posts. |
| Load more comments while scrolling | on | Presses Reddit's own "View more comments" as you near the end of the comments, so they keep coming (mobile shows 4 top-level comments at first, desktop ~25). |
| Open posts in a new tab | off | Tapping a post opens it in a new tab. On iPhone, swiping back then closes that tab and returns you to the feed exactly as you left it. |
| Hide posts containing | empty | Comma-separated words or phrases. Hides matching feed posts and search results. See the example below. |

### Example: hiding a topic

Type this into **Hide posts containing**:

```
taylor swift, crypto
```

Each comma-separated entry is a phrase. A post is hidden if its title, flair
or text preview contains a full phrase. Case doesn't matter, and the phrase
has to stand on its own as words. Searching Reddit for `swift` with that
filter on:

| Result | Shown? | Why |
|---|---|---|
| Taylor Swift at the 2026 CMAs | hidden | contains "taylor swift" |
| Why do boys hate taylor swift??? | hidden | case doesn't matter |
| Is Taylor actually declining? | shown | "Taylor" alone isn't the phrase |
| The problem with Swift is ... It's a mess ! | shown | "Swift" alone isn't the phrase |

In testing, that hid 72 of 77 results for `swift`. Each hidden post takes its
divider with it, so the list closes up without a gap.

Two things it won't do:

- **Partial words.** A filter of `swift` hides "Taylor Swift" posts but not
  "swiftly".
- **Override a search you made yourself.** Searching `taylor swift tour` still
  shows those posts, because you asked for them. The filter only applies to
  posts you didn't search for.

Open tabs update a moment after you stop typing. To turn it off, clear the box.

Always on, with no setting:

- **Comment sort and search** on mobile post pages, where Reddit's mobile site
  has neither. The sort is a native picker (Best, Top, New, Controversial,
  Old, Q&A). Desktop layouts keep their own controls.
- **Videos play** behind a hidden wall (see *Playback release* below).
- **Back returns you to your place in the feed.** Reddit's mobile feed
  usually reloads at the top when you go back from a post.

Reddit's own search already supports excluding words: `swift -taylor` or
`swift NOT taylor`.

## How long it lasts

| Apple account | Build survives | Devices |
|---|---|---|
| Free Apple ID | **7 days**, then reinstall | 3 apps at a time |
| Paid Developer Program | 1 year | 100 |

Reinstalling is just pressing Run again.

## Troubleshooting

**"Signing for ... requires a development team"** — you skipped `./setup.sh`,
or `Local.xcconfig` has an empty `DEVELOPMENT_TEAM`.

**"Failed to register bundle identifier"** — someone else already claimed that
bundle ID. Re-run `FORCE=1 ./setup.sh` with a different prefix.

**Extension not listed in Safari settings** — the app has to be installed and
launched once. On macOS, open the app. On iOS, check it appears on the home
screen.

**Changes to `extension/` don't show up** — fully quit Safari (swipe it away
on iOS) and reopen. iOS caches extension resources aggressively; a page reload
is often not enough. A reinstall also sometimes resets the enable toggle, so
re-check it.

**It stopped working after a Reddit update** — Reddit renames things. See
below.

## How it works

`extension/content.js` deliberately does not rely on a single selector,
because Reddit renames its classes constantly. On every DOM mutation:

1. **Name match** — anything whose tag / id / class / `bundlename` looks like
   the app promo, including the confirmed `<configured-xpromo-modal>`
   (experience `mweb3x_mid_funnel_blocking_v1_30s`).
2. **Shape match** — a large fixed overlay whose text is asking you to open
   the app. The safety net for renames the first pass misses.
3. **Playback release** — a blocking wall marks its bottom sheet with
   `data-blocks-background-playback`, and every `<shreddit-player>` refuses to
   play while that attribute exists anywhere in the page. Hiding the wall
   doesn't clear it, so the extension strips it from walls it hid. That
   happens in a capture listener on the `shreddit-sync-playback-policy` event,
   which runs before the players react. Dialogs you open yourself are left
   alone.
4. **Scroll unlock** — undoes the inline `overflow:hidden` / `position:fixed`
   scroll lock.

The comment tools are rebuilt on top of things the mobile backend still
accepts, rather than on Reddit's internal code:

- **Sort** sets `?sort=confidence|top|new|controversial|old|qa`. The server
  orders comments the same way it does for desktop, and its "more replies"
  loaders keep the chosen sort.
- **Search** goes to `?q=…&type=comments`, which mobile renders server-side.
- **Load more** clicks the existing "View more comments" button (6 more
  top-level comments per click). After the first batch Reddit shrinks that
  button to zero height, so the trigger is a marker after the comment tree.
  The next click waits until a batch has finished arriving, and it stops after
  two clicks that load nothing.

**Feed position on Back.** Tapping a post on mobile is a full page load, and
Back reloads the feed whenever Safari's back-forward cache didn't keep it.
Reddit sets `history.scrollRestoration = "manual"`, which turns off Safari's
own restore, and then doesn't restore the position itself. The extension
records the post at the top of the screen as you scroll (in
`sessionStorage`). After a Back reload it brings that post back to the same
spot, letting infinite scroll load more first if needed, and it stops the
moment you touch the screen. The logged-out feed can come back slightly
reshuffled, so the post you opened may be gone. "Open posts in a new tab"
avoids the reload altogether.

Promoted posts go through the same machinery. Feed ads are
`<shreddit-ad-post promoted>` — a bare sibling of the `<article>` wrappers
real posts use, containing no `<shreddit-post>` of its own, so hiding one
collapses the slot without leaving a gap. A tag-name rule (`/(^|-)AD(-|$)/`)
also covers `<shreddit-sidebar-ad>` and any future `<*-ad-*>` element, and a
narrow fallback matches the visible "Ad" flag if the element is renamed.

`extension/content.css` is injected at `document_start` so nothing flashes
before the JS runs. Its `!important` rules beat Reddit's non-important inline
styles, which is what actually defeats the scroll lock.

Offenders are **hidden, not removed** — Reddit's web components re-render
nodes that disappear, which turns removal into a fight with the framework.

### When Reddit changes something

Add the selector to `PROMO_SELECTORS` (walls) or `AD_SELECTORS` (ads) in
`extension/content.js`, then rebuild. Nothing else needs to change — the
Xcode project *references* `extension/` by relative path rather than copying
it, so editing a file there and pressing Run is the whole loop.

## Layout

```
extension/            the web extension — the source of truth
test/                 optional WebKit regression check
setup.sh              writes Local.xcconfig
Config.xcconfig       shared settings (committed)
Local.xcconfig        your team + bundle prefix (gitignored)
Reddit Unblock/Reddit Unblock.xcodeproj
```

## Regression check (optional)

Drives WebKit — the same engine as Safari — with an iPhone user agent, and
reports what the extension hid and whether the page still scrolls.

```sh
npm install playwright
npx playwright install webkit

node test/check.mjs                                # local fixture of the wall
node test/check.mjs https://www.reddit.com/r/gaming/
```

Each run prints the page with and without the extension, so a regression shows
up as a difference in post count, text length or page errors. The fixture
also replays Reddit's video-blocking flag, and reports whether a player would
have been paused (`videoPausedByPolicy`). If you have Playwright somewhere
else, point at it with `PLAYWRIGHT=/path/to/playwright/index.mjs`.

`test/features.mjs` checks the mobile features against live Reddit: the
comment bar, sort, search, auto-loading, the keyword filter, open-in-new-tab,
and Back restoring the feed position. It prints PASS/FAIL for each and exits
non-zero on any failure:

```sh
node test/features.mjs                         # built-in post + subreddit
node test/features.mjs <post-url> <subreddit-url>
```

## License

[MIT](LICENSE). Reddit is a trademark of Reddit, Inc.; this project is not
affiliated with or endorsed by them.

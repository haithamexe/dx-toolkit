# Design standards and the brand

How dx looks, behaves and speaks. **Read this before building or changing anything the user sees**, and follow it every time: a page, a button, a dialog, a message, a colour. The checklist at the end is the short form. The reasons and the decisions behind it are in [MEMORY.md](MEMORY.md).

A standard here is a rule with a helper that already exists. Use the helper; don't write a new way.

## The standards

### Seeing and attention

- **Hub and spoke.** Home is the hub: what needs you, what's running, what dx did. Every other page is a spoke with one way back. A project's own page opens with four chunks (Run, Code, Health, Activity), each saying one thing with one action (`projectChunks`). A page never needs a map.
- **Chunking.** Group what belongs together into a few named chunks; fold a long list after five rows (`foldRows`). A screen that needs more than about four groups is two screens.
- **Recognition over recall.** Show choices; never ask the user to remember or type what dx can find: the project switcher, Jump to… (`openPalette`), next-step buttons (`nextSteps`), pick-from-list fields. A path, a command or an id is something dx fills in.
- **Progressive disclosure.** The common case first; the rest one click away and remembered once opened (closed folds, Advanced, Raw behind Visual). Settings with one value live under Advanced.
- **Say little.** A cut string is `""` and CSS hides the empty element. A zero-state isn't drawn: nothing to clean says nothing or one line. Copy states what happened and what to do next, in plain words, without "please", "simply" or jargon.

### Acting and flow

- **Safe exploration.** Anything dx changes is listed under Recent changes with its reason and Undo where one exists (`recordChange`, `POST /api/undo`). Things that can't be undone say so on the thing itself ("Can't be undone"), never as a surprise afterwards.
- **Scaffolding.** A new user is walked: the Get started card ticks itself and goes away, empty states offer the one action that fills them, next steps are buttons.
- **Friction in proportion to risk.** Four tiers (`riskOf`): *none* (a read), *reversible* (listed, with Undo), *asks* (an AI tool asks the person each time: `risky`), *name* (public or permanent: the person types the name, `confirmByName`). Never confirm what can be undone; never let what can't be undone through on one click.
- **Optimistic UI.** A button that runs something answers at once on itself and rolls back with a shake and a reason if it didn't work (`morph`, the Run card's `optimistic`). Don't wait for the server to show what is expected.
- **A co-pilot, not an autopilot.** dx does only what it was told to, per thing: suggest, ask or do (`CAPABILITIES`, `levelOf`). AI proposes and the person decides: nothing is sent to an AI without showing what first (`confirmSend`), nothing it proposes is applied without review and Undo, and what an AI tool changed is tagged AI. What dx never does by itself (run Claude Code, push, release, delete) is not a capability.

### The shape of the thing (mental model)

- **Slice, don't scroll.** Lists of projects are filtered by facets with counts (`facets.ts`): "or" within a facet, "and" across, a count that already accounts for the other choices, saved views, tags, pins. The filter is in the address.
- **Everything has an address.** A page, a slice, a selected service: `#/page?dir=…&service=…`, written with `setHashParams` (no redraw), so it can be bookmarked and shared. The token is never in an address.
- **One list, one shape.** One attention model decides what needs you (`attention.ts`); one list says what changed; one shape says what failed: `{ code, message, fixes }` (`Problem`). Don't invent a second.
- **Nested like a doll.** Computer › project › chunk › page › detail. Going deeper never loses where you were; going out is one click.

### State and trust

- **Live, never stale.** The page is told what changes (`GET /api/events`, `onLive`); there is no Refresh button. Polls are the safety net (`livePoll(..., { events: true })`). The sidebar says **Live**; when dx stops, the page is dimmed and says when its content is from.
- **Degrade by part.** One part failing doesn't take the rest: the summary lists what it couldn't read (`problems`), a page keeps its last content, and a failure carries its reason and fix where it happened (`problemBlock`).
- **Show what is true.** A status colour, a count and a "Live" are never decoration. A thing that isn't running doesn't look running; a guess says it is a guess.
- **Be honest about the network.** Say where something goes and what is never sent before it goes. dx talks to this computer unless a person added the address.

### Diegetic: the thing says it itself

- State and controls live **on the object they are about**, not in a detached alert. A card changes its edge, a button shows a spinner then "✓ Pushed" on itself then goes back, a failed button shakes and says why beside it (`morph`, `shake`, `inlineProblem`), a failed card carries its reason and its fixes (`problemBlock`).
- A **toast** is for what has no object: something dx did in the background, with Undo if it can. It is never the result of a button the person just pressed.
- Prefer **previews to forms**: show what will happen (what will be sent, what a rule will match, the diff) and let the person press the one button.
- **Motion tells state** (pulse while working, shake for "no", slide for arrival) and stops under `prefers-reduced-motion`: the same news arrives as a red pulse or text. Every change a person must know is also said to screen readers (`announce`).

### The floor: never traded for style

- Text pairs measure **4.5:1** (3:1 for large text), control borders **3:1**. Check a new pair; don't eyeball it.
- Never colour alone: status also has words or an icon.
- Real `<button>`, `<a href>`, `<input>` with a `<label>`; everything reachable and usable by keyboard; focus is visible; targets are comfortable.
- Works at phone width (the sheet stacks under 860 px) and with the window resized.
- No inline script or style, no external host (the CSP), and the page builds DOM with `h()` and text nodes, never `innerHTML` with data.

## The brand: Arcade

dx is a small, friendly, precise tool with a pixel mascot. The look is **"window on the desk"**: the app is one sheet resting on a deep indigo desk whose 8 px grid shows only around it. Light and dark are both first-class. Every colour is a token in `packages/web/public/styles.css`; the rest of the file only uses them. **Never write a literal colour.** Add or reuse a token, in light and dark, and measure it.

| Role | Token | Means |
|---|---|---|
| Action | `--accent` (violet) | what you press; links; focus |
| dx's own voice | `--second` (pink), `--second-btn` | AI, "dx wants to…", Started by AI, AI activity |
| Where you are | `--marker` (lime) | the current page's pip; Floppy's sparkle; nothing else |
| The desk | `--desk`, `--desk-minor`, `--desk-major` | what the sheet rests on |
| Neutrals | `--bg`, `--surface`, `--surface-2`, `--border*`, `--text`, `--text-dim` | a violet-tinted grey, never pure black or white text |
| Status | `--ok`, `--warn`, `--danger` (+ `-soft`) | green is fine, amber is a warning, red is a problem |

**Colour says what a thing is** (by meaning), through six hues that are tuned to the same weight in light and dark: `--h-violet|blue|cyan|lime|orange|pink-fill|ink|soft|text|line`.

| What | Colour |
|---|---|
| Kind of project (`kindHue`) | Next.js / Remix violet · Vite / Astro / SvelteKit / Nuxt cyan · Node server / Angular blue · Python orange · Go / Rust lime |
| Environment (`envBadge`) | local lime · staging orange · **production pink and solid**, so a click there isn't mistaken for staging |
| Role in a stack | front end pink · back end violet · data cyan |
| Branch | the commit graph's `--lane-1…6`, one hue each |

- A tint (`soft` + `text`) for chips on a card; a solid (`fill` + `ink`) where it must stand out. A hue is never reused for a different meaning.
- Type: **Geist** for reading, **Geist Mono** for anything a machine wrote, **Silkscreen** for the logo and small labels only, never a sentence. Fonts ship in `public/fonts` (the CSP allows nothing else).
- **Floppy** is the mascot: the 24-pixel save icon, violet with a lime sparkle by default (`FLOPPY_COLOURWAYS`), drawn in whole multiples so it stays sharp. Its moods show what dx is doing (idle, working, ok, error, asleep). It is brand and state, not decoration: it never says something the page doesn't.
- Voice: short, concrete, calm. Names the thing ("shop-website didn't start: port 3000 is in use by node.exe"), says what to do ("Use another port"), never blames.

## Before you ship anything the user sees

1. **Reuse before you write**: is there already a helper (`morph`, `problemBlock`, `confirmByName`, `foldRows`, `facetBar`, `liveDetail`…) or token for this?
2. **One job per screen or chunk**, with one main action; the rest folded or one click away.
3. **Outcomes live on the object**: no toast for a button's own result; a failure shakes and carries its reason and fix (`{ code, message, fixes }`).
4. **Risk sets the friction**: tier it (none / reversible / asks / name); anything reversible is recorded and has Undo.
5. **Live**: subscribe to `onLive` where it changes; keep the poll as a net; say when it's stale.
6. **An address**: a slice or selection is in the URL; nothing secret is.
7. **Show before you send** anything to an AI or off this computer.
8. **Colour by meaning**: tokens only, in light and dark; measure new text pairs (4.5:1) and borders (3:1); never colour alone.
9. **Accessible**: keyboard, labels, focus, reduced motion, `announce`, phone width.
10. **Less text**: cut strings are `""`; no zero-state clutter; no jargon.
11. **Tests and docs**: the frontend test opens every page (and fails on a stray `null`); update `docs/features.md` and `CHANGELOG.md`, and `MEMORY.md` for a decision.

## Where it isn't there yet

- `busy()` now does what `morph` does for a button's failure (it shakes and says why beside the button) and shows a check when it worked, so every older button follows the rule for failures. The success messages that carry details ("Saved 3 tools", a count, a name) are still toasts on those pages; each moves onto its button or card with `morph`'s `done` text as the sweep goes on.
- Home, a project's chunks, Recent changes, Ports, Machine, Secrets, the Code page's unsaved work and Settings' checks listen to the live stream; the others poll.
- Code views tint syntax by meaning (keyword violet, string cyan, number orange, comment dim) in the preview and nowhere else; every pair measures 6:1 or better on the code background.
- The README screenshots (`docs/images/`) show the Arcade look (retaken Nov 2026); retake them the usual way when a page changes.

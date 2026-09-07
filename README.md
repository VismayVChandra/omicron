# omicron

**Swell** — a wave-themed AI drafting landing page. The "Generate" button in
the hero drafts a real slide deck, streamed live into an editable deck viewer,
via Vercel Edge Functions backed by Groq.

Drafting is two steps, as in Gamma: a topic produces an editable outline, and
only once that outline is approved are the slides written.

You can optionally give it your own material — notes, a report, a transcript, a
PDF, a Word file, a deck, or a link — and the deck is built from that instead of
from the model's own knowledge, with every figure required to come from what you
gave it. With nothing pasted the
model is explicitly told not to invent statistics, market sizes or dated
forecasts, because it has no source to draw them from. Audience, tone and
length are selectable and feed every request.

- `index.html` — the landing page plus a full-screen editor (slides, thumbnail
  rail, present mode, in-place editing, undo and redo, adding and deleting
  slides, changing a slide's layout, choosing its photograph, rewriting a
  selection with AI, speaker notes, drag-to-reorder, ten deck themes, saved
  drafts, PDF export via the browser's print, `.pptx` export, and share links). Generating switches to the editor rather than
  scrolling; the shared elements are moved between the two rather than
  duplicated.
- `api/outline.js` — step one: plans the deck, returns `{title, tagline, sections}`
- `api/generate.js` — step two: streams the slides. Returns a line-based format
  (`TITLE` / `TAGLINE` / `===` / `LAYOUT` / `HEADING` / `BODY` / `BULLET` /
  `IMAGE`) rather than JSON so the client can render each slide as it arrives.
  Accepts an approved outline and follows it exactly.
- `api/slide.js` — regenerates a single slide, returns JSON. Given an
  instruction it revises the slide it is handed instead of redrawing it, so
  "cut this to two points" edits what is there rather than starting again.
- `api/rewrite.js` — rewrites one piece of text: a whole line, or just the words
  you highlighted inside one. Shorter, longer, plainer, punchier, or whatever
  you type. It may not introduce facts.
- `api/notes.js` — writes speaker notes for the whole deck in one request.
- `api/fetch.js` — reads a web page and returns its prose, so a deck can be
  built from a link. The interesting part is what it refuses.
- `api/critique.js` — reads a finished deck back as its toughest audience and
  returns what will get challenged, tied to the slides it is about.
- `api/voice.js` — reads samples of your own writing and returns your habits as
  instructions the slide writer follows, in place of the generic tone setting.
  Stored per browser, not per deck, and it never sees the samples again.
- `api/verify.js` — pulls the externally checkable claims out of a deck, looks
  each up on Wikipedia (no API key needed) and reports whether the source backs
  it, contradicts it, or does not settle it. It deliberately skips your own
  metrics and plans, and "no source found" never means "false".
- `api/image.js` — finds a slide photograph on Wikimedia Commons, filtering out
  diagrams and NC/ND-licensed files and widening the query if nothing matches.
  `?n=8` returns a set to choose from instead of a single verdict, which is what
  the editor's image picker shows.
- `api/imagegen.js` — draws a slide photograph instead of finding one, in the
  deck theme's own light and colour. Optional: without a key the button is
  hidden and nothing else changes.

All run on the Edge runtime and use `openai/gpt-oss-120b` with
`reasoning_effort: 'low'` — that model reasons silently before answering, and
without that setting it spends its whole token budget thinking and returns
nothing.

## Bringing your own material

Drop a **PDF**, **`.docx`** or **`.pptx`** on the source box, or paste a **link**.
Everything ends up in the same place — text in the source box — which the outline
and the slide writer already know what to do with.

`.docx` and `.pptx` are zip files, so both come apart with JSZip; PDFs go through
pdf.js, which reconstructs lines from the text positions rather than running the
words together. Both libraries are fetched the first time you actually import
something, not on page load. A `.pptx` comes back slide by slide, which is how
you restyle an existing deck: import it, and the ten themes are yours.

`/api/fetch` is a server that retrieves a URL somebody typed, which is the
textbook shape of a server-side request forgery. It refuses anything that is not
http or https, and any hostname that is loopback, link-local, private, `.internal`
or `.local` — the cloud metadata endpoint at `169.254.169.254` being the one that
matters most. It will not follow redirects, because the address at the end of one
is not the address that was checked. It is honest about its limits: hostnames are
checked rather than resolved addresses, so a name that resolves to a private
address still gets through.

### Long documents

The source box takes 12,000 characters and a report is happily five times that.
Truncating would mean the deck argues from page three and silently ignores the
rest, so anything longer is condensed first — **in the browser, without the
model**.

That was going to be a summarising endpoint until measurement killed it. Groq's
free tier allows **8,000 tokens a minute**; a fifty-page document is thirteen
thousand, so reading it once would spend two minutes of the entire budget before
a single slide got written. And an abstractive summary paraphrases, which is the
last thing wanted from the one feature whose whole purpose is that the deck stops
inventing figures.

So it is extractive instead: score every sentence on how much of the document's
own vocabulary it carries, favour the ones with figures, names and headings,
discard the navigation residue, and keep the best of them **in the order they
appeared**. On a 52,000-character encyclopedia article it kept 77 of 1,176
sentences — including the two largest installations and their capacities in
megawatts — in the author's own words, instantly and for no tokens at all.

## Editing a deck

The draft is a starting point, not a verdict, so everything it decided can be
taken back:

- **Undo and redo**, on Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z as well as the two
  arrows in the chrome. Every change goes through it — typing, reordering,
  regenerating a slide, switching theme, adding a chart, rewriting for another
  audience. A burst of typing collapses into one step rather than one per
  keystroke, and undoing an edit leaves you looking at the slide you edited;
  only adding or deleting a slide moves you.
- **Add, duplicate and delete** slides. Adding asks which layout, and the new
  slide's empty lines carry their own labels, because a line with nothing in it
  has no height left to click back into.
- **Change a slide's layout** after the fact. The words come across rather than
  the shape: bullets split into two columns when a slide becomes a comparison
  and flatten back when it stops being one, and a slide turned into a statement
  keeps its strongest line.
- **Enter and Backspace work on lists.** Enter opens the next bullet, Backspace
  on an empty one removes it. In a heading Enter does nothing, because a
  heading is one value and not a paragraph.
- **Choose the photograph.** Search Commons from the editor and pick from the
  results instead of accepting whatever ranked first, or clear it. A picture
  chosen by hand travels with the slide into saved decks, share links and both
  exports; one left to the search still travels as its search term, which is
  what keeps an ordinary share link near 1KB.

Saving updates the deck that is open rather than filing another copy of it, and
saved decks can be renamed in place. A deck opened from a share link is a copy,
so saving it makes a new one — the sender's deck is not yours to overwrite.

## Editing with the model

Three ways, all of them narrow on purpose. None may introduce a fact.

**Highlight anything and a bar appears** — shorter, longer, plainer, punchier,
or *Ask…* and type what you want. It acts on what you highlighted, not the whole
line: pick three words in the middle of a sentence and those three words change.

The fragment goes to the model marked inside its own line rather than quoted on
its own, because on its own it gets rewritten as if it stood alone — "generators
are *loud, costly*" came back as "generators are *blare, drain money*", which is
not a sentence. Marked in place, the replacement joins up.

**Rework this slide** takes an instruction — *drop the jargon*, *lead with the
number*, *cut this to three points* — and revises the slide it already has,
leaving alone whatever the instruction did not mention. Regenerating without an
instruction still redraws from scratch, as before.

It works on the cover too, which is the slide you are looking at the moment a
deck finishes and the first thing anyone wants to change. The few tools that
genuinely do not apply there — a cover has no layout to switch and a deck has
one of them — say so when you tap them, rather than sitting greyed out looking
broken.

**Speaker notes** are what you say while a slide is up, not what is on it. They
can be typed or written for you, and the whole deck goes to the model in one
request rather than one call per slide — notes written independently repeat each
other, and a presenter noticing the same sentence three times stops trusting
them. A slide carrying notes is marked on its thumbnail, and the notes travel
into the PowerPoint as real notes pages.

Everything here is one Ctrl+Z from being undone.

## Slide layouts

Eight of them: a cover, `bullets` (split with a photograph when there is one),
`steps` for a real sequence, `compare` for two things set against each other,
`section` as a full-bleed divider in longer decks, `statement` for the one line
worth leaving on screen alone, `stat` for a single number, `quote`, and `chart`
from your own data. The model picks per slide and is told to keep at least half
of them `bullets` — cycling through every layout for its own sake is as bad as
using one for everything.

Ten deck themes, and they are not all the same kind of thing.

All ten are designed themes — their own geometry, not just their own colours —
and each carries its furniture into the PowerPoint export, so the design
survives the file rather than living only on screen. Each was given a motif of
its own so they do not read as variants of one another:

| Theme | Motif | What it actually changes |
|---|---|---|
| **Tide** | the wave | a crest along the foot of the slide, rounded geometry, a rounded accent underline, pill comparison labels |
| **Press** | a newspaper | accent rule across the head, ruled headings, em-dash bullets, photographs inset behind a keyline, a running foot with deck title and folio |
| **Azure** | a board pack | accent bar down the left edge, short rule under each heading, square markers, accent keyline on the photograph, a numbered chip |
| **Amber** | a dark keynote | no rules at all, oversized type, a folio ghosted behind the content, bullets on accent stems, photographs to the edge |
| **Dune** | a gallery brochure | everything centred, the heading held between two hairlines, photographs matted inside a wide margin |
| **Orchard** | a field notebook | a dotted rule down the margin, dotted heading rules, diamond markers, a folio on a tab at the left edge |
| **Plum** | soft luxe | an arch-topped photograph, one rule holding the whole list instead of a marker per line, italic serif headings |
| **Mist** | an airy card | the content floats on an inset panel above the slide ground, bullets set as pills |
| **Graphite** | a blueprint | a faint grid across the slide, `>` chevrons for bullets, comparison columns ruled like a table |
| **Noir** | a title card | letterbox bars top and bottom, centred content, wide-tracked caps |

The wave decoration belongs to Tide alone; leaving it on by default put a stray
teal crest through nine themes that have a motif of their own.

### Your own

An eleventh option appears once you set one up: **Yours**.

A brand does not invent a theme. The geometry above is the part that took the
design work — Press its running foot and ruled headings, Plum its arch-topped
photograph — and no colour picker produces any of that. So a brand *borrows* one
theme's shape and repaints it. The deck carries `data-deck-theme` of the base,
which brings the geometry, plus `data-brand`, which an injected stylesheet uses
to override the palette tokens and nothing else.

Three colours — page, text, accent — fill nine tokens. Muted text is the ink
walked a third of the way toward the page; the cover inverts, because all ten
built-in themes invert theirs. Two fonts, from a list of eleven, loaded only when
chosen. A logo is resampled to 260px and sits on the cover, not on every slide,
where it would be wallpaper.

**Contrast is shown while you choose**, because this project checked every theme
it shipped and a colour picker that silently allows 2:1 grey on grey would undo
that. Headings and body are held to 4.5:1, the accent to 3:1, and anything under
is called out rather than quietly accepted.

The brand belongs to you rather than to a deck, so it applies to every deck you
open. It lives in this browser, and when there is an account it also rides in the
account's own metadata — no table, no SQL to run — so signing in elsewhere brings
it with you. The export takes the same three colours through the same arithmetic,
so a `.pptx` opens in your colours with your logo on the cover.

Every theme travels with a deck into saved drafts, share links and both exports,
and each was checked for contrast on a real slide: headings 10.9:1 or better,
body text 5.2:1 or better.

## Generated pictures

Optional, and off until a key is set. Commons is fine for "Tokyo" and useless
for "operational resilience", which is the gap this closes.

`flux-1-schnell` takes no seed — its whole input is a prompt and a step count —
so the same words asked three times give three different pictures. There is no
way to ask for the same one again.

That decides the storage. Picking a generated image keeps its actual pixels on
the slide: 768px wide, JPEG at 0.72, which measures about 40KB. Rendering, the
PDF and the `.pptx` all use the kept copy. Had the slide stored only the URL,
the picture would have been stable exactly as long as the edge cache held it,
and a deck saved today could quietly show a different photograph next month.

Share links are the exception: 40KB per picture does not fit in a URL, so they
carry the prompt and the theme instead. The recipient's copy draws its own — the
same subject in the same light, not the same photograph. Their copy then keeps
its own pixels from there.

About one call in four fails with an empty body and succeeds a moment later, so
a transient failure is retried once. A rejected key or a spent allowance is not:
those are answers rather than hiccups. A drawing takes ten to twenty seconds.

The deck's theme decides how the picture is lit: a Noir deck asks for deep
shadows and a single hard source, a Mist deck for something pale and high-key,
so ten slides do not look like ten different stock libraries. Switching theme
redraws every generated picture in the new theme's light — the one case where
the picture is meant to change, so the kept copy is deliberately dropped.

| Provider | Free tier | Set |
|---|---|---|
| **Cloudflare Workers AI** (FLUX-1-schnell) | 10,000 neurons a day, 4.8 per tile — around 200 images, no card | `CF_ACCOUNT_ID`, `CF_API_TOKEN` (must start `cfut_`) |
| **Together AI** (FLUX.1-schnell) | a free endpoint, historically promotional — check before relying on it | `TOGETHER_API_KEY` |
| **Google Gemini image** (Nano Banana) | none. Google's pricing page lists Free Tier as "not available" for all four of its image models | `GEMINI_API_KEY` |

The first one configured is the one used. Cloudflare is the default because it
is the only one of the three with a free tier that survives reading the docs
rather than the blog posts about them.

Cloudflare prefixes its credentials, and the dashboard offers two that are easy
to mistake for each other. **`cfut_`** is a scoped User API Token — that is the
one this wants, and the one the Workers AI template creates. **`cfk_`** is the
Global API Key: full access to the entire account, a different auth scheme
(`X-Auth-Email` and `X-Auth-Key`, not a bearer token), and no business being in
a deployed app's environment. Sent as a bearer token it answers "Authentication
error" and tells you nothing, so `/api/imagegen` checks the prefix and says
which one you have.

Every prompt asks for no text, no letters and no logos, because these models
write gibberish signage into a picture whenever they think a label belongs
there, and the slide has real words on it already.

`/api/imagegen` is a public GET that spends quota, so it serves only requests
whose `Referer` or `Origin` is this deployment. That stops a crawler spending
the day's allowance; it is not a serious access control, and a determined
person can forge a header.

## Charts

Chart slides come from data you paste, never from the model. The CSV is parsed
in the browser, the summary line under the heading is computed from the rows,
and the axis ticks at round numbers. Bars always start at zero because their
length is the quantity; a line may sit in a focused range because position, not
length, carries the value. Exports become native PowerPoint charts with their
data attached, so they stay editable in PowerPoint.

## Sharing and export

There are two kinds of link, and they trade opposite things.

**A fragment link** carries the whole deck in the URL, deflated with
`CompressionStream` and base64url'd. It needs no database, and the deck never
reaches a server at all, because fragments are not sent with a request. Slide
images travel as their search terms rather than image data, which keeps it near
a kilobyte. What it cannot do is tell you anything — nobody can know it was
opened, precisely because nothing was ever sent.

**A hosted link** is the other trade: a row in Postgres, a short URL, and a
record of the reading. It needs `supabase/shares.sql` run once. A share is a
snapshot rather than a pointer, so editing the deck afterwards does not quietly
change what somebody was sent, and a link can be paused or deleted without
touching the deck it came from.

The reader gets the deck with the editing removed — they can move through it,
present it and export it, but not change it — and a line at the foot of the page
that says the sender can see it was opened and how far it was read. That is
stated on the page rather than buried in a policy, because somebody reading a
deck should be able to tell they are being counted.

What is counted is deliberately thin: how many readers, the furthest slide
reached, and how long the page was open. The reader is identified by a random
string their own browser made up and kept — no IP, no user agent, no account.
It exists so that opening a deck twice does not read as two people, and it
cannot be traced back to anyone.

These are indicative counts, not an audited log. The policies have to accept
writes from readers who are not signed in, so anybody holding a link could
inflate their own row. That is the honest cost of anonymous reading, and it is
not worth a login wall to fix.

Comments are per slide and visible to everyone who can open the link, which is
what makes them a conversation rather than a suggestion box. The owner sees them
gathered under the link in **Shared links** and can delete any of them. There is
no moderation queue, no notification and no spam handling beyond a length limit,
so a link that reaches somewhere hostile is a link worth deleting.

`.pptx` export builds a real OOXML file in the browser with PptxGenJS, pinned to
**4.0.1** — 3.12.0's bundle never settles its `write()` promise in the browser.
The library is ~470KB, so it is fetched on first use rather than on page load.

## Accounts (optional)

Without accounts, decks live in `localStorage` — this browser only. Turn on
accounts and a saved deck follows you between browsers and devices.

It is entirely optional: `/api/config` reports whether Supabase is configured,
and when it is not, nothing loads and the site behaves exactly as it did before
accounts existed.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql).
   It creates the `decks` table and the row level security policies.
3. **Authentication → URL configuration**: set *Site URL* to your deployed URL
   and add the same URL under *Redirect URLs*. Sign-in is an emailed link, so
   this is what the link comes back to.
4. **Project settings → API**: copy the *Project URL* and the *anon public* key.
5. Add both to Vercel under **Settings → Environment Variables**:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
6. Redeploy.

For hosted share links, run [`supabase/shares.sql`](supabase/shares.sql) as well.
It is a separate file because a deployment that only wants accounts and saved
decks should not have to take a publicly readable table. Without it, everything
else works and the **Shared links** button says what is missing.

The anon key is meant to be public — it carries no privileges of its own. Every
rule that matters is the row level security in `schema.sql`, which compares
`auth.uid()` to each row's `user_id`, so a signed-in person can only ever read
and write their own decks. The *service role* key must never be used here.

Supabase's built-in email sender is rate limited and fine for trying this out;
a real deployment wants SMTP configured under Authentication → Emails.

## Not built

Real-time collaboration — two people editing the same deck at once — is not
built and would need more than the database above.

Editing has no rich text: a line is a line, with no bold, italic, links or
inline formatting, and there are no tables and no embeds. Imported PDFs must
contain real text — a scan needs OCR, which is not built. A brand repaints a
built-in theme rather than defining new geometry, and it carries one logo rather
than a full identity system. Speaker notes are
written and exported but there is no presenter view — seeing them while you present needs a
second screen, which one browser page cannot give you. The ten themes above are
the whole set; there is no way to build one from your own colours, fonts and
logo.

## Deploy on Vercel

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys)
   (no credit card required).
2. Import this repo at [vercel.com/new](https://vercel.com/new).
3. In the project's **Settings → Environment Variables**, add:
   - `GROQ_API_KEY` — the key from step 1.
4. Deploy. `index.html` is served as the site; `api/generate.js` runs as a
   serverless function at `/api/generate`.

Optionally add `CF_ACCOUNT_ID` and `CF_API_TOKEN` and slides can have their
pictures drawn rather than searched. Both come from one screen:
[dash.cloudflare.com](https://dash.cloudflare.com) → **Workers AI** → **Use REST
API**. The token template grants Workers AI *Read* and *Edit* and the REST API
needs both, so keep both rows; set **Account Resources** to your account or the
token will not authorise anything. See [Generated
pictures](#generated-pictures) for the alternatives.

## Run locally

```bash
npm install -g vercel
vercel dev
```

`vercel dev` reads `GROQ_API_KEY` from a local `.env` file (copy
`.env.example` to `.env` and fill in your key).

# omicron

**Swell** — a wave-themed AI drafting landing page. The "Generate" button in
the hero drafts a real slide deck, streamed live into an editable deck viewer,
via Vercel Edge Functions backed by Groq.

Drafting is two steps, as in Gamma: a topic produces an editable outline, and
only once that outline is approved are the slides written.

You can optionally paste your own material — notes, a report, a transcript —
and the deck is built from that instead of from the model's own knowledge, with
every figure required to come from what you pasted. With nothing pasted the
model is explicitly told not to invent statistics, market sizes or dated
forecasts, because it has no source to draw them from. Audience, tone and
length are selectable and feed every request.

- `index.html` — the landing page plus a full-screen editor (slides, thumbnail
  rail, present mode, in-place editing, drag-to-reorder, ten deck themes, saved
  drafts in `localStorage`, PDF export via the browser's print, `.pptx` export,
  and share links). Generating switches to the editor rather than scrolling;
  the shared elements are moved between the two rather than duplicated.
- `api/outline.js` — step one: plans the deck, returns `{title, tagline, sections}`
- `api/generate.js` — step two: streams the slides. Returns a line-based format
  (`TITLE` / `TAGLINE` / `===` / `LAYOUT` / `HEADING` / `BODY` / `BULLET` /
  `IMAGE`) rather than JSON so the client can render each slide as it arrives.
  Accepts an approved outline and follows it exactly.
- `api/slide.js` — regenerates a single slide, returns JSON.
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

All run on the Edge runtime and use `openai/gpt-oss-120b` with
`reasoning_effort: 'low'` — that model reasons silently before answering, and
without that setting it spends its whole token budget thinking and returns
nothing.

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

Every theme travels with a deck into saved drafts, share links and both exports,
and each was checked for contrast on a real slide: headings 10.9:1 or better,
body text 5.2:1 or better.

## Charts

Chart slides come from data you paste, never from the model. The CSV is parsed
in the browser, the summary line under the heading is computed from the rows,
and the axis ticks at round numbers. Bars always start at zero because their
length is the quantity; a line may sit in a focused range because position, not
length, carries the value. Exports become native PowerPoint charts with their
data attached, so they stay editable in PowerPoint.

## Sharing and export

Share links carry the whole deck in the URL fragment, deflated with
`CompressionStream` and base64url'd, so sharing needs no database and the deck
never reaches the server (fragments aren't sent). Slide images travel as their
search terms rather than image data, which keeps a link around 1KB.

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

The anon key is meant to be public — it carries no privileges of its own. Every
rule that matters is the row level security in `schema.sql`, which compares
`auth.uid()` to each row's `user_id`, so a signed-in person can only ever read
and write their own decks. The *service role* key must never be used here.

Supabase's built-in email sender is rate limited and fine for trying this out;
a real deployment wants SMTP configured under Authentication → Emails.

## Not built

Real-time collaboration and view analytics on shared links need infrastructure
beyond the database above and are not built. AI-generated slide images need a
paid image API; the free generators cannot sustain a deck's worth of requests.

Editing is still shallow next to the generation: you can retype any line, drag
slides to reorder and regenerate one slide, but you cannot change a slide's
layout after the fact, add a slide by hand, replace an image, or undo anything.

## Deploy on Vercel

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys)
   (no credit card required).
2. Import this repo at [vercel.com/new](https://vercel.com/new).
3. In the project's **Settings → Environment Variables**, add:
   - `GROQ_API_KEY` — the key from step 1.
4. Deploy. `index.html` is served as the site; `api/generate.js` runs as a
   serverless function at `/api/generate`.

## Run locally

```bash
npm install -g vercel
vercel dev
```

`vercel dev` reads `GROQ_API_KEY` from a local `.env` file (copy
`.env.example` to `.env` and fill in your key).

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

- `index.html` — the site, the outline editor and the deck viewer (slides,
  thumbnail rail, present mode, in-place editing, drag-to-reorder, four deck
  themes, saved drafts in `localStorage`, PDF export via the browser's print,
  `.pptx` export, and share links)
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

## Not built

Accounts, cross-device storage, real-time collaboration and view analytics all
need infrastructure to be provisioned (a database, a realtime service) and are
not part of this repo. AI-generated slide images need a paid image API; the free
generators cannot sustain a deck's worth of requests.

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

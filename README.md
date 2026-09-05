# omicron

**Swell** — a wave-themed AI drafting landing page. The "Generate" button in
the hero drafts a real slide deck, streamed live into an editable deck viewer,
via Vercel Edge Functions backed by Groq.

- `index.html` — the site and the deck viewer (slides, thumbnail rail,
  present mode, in-place editing, drag-to-reorder)
- `api/generate.js` — streams a whole deck. Returns a line-based format
  (`TITLE` / `TAGLINE` / `===` / `LAYOUT` / `HEADING` / `BULLET`) rather than
  JSON so the client can render each slide as it arrives.
- `api/slide.js` — regenerates a single slide, returns JSON.

Both run on the Edge runtime (streaming) and use `openai/gpt-oss-120b` with
`reasoning_effort: 'low'` — that model reasons silently before answering, and
without that setting it spends its whole token budget thinking and returns
nothing.

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

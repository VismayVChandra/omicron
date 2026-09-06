// Writes speaker notes — what to say while a slide is up, not a transcript of
// what is already on it.
//
// The whole deck goes in one request rather than one call per slide: notes that
// were written independently repeat each other, and a presenter noticing the
// same sentence three times is the fastest way to stop trusting them.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const AUDIENCE = {
  general: 'a general audience',
  executives: 'senior executives who want the decision and the numbers',
  students: 'students meeting this topic for the first time',
  engineers: 'a technical audience who want mechanism and detail',
  customers: 'prospective customers weighing whether to buy',
};

function voiceLine(voice) {
  const traits = Array.isArray(voice)
    ? voice.filter((t) => typeof t === 'string' && t.trim()).slice(0, 6)
    : [];
  if (!traits.length) return '';
  return [
    "Speak in this person's own voice. These are their observed habits:",
    ...traits.map((t) => '- ' + String(t).slice(0, 140)),
  ].join('\n');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildPrompt({ topic, title, slides, audience, voice }) {
  const deck = slides
    .map((s, i) => `--- ${i + 1} ---\n${s}`)
    .join('\n\n');

  return `Deck: "${title}" — about ${topic}.

Here are its slides:

${deck}

Write the speaker notes for each one: what the presenter says while that slide
is on screen, for ${AUDIENCE[audience] || AUDIENCE.general}.

${voiceLine(voice)}

Rules:
- 40 to 70 words per slide. Spoken register, not written.
- Do not read the slide aloud. The audience can already see it. Say the thing
  that is not on it: why it matters, what it cost to find out, what to watch.
- Add no facts, figures or names that are not in the deck already.
- Where one slide leads to the next, say the sentence that gets you there.
- No stage directions, no "in this slide", no greetings.

Output exactly this, one block per slide, in order, and nothing else:

=== 1
<notes for slide 1>
=== 2
<notes for slide 2>`;
}

// The blocks come back keyed by number, and a missing one has to stay missing
// rather than shunting every later slide's notes onto the wrong slide.
function parseNotes(text, count) {
  const out = new Array(count).fill('');
  const parts = String(text).split(/^===\s*(\d+)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const index = parseInt(parts[i], 10) - 1;
    const value = String(parts[i + 1] || '').trim().replace(/\s*\n\s*/g, ' ');
    if (index >= 0 && index < count) out[index] = value.slice(0, 900);
  }
  return out;
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'invalid_request', message: 'Use POST.' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid_request', message: 'Body must be JSON.' }, 400);
  }

  const slides = Array.isArray(body.slides)
    ? body.slides.map((s) => String(s || '').slice(0, 900)).filter(Boolean)
    : [];
  if (!slides.length) {
    return json({ error: 'invalid_request', message: 'No slides sent.' }, 400);
  }
  if (slides.length > 30) {
    return json({ error: 'prompt_too_large', message: 'That is more slides than this writes at once.' }, 400);
  }

  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  const prompt = buildPrompt({
    topic: typeof body.topic === 'string' ? body.topic.slice(0, 300) : 'this deck',
    title: typeof body.title === 'string' ? body.title.slice(0, 120) : 'Untitled',
    slides,
    audience: body.audience,
    voice: body.voice,
  });

  let groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 260 * slides.length + 400,
        reasoning_effort: 'low',
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not reach the model.' }, 502);
  }

  if (groqRes.status === 429) return json({ error: 'rate_limited' }, 429);
  if (!groqRes.ok) {
    const detail = await groqRes.text().catch(() => '');
    return json({ error: 'upstream_error', message: detail.slice(0, 300) }, 502);
  }

  const completion = await groqRes.json();
  const content =
    completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : '';

  const notes = parseNotes(content, slides.length);
  if (!notes.some(Boolean)) return json({ error: 'empty_completion' }, 502);

  return json({ notes }, 200);
}

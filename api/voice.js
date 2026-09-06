// Reads samples of someone's own writing and returns their habits as
// instructions another writer could follow.
//
// The prompt insists on observable habits ("sentences average 12 words") and
// bans praise and vague adjectives ("engaging", "professional"), because a
// profile full of compliments tells the slide writer nothing it can act on.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_SAMPLE = 12000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

  const samples = typeof body.samples === 'string' ? body.samples.trim().slice(0, MAX_SAMPLE) : '';
  if (samples.length < 200) {
    return json({
      error: 'too_short',
      message: 'Paste a few paragraphs — a couple of sentences is not enough to read a voice from.',
    }, 400);
  }
  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  const prompt = `Below is writing by one person.

"""
${samples}
"""

Describe how this person writes, as instructions another writer could follow to
sound like them. Only state things you can actually observe in the text above.

Output up to 6 lines, exactly this shape and nothing else:

TRAIT: <one observable habit, under 15 words>

Cover whichever of these the text actually shows: typical sentence length, how
they open a point, contractions or not, first person or third, how they handle
numbers, particular words they reach for, punctuation habits, and anything they
conspicuously avoid.

Never write praise or vague adjectives like "engaging", "professional",
"compelling" or "clear" — those cannot be followed. Write habits, not compliments.`;

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
        temperature: 0.4,
        max_tokens: 900,
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
  if (!content) return json({ error: 'empty_completion' }, 502);

  const traits = [];
  for (const raw of String(content).split('\n')) {
    const match = raw.trim().match(/^TRAIT:\s*(.+)$/);
    if (match && match[1].trim()) traits.push(match[1].trim().slice(0, 140));
  }

  if (!traits.length) return json({ error: 'invalid_json', message: 'No usable traits.' }, 502);
  return json({ traits: traits.slice(0, 6) }, 200);
}

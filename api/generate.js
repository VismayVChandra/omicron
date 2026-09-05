// Streaming deck generation. Runs on Vercel's Edge runtime so the response
// can be piped to the browser as it is written, rather than buffered.
//
// Groq returns OpenAI-style SSE. Reasoning models put their hidden thinking
// on delta.reasoning and the real answer on delta.content, so only content
// is forwarded. The client parses the line-based format below incrementally,
// which is why this is plain text rather than one JSON blob.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SURFACE_NOUN = {
  deck: 'a slide-by-slide outline for a pitch deck',
  doc: 'a section-by-section outline for a long-form document',
  site: 'the section-by-section content for a one-page website',
};

function buildPrompt(topic, surface) {
  const noun = SURFACE_NOUN[surface] || SURFACE_NOUN.deck;
  return `Draft ${noun} about: "${topic}".

Reply in EXACTLY this plain-text format and nothing else:

TITLE: <short punchy title, under 6 words>
TAGLINE: <one sentence subtitle>
===
LAYOUT: bullets
HEADING: <heading, under 6 words>
BULLET: <point, under 14 words>
BULLET: <point, under 14 words>
===
LAYOUT: stat
HEADING: <heading, under 6 words>
BULLET: <one striking number or metric, under 8 words>
BULLET: <supporting point, under 14 words>

Rules:
- Write 4 to 6 slides after the cover. Begin every slide with a line of exactly ===
- LAYOUT is one of: bullets, stat, quote
- Use stat for a slide built around a single number. Use quote for a slide built
  around one memorable line, where BULLET is the line and HEADING is who said it.
  Use bullets for everything else.
- At most one stat slide and at most one quote slide per deck.
- bullets: 2 to 4 BULLET lines. stat: exactly 2. quote: exactly 1.
- No markdown, no blank lines, no commentary before or after.`;
}

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

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) return json({ error: 'invalid_request', message: 'Missing topic.' }, 400);
  if (topic.length > 500) return json({ error: 'prompt_too_large', message: 'Topic is too long.' }, 400);

  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

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
        messages: [{ role: 'user', content: buildPrompt(topic, body.surface) }],
        temperature: 0.8,
        max_tokens: 1200,
        reasoning_effort: 'low',
        stream: true,
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not reach the model.' }, 502);
  }

  if (groqRes.status === 429) return json({ error: 'rate_limited' }, 429);
  if (!groqRes.ok || !groqRes.body) {
    const detail = await groqRes.text().catch(() => '');
    return json({ error: 'upstream_error', message: detail.slice(0, 300) }, 502);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = groqRes.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch (e) {
              continue;
            }
            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
            const text = delta && delta.content;
            if (text) controller.enqueue(encoder.encode(text));
          }
        }
      } catch (e) {
        controller.enqueue(new TextEncoder().encode('\nERROR: upstream_error\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

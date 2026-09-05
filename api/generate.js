// Vercel serverless function: drafts deck/doc/site content with Groq's
// free-tier Llama 3.3 API. The API key lives only in the GROQ_API_KEY
// environment variable on Vercel — it never reaches the browser.

const SURFACE_NOUN = {
  deck: 'a slide-by-slide outline for a pitch deck',
  doc: 'a section-by-section outline for a long-form document',
  site: 'the section-by-section content for a one-page website',
};

function buildPrompt(topic, surface) {
  const noun = SURFACE_NOUN[surface] || SURFACE_NOUN.deck;
  return (
    `Draft ${noun} about: "${topic}".\n\n` +
    'Reply with ONLY a JSON object, no other text, in exactly this shape:\n' +
    '{"title": string (a short punchy title, under 6 words), ' +
    '"tagline": string (one sentence subtitle), ' +
    '"blocks": [ {"heading": string (under 6 words), "body": string (1-2 sentences, under 30 words)}, ... ] }\n\n' +
    'Include between 4 and 6 blocks, ordered the way they should appear.'
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_request', message: 'Use POST.' });
    return;
  }

  const { topic, surface } = req.body || {};
  if (typeof topic !== 'string' || !topic.trim()) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing topic.' });
    return;
  }
  if (topic.length > 500) {
    res.status(400).json({ error: 'prompt_too_large', message: 'Topic is too long.' });
    return;
  }

  if (!process.env.GROQ_API_KEY) {
    res.status(500).json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' });
    return;
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: buildPrompt(topic.trim(), surface) }],
        temperature: 0.7,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
    });

    if (groqRes.status === 429) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => '');
      res.status(502).json({ error: 'upstream_error', message: detail.slice(0, 300) });
      return;
    }

    const completion = await groqRes.json();
    const content = completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
    if (!content) {
      res.status(502).json({ error: 'empty_completion' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      res.status(502).json({ error: 'invalid_json' });
      return;
    }

    if (typeof parsed.title !== 'string' || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      res.status(502).json({ error: 'invalid_json' });
      return;
    }

    res.status(200).json({
      title: parsed.title,
      tagline: typeof parsed.tagline === 'string' ? parsed.tagline : '',
      blocks: parsed.blocks.slice(0, 6).map((b) => ({
        heading: typeof b.heading === 'string' ? b.heading : '',
        body: typeof b.body === 'string' ? b.body : '',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'upstream_error', message: String(e && e.message || e) });
  }
};

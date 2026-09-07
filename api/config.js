// Hands the browser the public Supabase settings, so they come from Vercel's
// environment rather than being committed to the repo.
//
// The anon key is designed to be published — it carries no privileges of its
// own, and every table is guarded by row level security, so a signed-in user
// can only ever read and write their own rows. The service role key must never
// appear here or anywhere else the browser can reach.
//
// When the variables are absent this returns { enabled: false } and the site
// runs exactly as it did before accounts existed: drafts in localStorage, this
// browser only.

export const config = { runtime: 'edge' };

// Which image generator, if any, is configured. Only the name goes to the
// browser — never the key — and it is here so the editor can hide the Generate
// button rather than offer something that will answer 501.
function imageProvider() {
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) return 'cloudflare';
  if (process.env.TOGETHER_API_KEY) return 'together';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

export default async function handler() {
  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const enabled = Boolean(url && anonKey);
  const imagegen = imageProvider();

  return new Response(
    JSON.stringify(Object.assign(
      enabled ? { enabled: true, url, anonKey } : { enabled: false },
      { imagegen: imagegen || false }
    )),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // public but short-lived, so flipping the env vars takes effect quickly
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    }
  );
}

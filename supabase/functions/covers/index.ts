// Looks up official box art on IGDB for up to 10 games per call.
// Needs two secrets in Supabase (Edge Functions → Secrets): TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.
// Body: { games: [{ id, title, year }] }  →  { covers: { [id]: url | null } }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let token: { value: string; expires: number } | null = null;
async function twitchToken(id: string, secret: string) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`, { method: "POST" });
  if (!r.ok) throw new Error(`Twitch sign-in failed (${r.status}). Check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.`);
  const d = await r.json();
  token = { value: d.access_token, expires: Date.now() + d.expires_in * 1000 };
  return token.value;
}

const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[™®©]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim().split(" ").map((w) => ROMAN[w] || w).join(" ");

type Hit = { name: string; first_release_date?: number; cover?: { image_id: string }; version_parent?: number };
function pick(hits: Hit[], title: string, year?: number | null): Hit | null {
  hits = hits.filter((h) => h.cover?.image_id);
  if (!hits.length) return null;
  const t = norm(title);
  const yr = (h: Hit) => (h.first_release_date ? new Date(h.first_release_date * 1000).getUTCFullYear() : null);
  const score = (h: Hit) => {
    const n = norm(h.name);
    let s = n === t ? 100 : n.startsWith(t) || t.startsWith(n) ? 40 : n.includes(t) || t.includes(n) ? 20 : 0;
    if (year && yr(h)) s += Math.max(0, 10 - 3 * Math.abs(yr(h)! - year));
    if (!h.version_parent) s += 5;
    return s;
  };
  const best = hits.map((h) => [score(h), h] as const).sort((a, b) => b[0] - a[0])[0];
  return best[0] >= 20 ? best[1] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Only a signed-in user may use this (the public app key alone isn't enough).
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role !== "authenticated") return json({ error: "Sign in first" }, 401);
  } catch { return json({ error: "Sign in first" }, 401); }
  const id = Deno.env.get("TWITCH_CLIENT_ID"), secret = Deno.env.get("TWITCH_CLIENT_SECRET");
  if (!id || !secret) return json({ error: "NO_KEYS" }, 503);
  try {
    const { games } = await req.json();
    if (!Array.isArray(games) || !games.length || games.length > 10) return json({ error: "Send 1–10 games" }, 400);
    const tok = await twitchToken(id, secret);
    const q = games.map((g: { title: string }, i: number) =>
      `query games "${i}" { search "${String(g.title).replace(/["\\]/g, " ").slice(0, 120)}"; fields name,first_release_date,cover.image_id,version_parent; limit 10; };`).join("\n");
    const r = await fetch("https://api.igdb.com/v4/multiquery", { method: "POST", headers: { "Client-ID": id, Authorization: `Bearer ${tok}` }, body: q });
    if (!r.ok) return json({ error: `IGDB error ${r.status}` }, 502);
    const res: { name: string; result: Hit[] }[] = await r.json();
    const covers: Record<string, string | null> = {};
    games.forEach((g: { id: string; title: string; year?: number }, i: number) => {
      const hit = pick(res.find((x) => x.name === String(i))?.result || [], g.title, g.year);
      covers[g.id] = hit ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${hit.cover!.image_id}.jpg` : null;
    });
    return json({ covers });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

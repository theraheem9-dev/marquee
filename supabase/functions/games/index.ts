// Game search and game details from IGDB (run by Twitch). Much faster than RAWG search.
// Uses the same two Supabase secrets as the "covers" function: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.
// Body: { search: "zelda" }  →  { results: [Game] }
//       { id: "1942" }       →  { game: GameDetails }

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

type Named = { name: string };
type Raw = {
  id: number; name: string; first_release_date?: number; summary?: string;
  cover?: { image_id: string }; artworks?: { image_id: string }[]; screenshots?: { image_id: string }[];
  genres?: Named[]; platforms?: Named[]; involved_companies?: { developer?: boolean; company?: Named }[];
};
const img = (id: string | undefined, size: string) => (id ? `https://images.igdb.com/igdb/image/upload/${size}/${id}.jpg` : null);
const isoDate = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
const basic = (g: Raw) => ({
  id: String(g.id), title: g.name, year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
  poster: img(g.cover?.image_id, "t_cover_big"), release_date: isoDate(g.first_release_date),
  genres: (g.genres || []).map((x) => x.name),
});
const clean = (s: string) => String(s).replace(/["\\]/g, " ").slice(0, 120).trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Only a signed-in user may use this (the public app key alone isn't enough).
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role !== "authenticated") return json({ error: "Sign in first" }, 401);
  } catch { return json({ error: "Sign in first" }, 401); }
  const cid = Deno.env.get("TWITCH_CLIENT_ID"), secret = Deno.env.get("TWITCH_CLIENT_SECRET");
  if (!cid || !secret) return json({ error: "NO_KEYS" }, 503);
  try {
    const body = await req.json();
    const igdb = async (q: string): Promise<Raw[]> => {
      const tok = await twitchToken(cid, secret);
      const r = await fetch("https://api.igdb.com/v4/games", { method: "POST", headers: { "Client-ID": cid, Authorization: `Bearer ${tok}` }, body: q });
      if (!r.ok) throw new Error(`IGDB error ${r.status}`);
      return r.json();
    };
    if (typeof body.search === "string" && clean(body.search)) {
      // version_parent = null leaves out "Deluxe Edition"-style duplicates of the same game
      const rows = await igdb(`search "${clean(body.search)}"; fields name,first_release_date,cover.image_id,genres.name; where version_parent = null; limit 20;`);
      return json({ results: rows.map(basic) });
    }
    if (/^\d+$/.test(String(body.id || ""))) {
      const [g] = await igdb(`where id = ${body.id}; fields name,summary,first_release_date,cover.image_id,artworks.image_id,screenshots.image_id,genres.name,platforms.name,involved_companies.developer,involved_companies.company.name; limit 1;`);
      if (!g) return json({ error: "Game not found on IGDB" }, 404);
      return json({ game: {
        ...basic(g), overview: g.summary || "",
        backdrop: img(g.artworks?.[0]?.image_id || g.screenshots?.[0]?.image_id, "t_1080p"),
        platforms: (g.platforms || []).map((p) => p.name),
        developers: (g.involved_companies || []).filter((c) => c.developer && c.company).map((c) => c.company!.name),
      } });
    }
    return json({ error: "Send { search } or { id }" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

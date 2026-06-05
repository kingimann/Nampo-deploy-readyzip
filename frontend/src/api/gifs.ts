/**
 * GIF search via Tenor v2. Requires EXPO_PUBLIC_TENOR_KEY (free key from
 * https://developers.google.com/tenor). Without a key, search returns [].
 */
const TENOR_KEY = process.env.EXPO_PUBLIC_TENOR_KEY as string | undefined;

export const GIFS_ENABLED = !!TENOR_KEY;

export type Gif = { id: string; url: string; preview: string };

export async function searchGifs(query: string): Promise<Gif[]> {
  if (!TENOR_KEY) return [];
  const base = "https://tenor.googleapis.com/v2/";
  const path = query.trim()
    ? `search?q=${encodeURIComponent(query.trim())}&`
    : "featured?";
  const url = `${base}${path}key=${TENOR_KEY}&client_key=nampo&limit=24&media_filter=gif,tinygif`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.results || [])
      .map((r: any) => ({
        id: r.id,
        url: r.media_formats?.gif?.url || r.media_formats?.tinygif?.url || "",
        preview: r.media_formats?.tinygif?.url || r.media_formats?.gif?.url || "",
      }))
      .filter((g: Gif) => g.url);
  } catch {
    return [];
  }
}

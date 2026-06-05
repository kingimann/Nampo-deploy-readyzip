import { Platform } from "react-native";

export type Embed = { url: string; aspect: number };

// Twitch requires the embedding domain(s) as `parent`. On web we know it; on
// native we pass the deployed web host as a best-effort (Twitch is strict here).
function twitchParents(): string {
  const hosts =
    Platform.OS === "web" && typeof window !== "undefined" && window.location?.hostname
      ? [window.location.hostname]
      : ["nampo-web.onrender.com", "localhost"];
  return hosts.map((h) => `parent=${h}`).join("&");
}

/**
 * Detect an embeddable video link (YouTube, Twitch, Vimeo) in text and return
 * its player URL + aspect ratio, or null. First match wins.
 */
export function getEmbed(text?: string | null): Embed | null {
  if (!text) return null;
  let m: RegExpMatchArray | null;

  if ((m = text.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/))) {
    return { url: `https://www.youtube.com/embed/${m[1]}?playsinline=1&rel=0`, aspect: 16 / 9 };
  }
  if ((m = text.match(/vimeo\.com\/(?:video\/)?(\d+)/))) {
    return { url: `https://player.vimeo.com/video/${m[1]}`, aspect: 16 / 9 };
  }

  const parents = twitchParents();
  if ((m = text.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/)) ||
      (m = text.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/))) {
    return { url: `https://clips.twitch.tv/embed?clip=${m[1]}&${parents}&autoplay=false`, aspect: 16 / 9 };
  }
  if ((m = text.match(/twitch\.tv\/videos\/(\d+)/))) {
    return { url: `https://player.twitch.tv/?video=${m[1]}&${parents}&autoplay=false`, aspect: 16 / 9 };
  }
  if ((m = text.match(/twitch\.tv\/([A-Za-z0-9_]{2,30})(?:[/?]|$|\s)/))) {
    const ch = m[1].toLowerCase();
    if (!["videos", "directory", "p", "downloads", "jobs", "settings", "subscriptions"].includes(ch)) {
      return { url: `https://player.twitch.tv/?channel=${m[1]}&${parents}&autoplay=false`, aspect: 16 / 9 };
    }
  }
  return null;
}

/**
 * Detect an image/GIF link in text (direct files, imgur, giphy) and return a
 * directly-renderable image URL, or null. Used to show images/GIFs inline in
 * posts and comments.
 */
export function getInlineImage(text?: string | null): string | null {
  if (!text) return null;
  let m: RegExpMatchArray | null;
  // Direct image/gif file URL.
  if ((m = text.match(/https?:\/\/[^\s]+?\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?/i))) return m[0];
  // Giphy share or media link → direct gif.
  if ((m = text.match(/media\.giphy\.com\/media\/([A-Za-z0-9]+)/))) return `https://media.giphy.com/media/${m[1]}/giphy.gif`;
  if ((m = text.match(/giphy\.com\/gifs\/[\w-]*?-([A-Za-z0-9]{6,})(?:[/?\s]|$)/))) return `https://media.giphy.com/media/${m[1]}/giphy.gif`;
  // Imgur single image page → direct file (skip albums/galleries).
  if ((m = text.match(/(?:i\.)?imgur\.com\/(?!a\/|gallery\/)([A-Za-z0-9]{5,})(?:\.(?:png|jpe?g|gif|webp))?/))) return `https://i.imgur.com/${m[1]}.png`;
  return null;
}

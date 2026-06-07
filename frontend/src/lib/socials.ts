// Social-media platforms shown on profiles, plus a couple of date helpers.

export type SocialPlatform = {
  key: string;
  label: string;
  icon: string;        // Ionicons logo name
  color: string;
  prefix: string;      // shown before the handle input (e.g. "@")
  base: (handle: string) => string;
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  { key: "instagram", label: "Instagram", icon: "logo-instagram", color: "#E1306C", prefix: "@", base: (h) => `https://instagram.com/${h}` },
  { key: "twitter",   label: "X / Twitter", icon: "logo-twitter", color: "#1DA1F2", prefix: "@", base: (h) => `https://twitter.com/${h}` },
  { key: "tiktok",    label: "TikTok",    icon: "logo-tiktok",    color: "#ffffff", prefix: "@", base: (h) => `https://tiktok.com/@${h}` },
  { key: "youtube",   label: "YouTube",   icon: "logo-youtube",   color: "#FF0000", prefix: "@", base: (h) => `https://youtube.com/@${h}` },
  { key: "facebook",  label: "Facebook",  icon: "logo-facebook",  color: "#1877F2", prefix: "",  base: (h) => `https://facebook.com/${h}` },
  { key: "snapchat",  label: "Snapchat",  icon: "logo-snapchat",  color: "#FFFC00", prefix: "@", base: (h) => `https://snapchat.com/add/${h}` },
  { key: "linkedin",  label: "LinkedIn",  icon: "logo-linkedin",  color: "#0A66C2", prefix: "",  base: (h) => `https://linkedin.com/in/${h}` },
  { key: "github",    label: "GitHub",    icon: "logo-github",    color: "#ffffff", prefix: "",  base: (h) => `https://github.com/${h}` },
];

export const SOCIAL_BY_KEY: Record<string, SocialPlatform> =
  Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p.key, p]));

/** Turn a stored handle/url into an openable URL. */
export function socialUrl(key: string, value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  const p = SOCIAL_BY_KEY[key];
  const handle = v.replace(/^@/, "");
  return p ? p.base(handle) : v;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** Format a YYYY-MM-DD birthday as "June 7, 2000". Returns "" if invalid. */
export function fmtBirthday(iso?: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "";
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

export { MONTHS };

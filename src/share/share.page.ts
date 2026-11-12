import type { PlaceDto } from '../places/places.service.js';

/**
 * The page a shared place link opens when Stoop is not installed (with Stoop installed, iOS opens
 * the app instead). Plain HTML, no scripts. Only the place itself is shown: no ratings text, no
 * people, no photos, so a link shows strangers nothing about anyone.
 */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const copy = {
  en: {
    dir: 'ltr',
    open: 'Open in Stoop',
    google: 'Open in Google Maps',
    apple: 'Open in Apple Maps',
    noRatings: 'No ratings yet',
    ratings: (n: number) => (n === 1 ? '1 rating' : `${n} ratings`),
    tagline: 'Rated by friends on Stoop',
    missing: 'This place isn’t on Stoop',
    missingBody: 'The link may be wrong or out of date.',
  },
  ar: {
    dir: 'rtl',
    open: 'افتح في Stoop',
    google: 'افتح في خرائط Google',
    apple: 'افتح في خرائط Apple',
    noRatings: 'لا تقييمات بعد',
    ratings: (n: number) => (n === 1 ? 'تقييم واحد' : `${n} تقييمات`),
    tagline: 'قيّمه الأصدقاء على Stoop',
    missing: 'هذا المكان غير موجود على Stoop',
    missingBody: 'قد يكون الرابط خاطئًا أو قديمًا.',
  },
} as const;

export type ShareLanguage = keyof typeof copy;

/** Arabic when the browser prefers it, English otherwise. */
export function shareLanguage(acceptLanguage: string | undefined): ShareLanguage {
  return acceptLanguage?.trim().toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** `MKPOICategoryFoodMarket` -> `Food market`; anything else as it came. */
export function categoryLabel(category: string | null): string | null {
  if (!category) return null;
  const words = category.replace(/^MKPOICategory/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

export function googleMapsUrl(place: Pick<PlaceDto, 'latitude' | 'longitude'>): string {
  return `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}`;
}

export function appleMapsUrl(place: Pick<PlaceDto, 'latitude' | 'longitude' | 'name'>): string {
  return `https://maps.apple.com/?ll=${place.latitude},${place.longitude}&q=${encodeURIComponent(place.name)}`;
}

/** What WhatsApp, Instagram and iMessage show under the link. */
export function summary(place: PlaceDto, lang: ShareLanguage): string {
  const t = copy[lang];
  const rating = place.ratingCount > 0 ? `★ ${place.avgRating.toFixed(1)} · ${t.ratings(place.ratingCount)}` : t.noRatings;
  return [rating, categoryLabel(place.category)].filter(Boolean).join(' · ');
}

function layout(lang: ShareLanguage, title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}" dir="${copy[lang].dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
<style>
  :root { --bg: #f7f3e8; --fg: #12233f; --muted: #4a5a75; --accent: #b87a00; --card: #fffdf7; --line: #d9d2bd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1a2e; --fg: #f3eee0; --muted: #a9b4c8; --accent: #f0b429; --card: #17243d; --line: #2a3a58; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 24px 16px; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 28px 24px; }
  .brand { font-weight: 800; letter-spacing: .02em; color: var(--accent); margin: 0 0 18px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; }
  .meta { color: var(--muted); margin: 0 0 22px; }
  a.button { display: block; text-align: center; text-decoration: none; font-weight: 600; padding: 13px 16px;
             border-radius: 14px; margin-top: 10px; border: 1px solid var(--line); color: var(--fg); }
  a.primary { background: var(--accent); border-color: var(--accent); color: #12233f; }
  .tag { color: var(--muted); font-size: 14px; margin: 20px 0 0; text-align: center; }
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

export function placePage(place: PlaceDto, pageUrl: string, lang: ShareLanguage): string {
  const t = copy[lang];
  const name = escapeHtml(place.name);
  const meta = escapeHtml(summary(place, lang));
  const head = [
    `<meta name="description" content="${meta}">`,
    `<meta property="og:type" content="place">`,
    `<meta property="og:site_name" content="Stoop">`,
    `<meta property="og:title" content="${name}">`,
    `<meta property="og:description" content="${meta}">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    `<meta property="place:location:latitude" content="${place.latitude}">`,
    `<meta property="place:location:longitude" content="${place.longitude}">`,
    `<meta name="twitter:card" content="summary">`,
  ].join('\n');
  const body = `
  <p class="brand">Stoop</p>
  <h1>${name}</h1>
  <p class="meta">${meta}</p>
  <a class="button primary" href="stoop://place/${place.id}">${t.open}</a>
  <a class="button" href="${escapeHtml(googleMapsUrl(place))}">${t.google}</a>
  <a class="button" href="${escapeHtml(appleMapsUrl(place))}">${t.apple}</a>
  <p class="tag">${t.tagline}</p>`;
  return layout(lang, `${name} · Stoop`, head, body);
}

export function missingPage(lang: ShareLanguage): string {
  const t = copy[lang];
  return layout(lang, 'Stoop', '<meta name="robots" content="noindex">', `
  <p class="brand">Stoop</p>
  <h1>${t.missing}</h1>
  <p class="meta">${t.missingBody}</p>`);
}

import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const baseUrl = 'https://ww1.yesmovies.ag';

function base64UrlEncode(str: string) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeUtf8(str: string) {
  return new TextEncoder().encode(str);
}

async function encox(plaintext: string, pwd: string): Promise<string> {
  const pwdData = encodeUtf8(pwd);
  const pwHash = await crypto.subtle.digest('SHA-256', pwdData);

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await crypto.subtle.importKey('raw', pwHash, { name: 'AES-GCM' }, false, ['encrypt']);

  const plaintextData = encodeUtf8(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextData);

  // Web Crypto API includes the auth tag in the encrypted output for GCM
  const encryptedArray = new Uint8Array(encrypted);
  const full = new Uint8Array(iv.length + encryptedArray.length);
  full.set(iv);
  full.set(encryptedArray, iv.length);

  return btoa(String.fromCharCode(...full));
}

async function generateDynamicHashURL(
  mid: string,
  eid: string,
  sv: string,
  plyURL: string,
  ctx: ShowScrapeContext | MovieScrapeContext,
): Promise<string> {
  const traceRes = await ctx.proxiedFetcher<string>('https://www.cloudflare.com/cdn-cgi/trace/');
  const locMatch = traceRes.match(/^loc=(\w{2})/m);
  const countryCode = locMatch ? locMatch[1] : 'US';

  const timestamp = Math.floor(Date.now() / 1000);

  const plaintextPayload = `${mid}+${eid}+${sv}+${countryCode}+${timestamp}`;

  const encryptedData = await encox(plaintextPayload, countryCode);

  const uriEncoded = base64UrlEncode(encryptedData);

  const basePlayerURL = atob(plyURL);
  const finalURL = `${basePlayerURL}/watch/?v${sv}${eid}#${uriEncoded}`;

  return finalURL;
}

async function comboScraper(ctx: ShowScrapeContext | MovieScrapeContext): Promise<SourcererOutput> {
  const query = ctx.media.title.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '+');
  const results = await ctx.proxiedFetcher(`${baseUrl}/searching?q=${query}&limit=60&offset=0`);

  let data: { t: string; s: string; e: number; n: number }[];
  if (results && results.data && Array.isArray(results.data)) {
    data = results.data;
  } else if (Array.isArray(results)) {
    data = results;
  } else {
    throw new NotFoundError('Invalid search response');
  }

  let constructedSlug: string;
  if (ctx.media.type === 'show') {
    constructedSlug = `${ctx.media.title} - Season ${ctx.media.season.number}`;
  } else {
    constructedSlug = ctx.media.title;
  }
  const selectedSlug = data.filter((e) => e.t === constructedSlug)[0];
  const idMatch = selectedSlug?.s.match(/-(\d+)$/);
  const id = idMatch ? idMatch[1] : null;
  if (id === null) {
    throw new NotFoundError('No id found');
  }

  ctx.progress(20);
  let embedUrl;
  if (ctx.media.type === 'show') {
    embedUrl = await generateDynamicHashURL(
      id,
      ctx.media.episode.number.toString(),
      '1',
      'aHR0cHM6Ly9tb3Z1bmEueHl6',
      ctx,
    );
  } else {
    embedUrl = await generateDynamicHashURL(id, '1', '1', 'aHR0cHM6Ly9tb3Z1bmEueHl6', ctx);
  }

  return {
    embeds: [
      {
        embedId: 'movuna',
        url: embedUrl,
      },
    ],
  };
}

export const yesmoviesScraper = makeSourcerer({
  id: 'yesmovies',
  name: 'YesMovies',
  rank: 173,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});

import { flags } from '@/entrypoint/utils/targets';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

import { makeEmbed } from '../base';

const VIDNEST_SERVERS = ['allmovies', 'hollymoviehd'] as const;

const baseUrl = 'https://new.vidnest.fun';
const PASSPHRASE = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=';

const serverConfigs: Record<string, { streamDomains: string[] | null; origin: string; referer: string }> = {
  hollymoviehd: {
    streamDomains: ['pkaystream.cc', 'flashstream.cc'],
    origin: 'https://flashstream.cc',
    referer: 'https://flashstream.cc/',
  },
  allmovies: {
    streamDomains: null,
    origin: '',
    referer: '',
  },
};

function customBase64Decode(data: string, alphabet: string): string {
  const charMap: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i++) {
    charMap[alphabet[i]] = i;
  }
  const bytes: number[] = [];

  for (let i = 0; i < data.length; i += 4) {
    let chunk = data.slice(i, i + 4);
    while (chunk.length < 4) chunk += '=';
    const idxs = [];
    for (let j = 0; j < 4; j++) {
      const val = charMap[chunk[j]];
      idxs.push(val !== undefined ? val : 64);
    }
    bytes.push((idxs[0] << 2) | (idxs[1] >> 4));
    if (idxs[2] !== 64) {
      bytes.push(((idxs[1] & 15) << 4) | (idxs[2] >> 2));
    }
    if (idxs[3] !== 64) {
      bytes.push(((idxs[2] & 3) << 6) | idxs[3]);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}
async function decryptVidnestData(encryptedBase64: string): Promise<any> {
  const decoded = customBase64Decode(encryptedBase64, PASSPHRASE);

  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

export function makeVidnestEmbed(id: string, rank: number = 100) {
  const config = serverConfigs[id];

  return makeEmbed({
    id: `vidnest-${id}`,
    name: `Vidnest ${id}`,
    rank,
    disabled: false,
    flags: [flags.CORS_ALLOWED],
    async scrape(ctx) {
      const query = JSON.parse(ctx.url);
      const { type, tmdbId, season, episode } = query;

      const endpoint = type === 'movie' ? `/${id}/movie/${tmdbId}` : `/${id}/tv/${tmdbId}/${season}/${episode}`;

      const res = await ctx.proxiedFetcher<{ data?: string }>(endpoint, {
        baseUrl,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (!res?.data) throw new NotFoundError('No data');

      const decrypted = await decryptVidnestData(res.data);
      const sources = decrypted.sources || decrypted.streams || [];

      const streams: string[] = [];
      for (const source of sources) {
        const url = source.file || source.url;
        if (!url) continue;
        if (config?.streamDomains && !config.streamDomains.some((d) => url.includes(d))) continue;
        streams.push(url);
      }

      if (!streams.length) throw new NotFoundError('No streams');

      ctx.progress(100);

      return {
        stream: [
          {
            id,
            type: 'hls',
            playlist: createM3U8ProxyUrl(streams[0], ctx.features, {
              Origin: config?.origin,
              Referer: config?.referer,
            }),
            headers: {
              Origin: config?.origin,
              Referer: config?.referer,
            },
            flags: [flags.CORS_ALLOWED],
            captions: [],
          },
        ],
      };
    },
  });
}

export const VidnestEmbeds = VIDNEST_SERVERS.map((server, i) => makeVidnestEmbed(server, 104 - i));

import { flags } from '@/entrypoint/utils/targets';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

import { SourcererOutput, makeSourcerer } from '../base';

const baseUrl = 'https://mapple.tv';
const encryptionKey = 'nanananananananananananaBatman!';

function encryptData(urlStr: string): string {
  const payload = JSON.stringify({
    url: urlStr,
    timestamp: Date.now(),
  });

  const encoded = encodeURIComponent(payload);
  let xoredStr = '';

  for (let i = 0; i < encoded.length; i++) {
    xoredStr += String.fromCharCode(encoded.charCodeAt(i) ^ encryptionKey.charCodeAt(i % encryptionKey.length));
  }

  return btoa(xoredStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const universalScraper = async (ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> => {
  let requestData: Record<string, string | number> = {};

  if (ctx.media.type === 'movie') {
    requestData = {
      mediaId: Number(ctx.media.tmdbId),
      mediaType: 'movie',
      source: 'mapple',
      tv_slug: '',
    };
  } else {
    requestData = {
      mediaId: Number(ctx.media.tmdbId),
      mediaType: 'tv',
      source: 'mapple',
      tv_slug: `${ctx.media.season.number}-${ctx.media.episode.number}`,
    };
  }

  const dataStr = JSON.stringify(requestData);
  const encryptedData = encryptData(dataStr);
  const apiPath = `/api/stream-encrypted?data=${encryptedData}`;
  const headers = {
    Referer: baseUrl,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const apiResponse = await ctx.proxiedFetcher<{ success: boolean; error?: string; data?: { stream_url: string } }>(
    apiPath,
    {
      baseUrl,
      headers,
    },
  );

  if (!apiResponse || apiResponse.success === false) {
    throw new NotFoundError(`Mapple API Error: ${apiResponse?.error || 'Failed to fetch stream data'}`);
  }

  const streamUrl = apiResponse.data?.stream_url;
  if (!streamUrl) throw new NotFoundError('API response missing stream URL');

  return {
    embeds: [],
    stream: [
      {
        id: 'primary',
        type: 'hls',
        playlist: createM3U8ProxyUrl(streamUrl, ctx.features, headers),
        flags: [flags.CORS_ALLOWED],
        captions: [],
      },
    ],
  };
};

export const mappleScraper = makeSourcerer({
  id: 'mapple',
  name: 'Mapple',
  rank: 15,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper,
  scrapeShow: universalScraper,
});

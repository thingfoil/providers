import { load } from 'cheerio';

import { flags } from '@/entrypoint/utils/targets';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

import { SourcererOutput, makeSourcerer } from '../base';

const baseUrl = 'https://vixsrc.to';

const universalScraper = async (ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> => {
  let apiPath = '';
  if (ctx.media.type === 'movie') {
    apiPath = `api/movie/${ctx.media.tmdbId}`;
  } else {
    apiPath = `api/tv/${ctx.media.tmdbId}/${ctx.media.season.number}/${ctx.media.episode.number}`;
  }

  const providerLang = 'en';
  apiPath += `?lang=${providerLang}`;

  const headers = {
    Referer: baseUrl,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const apiResponse = await ctx.proxiedFetcher<{ src: string }>(apiPath, {
    baseUrl,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: baseUrl,
    },
  });

  if (!apiResponse?.src) throw new NotFoundError('API response missing source path');

  const embedPath = apiResponse.src.replace(/^\//, '');
  const embedPage = await ctx.proxiedFetcher<string>(embedPath, {
    baseUrl,
    headers,
  });

  const $ = load(embedPage);
  const scriptText = $('script').text();

  const videoId = scriptText.match(/id:\s*'([^']+)'/)?.[1];
  const token = scriptText.match(/'token':\s*'([^']+)'/)?.[1];
  const expires = scriptText.match(/'expires':\s*'([^']+)'/)?.[1];
  const hasBParam = scriptText.includes('url:') && scriptText.includes('b=1');
  const canPlayFHD = scriptText.includes('window.canPlayFHD = true');

  if (!videoId || !token || !expires) throw new NotFoundError('Failed to extract stream metadata');

  const masterParams = new URLSearchParams({
    token,
    expires,
    lang: providerLang,
  });

  // if (hasBParam) masterParams.append('b', '1');
  if (canPlayFHD) masterParams.append('h', '1');

  const finalUrl = `${baseUrl}/playlist/${videoId}?${masterParams.toString()}`;

  return {
    embeds: [],
    stream: [
      {
        id: 'primary',
        type: 'hls',
        playlist: createM3U8ProxyUrl(finalUrl, ctx.features, headers),
        flags: [flags.CORS_ALLOWED],
        captions: [],
      },
    ],
  };
};

export const vixSrcScraper = makeSourcerer({
  id: 'vixsrc',
  name: 'VixSrc',
  rank: 2,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: universalScraper,
  scrapeShow: universalScraper,
});

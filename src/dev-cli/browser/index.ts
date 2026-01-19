import { makeProviders, makeStandardFetcher, targets } from '../../../lib/index.js';

async function scrape(proxy: string, type: 'embed' | 'source', input: any) {
  // Set up proxy if provided
  let fetcher = makeStandardFetcher(fetch);
  if (proxy) {
    fetcher = makeStandardFetcher(async (url: string, options?: RequestInit) => {
      const response = await fetch(proxy, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          options,
        }),
        mode: 'no-cors',
      });
      const data = await response.json();
      return new Response(data.body, {
        status: data.status,
        statusText: data.statusText,
        headers: data.headers,
      });
    });
  }

  const providers = makeProviders({
    fetcher,
    target: targets.ANY,
  });

  if (type === 'embed') {
    return providers.runEmbedScraper({
      disableOpensubtitles: true,
      url: input.url,
      id: input.id,
    });
  }
  if (type === 'source') {
    return providers.runSourceScraper({
      disableOpensubtitles: true,
      media: input.media,
      id: input.id,
    });
  }

  throw new Error('Invalid scrape type');
}

(window as any).scrape = scrape;

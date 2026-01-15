import { flags } from '@/entrypoint/utils/targets';
import { makeEmbed } from '@/providers/base';
import { HlsBasedStream } from '@/providers/streams';
import { NotFoundError } from '@/utils/errors';

const PASSPHRASE = 'A7kP9mQeXU2BWcD4fRZV+Sg8yN0/M5tLbC1HJQwYe6pOKFaE3vTnPZsRuYdVmLq2';

async function decryptVidnestData(encryptedBase64: string): Promise<any> {
  const encryptedBytes = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0));

  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12, -16);
  const tag = encryptedBytes.slice(-16);

  const keyData = Uint8Array.from(atob(PASSPHRASE), (c) => c.charCodeAt(0)).slice(0, 32);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);

  const encrypted = new Uint8Array([...ciphertext, ...tag]);

  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);

    const decryptedText = new TextDecoder().decode(decrypted);
    return JSON.parse(decryptedText);
  } catch (error) {
    throw new NotFoundError('Failed to decrypt data');
  }
}

export const vidnestHollymoviehdEmbed = makeEmbed({
  id: 'vidnest-hollymoviehd',
  name: 'Vidnest HollyMovie',
  rank: 104,
  flags: [],
  disabled: false,
  async scrape(ctx) {
    const response = await ctx.proxiedFetcher<any>(ctx.url);
    if (!response.data) throw new NotFoundError('No encrypted data found');

    const decryptedData = await decryptVidnestData(response.data);
    if (!decryptedData.success && !decryptedData.sources) throw new NotFoundError('No streams found');

    const sources = decryptedData.sources || decryptedData.streams;
    const streams: HlsBasedStream[] = [];

    const streamHeaders = {
      Origin: 'https://flashstream.cc',
      Referer: 'https://flashstream.cc/',
    };

    for (const source of sources) {
      if (source.file && (source.file.includes('pkaystream.cc') || source.file.includes('flashstream.cc'))) {
        streams.push({
          id: `hollymoviehd-${source.label || 'default'}`,
          type: 'hls',
          playlist: source.file,
          flags: [],
          captions: [],
          headers: streamHeaders,
          skipValidation: true,
        } as HlsBasedStream);
      }
    }

    return {
      stream: streams,
    };
  },
});

export const vidnestAllmoviesEmbed = makeEmbed({
  id: 'vidnest-allmovies',
  name: 'Vidnest AllMovies (Hindi)',
  rank: 103,
  flags: [flags.CORS_ALLOWED],
  disabled: false,
  async scrape(ctx) {
    const response = await ctx.proxiedFetcher<any>(ctx.url);
    if (!response.data) throw new NotFoundError('No encrypted data found');

    const decryptedData = await decryptVidnestData(response.data);
    if (!decryptedData.success && !decryptedData.streams) throw new NotFoundError('No streams found');

    const sources = decryptedData.sources || decryptedData.streams;
    const streams = [];

    for (const stream of sources) {
      streams.push({
        id: `allmovies-${stream.language || 'default'}`,
        type: 'hls',
        playlist: stream.url || stream.file,
        flags: [flags.CORS_ALLOWED],
        captions: [],
        preferredHeaders: stream.headers || {},
        skipValidation: true,
      } as HlsBasedStream);
    }

    return {
      stream: streams,
    };
  },
});

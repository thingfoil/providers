/* eslint-disable prettier/prettier */
/* eslint-disable no-console */

import CryptoJS from 'crypto-js';

import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

import { Stream } from '../streams';

const vidzeeBase = 'https://player.vidzee.wtf/api/server';
const em = "4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c"; // from source code
// Key: "pleasedontscrapemesaywallahi" named G in source code(lil bro will probably change it soon)
const G = "pleasedontscrapemesaywallahi";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function decryptVidzeeApiKey( encryptedBase64: string): Promise<string> {
  try {
    if (!encryptedBase64) return "";
    const raw = base64ToBytes(encryptedBase64);
    if (raw.length <= 28) return "";

    const iv = raw.slice(0, 12);
    const authTag = raw.slice(12, 28);
    const ciphertext = raw.slice(28);
    const encrypted = new Uint8Array(ciphertext.length + authTag.length);
    encrypted.set(ciphertext, 0);
    encrypted.set(authTag, ciphertext.length);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.digest("SHA-256", enc.encode(em));
    const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128}, key, encrypted);

    return new TextDecoder().decode(decryptedBuffer);
  } catch { return ""; }
}
export async function fetchVidzeeKey(): Promise<string> {
  try {
    const res = await fetch("https://core.vidzee.wtf/api-key");
    if (!res.ok) throw new Error("failed");

    const encrypted = await res.text();
    return await decryptVidzeeApiKey(encrypted);
  } catch {
    return "";
  }
}
function decodeVidZeeToken(token: string, key: string): string | null {
  try {
    if (!token || /^https?:\/\//i.test(token)) return token;

    const binaryString = atob(token.trim());
    
    const raw = decodeURIComponent(
      Array.prototype.map.call(binaryString, (c: string) => {
        // eslint-disable-next-line prefer-template
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')
    );

    if (!raw.includes(':')) return null;

    const [ivB64, cipherB64] = raw.split(':');
    const iv = CryptoJS.enc.Base64.parse(ivB64.trim());

    const keyStr = key;
    const keyUtf8 = CryptoJS.enc.Utf8.parse(keyStr.padEnd(32, '\0'));

    const decrypted = CryptoJS.AES.decrypt(cipherB64.trim(), keyUtf8, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).toString(CryptoJS.enc.Utf8);

    return decrypted && /^https?:\/\//i.test(decrypted) ? decrypted.trim() : null;
  } catch (e) {
    return null;
  }
}
async function comboScraper(ctx: ShowScrapeContext | MovieScrapeContext): Promise<SourcererOutput> {
  const servers = [0];
  const apiKey = await fetchVidzeeKey()||G;
  const allStreams:Stream[] = [];

  for (const sr of servers) {
    const url =
      ctx.media.type === 'movie'
        ? `${vidzeeBase}?id=${ctx.media.tmdbId}&sr=${sr}`
        : `${vidzeeBase}?id=${ctx.media.tmdbId}&sr=${sr}&ss=${ctx.media.season.number}&ep=${ctx.media.episode.number}`;

    try {
      const data = await ctx.proxiedFetcher<{url: string, link: string, name?: string, type?: string}>(url, {
        headers: {
          Referer: `https://player.vidzee.wtf/embed/${ctx.media.type}/${ctx.media.tmdbId}`,
        },
      });

      if (!data) continue;

      let apiSources: {url: string, link: string, name?: string, type?: string}[] = [];
      if (data.url && Array.isArray(data.url)) {
        apiSources = data.url;
      } else if (data.link && typeof data.link === 'string') {
        apiSources = [data];
      }

      for (const source of apiSources) {
        const decodedUrl = decodeVidZeeToken(source.link, apiKey);
        if (!decodedUrl) continue;

        const label = source.name || source.type || 'VidZee';
        const isHls = decodedUrl.includes('.m3u8');
        const streamHeaders = {
          'accept': '*/*',
          'referer': 'https://player.vidzee.wtf',
          'origin': 'https://player.vidzee.wtf/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7,de;q=0.6,es-US;q=0.5,es;q=0.4'
        };

        if (isHls) {
          allStreams.push({
            id: `Server ${sr}-${label}`,
            type: 'hls',
            playlist: createM3U8ProxyUrl(decodedUrl, ctx.features, streamHeaders),
            flags: [flags.CORS_ALLOWED],
            captions:[],
          });
        } else {
          allStreams.push({
            id: `Server ${sr}-${label}`,
            type: 'file',
            captions: [],
            qualities: {
              unknown: {
                type: 'mp4',
                url: decodedUrl,
              },
            },
            flags: [flags.CORS_ALLOWED],
            preferredHeaders: {...streamHeaders},
          });
        }
      }
    } catch (e) {
      continue;
    }
  }

  if (allStreams.length === 0) {
    throw new NotFoundError('No streams found on VidZee');
  }

  return {
    embeds: [],
    stream: allStreams,
  };
}

export const vidzeeScraper = makeSourcerer({
  id: 'vidzee',
  name: 'VidZee',
  rank: 240,
  disabled: true,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});

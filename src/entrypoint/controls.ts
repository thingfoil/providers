import { FullScraperEvents, IndividualScraperEvents, UpdateEvent } from '@/entrypoint/utils/events';
import { ScrapeMedia } from '@/entrypoint/utils/media';
import { MetaOutput, getAllEmbedMetaSorted, getAllSourceMetaSorted, getSpecificId } from '@/entrypoint/utils/meta';
import { FeatureMap, flagsAllowedInFeatures } from '@/entrypoint/utils/targets';
import { makeFetcher } from '@/fetchers/common';
import { Fetcher } from '@/fetchers/types';
import { Embed, EmbedOutput, Sourcerer, SourcererOutput } from '@/providers/base';
import { scrapeIndividualEmbed, scrapeInvidualSource } from '@/runners/individualRunner';
import { RunOutput, runAllProviders } from '@/runners/runner';
import { ScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { requiresProxy, setupProxy } from '@/utils/proxy';
import { isValidStream, validatePlayableStream } from '@/utils/valid';

export interface ProviderControlsInput {
  fetcher: Fetcher;
  proxiedFetcher?: Fetcher;
  features: FeatureMap;
  sources: Sourcerer[];
  embeds: Embed[];
  proxyStreams?: boolean; // temporary
}

export interface RunnerOptions {
  // overwrite the order of sources to run. list of ids
  // any omitted ids are in added to the end in order of rank (highest first)
  sourceOrder?: string[];

  // overwrite the order of embeds to run. list of ids
  // any omitted ids are in added to the end in order of rank (highest first)
  embedOrder?: string[];

  // object of event functions
  events?: FullScraperEvents;

  // the media you want to see sources from
  media: ScrapeMedia;

  // it makes sense to have this in the builder
  // but I belive it's more useful in runner ops
  disableOpensubtitles?: boolean;

  // abort signal for cancelling scraping
  abortSignal?: AbortSignal;
}

export interface SourceRunnerOptions {
  // object of event functions
  events?: IndividualScraperEvents;

  // the media you want to see sources from
  media: ScrapeMedia;

  // id of the source scraper you want to scrape from
  id: string;

  // it makes sense to have this in the builder
  // but I belive it's more useful in runner ops
  disableOpensubtitles?: boolean;
}

export interface EmbedRunnerOptions {
  // object of event functions
  events?: IndividualScraperEvents;

  // the embed url
  url: string;

  // id of the embed scraper you want to scrape from
  id: string;

  // it makes sense to have this in the builder
  // but I belive it's more useful in runner ops
  disableOpensubtitles?: boolean;
}

export interface ProviderControls {
  // Run all providers one by one. in order of rank (highest first)
  // returns the stream, or null if none found
  runAll(runnerOps: RunnerOptions): Promise<RunOutput | null>;

  // Run a single source and its embeds (if any) with abort capability
  // returns the stream, or null if none found or aborted
  runSourceWithEmbeds(runnerOps: Omit<RunnerOptions, 'sourceOrder'> & { sourceId: string; skipInit?: boolean }): Promise<RunOutput | null>;

  // Run a specific source scraper
  runSourceScraper(runnerOps: SourceRunnerOptions): Promise<SourcererOutput>;

  // Run a specific embed scraper
  runEmbedScraper(runnerOps: EmbedRunnerOptions): Promise<EmbedOutput>;

  // get meta data about a source or embed.
  getMetadata(id: string): MetaOutput | null;

  // return all sources. sorted by rank (highest first)
  listSources(): MetaOutput[];

  // return all embed scrapers. sorted by rank (highest first)
  listEmbeds(): MetaOutput[];
}

export function makeControls(ops: ProviderControlsInput): ProviderControls {
  const list = {
    embeds: ops.embeds,
    sources: ops.sources,
  };

  const providerRunnerOps = {
    features: ops.features,
    fetcher: makeFetcher(ops.fetcher),
    proxiedFetcher: makeFetcher(ops.proxiedFetcher ?? ops.fetcher),
    proxyStreams: ops.proxyStreams,
  };

  const runSourceWithEmbeds = async (
    runnerOps: Omit<RunnerOptions, 'sourceOrder'> & { sourceId: string; skipInit?: boolean },
  ): Promise<RunOutput | null> => {
    const sourceItem = list.sources.find((s) => s.id === runnerOps.sourceId);
    if (!sourceItem) {
      throw new Error(`Source with ID ${runnerOps.sourceId} not found`);
    }

    // Check if media type is supported
    if (runnerOps.media.type === 'movie' && !sourceItem.scrapeMovie) {
      throw new Error(`Source ${runnerOps.sourceId} does not support movies`);
    }
    if (runnerOps.media.type === 'show' && !sourceItem.scrapeShow) {
      throw new Error(`Source ${runnerOps.sourceId} does not support shows`);
    }

    const sources = [sourceItem];
    const embeds = list.embeds;
    const embedIds = embeds.map((embed) => embed.id);

    let lastId = '';

    const contextBase: ScrapeContext = {
      fetcher: providerRunnerOps.fetcher,
      proxiedFetcher: providerRunnerOps.proxiedFetcher,
      features: providerRunnerOps.features,
      abortSignal: runnerOps.abortSignal,
      progress(val) {
        runnerOps.events?.update?.({
          id: lastId,
          percentage: val,
          status: 'pending',
        });
      },
    };

    if (!runnerOps.skipInit) {
      runnerOps.events?.init?.({
        sourceIds: sources.map((v) => v.id),
      });
    }

    for (const currentSource of sources) {
      // Check for abort before starting the source
      console.log('[controls] Checking abort signal for source:', currentSource.id, 'aborted:', runnerOps.abortSignal?.aborted);
      if (runnerOps.abortSignal?.aborted) {
        console.log('[controls] Abort signal detected, calling abort event for:', currentSource.id);
        runnerOps.events?.abort?.(currentSource.id);
        return null;
      }

      runnerOps.events?.start?.(currentSource.id);
      lastId = currentSource.id;

      // run source scrapers
      let output: SourcererOutput | null = null;
      try {
        if (runnerOps.media.type === 'movie' && currentSource.scrapeMovie)
          output = await currentSource.scrapeMovie({
            ...contextBase,
            media: runnerOps.media,
          });
        else if (runnerOps.media.type === 'show' && currentSource.scrapeShow)
          output = await currentSource.scrapeShow({
            ...contextBase,
            media: runnerOps.media,
          });
        if (output) {
          output.stream = (output.stream ?? [])
            .filter(isValidStream)
            .filter((stream) => flagsAllowedInFeatures(providerRunnerOps.features, stream.flags));

          output.stream = output.stream.map((stream) =>
            requiresProxy(stream) && providerRunnerOps.proxyStreams ? setupProxy(stream) : stream,
          );
        }
        if (!output || (!output.stream?.length && !output.embeds.length)) {
          throw new NotFoundError('No streams found');
        }
      } catch (error) {
        const updateParams: UpdateEvent = {
          id: currentSource.id,
          percentage: 100,
          status: error instanceof NotFoundError ? 'notfound' : 'failure',
          reason: error instanceof NotFoundError ? error.message : undefined,
          error: error instanceof NotFoundError ? undefined : error,
        };

        runnerOps.events?.update?.(updateParams);
        continue;
      }
      if (!output) throw new Error('Invalid media type');

      // return stream if there are any
      if (output.stream?.[0]) {
        const validationOps = {
          fetcher: providerRunnerOps.fetcher,
          proxiedFetcher: providerRunnerOps.proxiedFetcher,
          features: providerRunnerOps.features,
          media: runnerOps.media,
          proxyStreams: providerRunnerOps.proxyStreams,
        };
        const playableStream = await validatePlayableStream(output.stream[0], validationOps, currentSource.id);
        if (!playableStream) throw new NotFoundError('No streams found');

        return {
          sourceId: currentSource.id,
          stream: playableStream,
        };
      }

      // filter disabled and run embed scrapers on listed embeds
      const sortedEmbeds = output.embeds
        .filter((embed) => {
          const e = list.embeds.find((v) => v.id === embed.embedId);
          return e && !e.disabled;
        })
        .sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));

      if (sortedEmbeds.length > 0) {
        runnerOps.events?.discoverEmbeds?.({
          embeds: sortedEmbeds.map((embed, i) => ({
            id: [currentSource.id, i].join('-'),
            embedScraperId: embed.embedId,
          })),
          sourceId: currentSource.id,
        });
      }

    for (const [ind, embed] of sortedEmbeds.entries()) {
      // Check for abort before starting each embed
      console.log('[controls] Checking abort signal for embed:', [currentSource.id, ind].join('-'), 'aborted:', runnerOps.abortSignal?.aborted);
      if (runnerOps.abortSignal?.aborted) {
        console.log('[controls] Abort signal detected for embed, calling abort event for:', [currentSource.id, ind].join('-'));
        runnerOps.events?.abort?.([currentSource.id, ind].join('-'));
        return null;
      }

        const scraper = embeds.find((v) => v.id === embed.embedId);
        if (!scraper) throw new Error('Invalid embed returned');

        // run embed scraper
        const id = [currentSource.id, ind].join('-');
        runnerOps.events?.start?.(id);
        lastId = id;

        let embedOutput: EmbedOutput;
        try {
          embedOutput = await scraper.scrape({
            ...contextBase,
            url: embed.url,
          });
          embedOutput.stream = embedOutput.stream
            .filter(isValidStream)
            .filter((stream) => flagsAllowedInFeatures(providerRunnerOps.features, stream.flags));
          embedOutput.stream = embedOutput.stream.map((stream) =>
            requiresProxy(stream) && providerRunnerOps.proxyStreams ? setupProxy(stream) : stream,
          );
          if (embedOutput.stream.length === 0) {
            throw new NotFoundError('No streams found');
          }
          const validationOps = {
            fetcher: providerRunnerOps.fetcher,
            proxiedFetcher: providerRunnerOps.proxiedFetcher,
            features: providerRunnerOps.features,
            media: runnerOps.media,
            proxyStreams: providerRunnerOps.proxyStreams,
          };
          const playableStream = await validatePlayableStream(embedOutput.stream[0], validationOps, embed.embedId);
          if (!playableStream) throw new NotFoundError('No streams found');

          embedOutput.stream = [playableStream];
        } catch (error) {
          const updateParams: UpdateEvent = {
            id,
            percentage: 100,
            status: error instanceof NotFoundError ? 'notfound' : 'failure',
            reason: error instanceof NotFoundError ? error.message : undefined,
            error: error instanceof NotFoundError ? undefined : error,
          };

          runnerOps.events?.update?.(updateParams);
          continue;
        }

        return {
          sourceId: currentSource.id,
          embedId: scraper.id,
          stream: embedOutput.stream[0],
        };
      }
    }

    // no providers or embeds returns streams
    return null;
  };

  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps,
        abortSignal: runnerOps.abortSignal,
      });
    },
    runSourceWithEmbeds(runnerOps) {
      return runSourceWithEmbeds(runnerOps);
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps,
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps,
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    },
  };
}

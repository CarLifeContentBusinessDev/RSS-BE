import { Injectable } from '@nestjs/common';
import { SpotifyService } from '../spotify/spotify.service';
import {
  ItunesSearchResponse,
  ItunesSearchResult,
} from 'src/types/apple-podcasts.types';

@Injectable()
export class ApplePodcastsService {
  constructor(private readonly spotifyService: SpotifyService) {}

  async searchPodcast(podcastName: string): Promise<ItunesSearchResult[]> {
    const encodedTerm = encodeURIComponent(podcastName);
    const url = `https://itunes.apple.com/search?term=${encodedTerm}&entity=podcast&limit=10`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `iTunes Search API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as ItunesSearchResponse;
      return data.results;
    } catch (error) {
      console.error('iTunes Search API error:', error);
      throw new Error('Failed to search Apple Podcasts');
    }
  }

  private findBestMatch(
    searchTerm: string,
    results: ItunesSearchResult[],
  ): ItunesSearchResult | null {
    if (results.length === 0) {
      return null;
    }

    const normalizedSearchTerm = searchTerm.toLowerCase().trim();

    const exactMatch = results.find(
      (result) =>
        result.collectionName.toLowerCase() === normalizedSearchTerm ||
        result.trackName.toLowerCase() === normalizedSearchTerm,
    );

    if (exactMatch) {
      return exactMatch;
    }

    const partialMatch = results.find(
      (result) =>
        result.collectionName.toLowerCase().includes(normalizedSearchTerm) ||
        normalizedSearchTerm.includes(result.collectionName.toLowerCase()),
    );

    if (partialMatch) {
      return partialMatch;
    }

    return results[0];
  }

  async getRssFeedFromSpotify(
    spotifyUrl: string,
    showName?: string,
  ): Promise<string> {
    try {
      let resolvedShowName = showName;

      if (!resolvedShowName) {
        const { channelInfo } =
          await this.spotifyService.fetchSpotifyShow(spotifyUrl);

        if (!channelInfo || !channelInfo.title) {
          throw new Error('Failed to extract show name from Spotify');
        }

        resolvedShowName = channelInfo.title;
      }

      const searchResults = await this.searchPodcast(resolvedShowName);

      if (searchResults.length === 0) {
        throw new Error('Podcast not found on Apple Podcasts');
      }

      const bestMatch = this.findBestMatch(resolvedShowName, searchResults);

      if (!bestMatch) {
        throw new Error('No matching podcast found');
      }

      if (!bestMatch.feedUrl) {
        throw new Error('RSS feed URL not available for this podcast');
      }

      return bestMatch.feedUrl;
    } catch (error) {
      console.error('Error finding RSS feed from Spotify:', error);
      throw error;
    }
  }
}

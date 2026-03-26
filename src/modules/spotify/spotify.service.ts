import { Injectable } from '@nestjs/common';
import {
  SpotifyEpisode,
  SpotifyEpisodesPage,
  SpotifyShow,
  SpotifyToken,
} from 'src/types/spotify.types';

export type SpotifyProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'fetch_page'; fetched: number; total: number }
  | { type: 'complete'; total: number };

export type SpotifyProgressCallback = (event: SpotifyProgressEvent) => void;

@Injectable()
export class SpotifyService {
  private readonly SPOTIFY_CLIENT_ID: string;
  private readonly SPOTIFY_CLIENT_SECRET: string;
  private readonly SPOTIFY_MARKETS: string[];

  constructor() {
    this.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
    this.SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
    this.SPOTIFY_MARKETS = (process.env.SPOTIFY_MARKETS || 'KR,US')
      .split(',')
      .map((market) => market.trim().toUpperCase())
      .filter(Boolean);
  }

  private buildSpotifyUrl(path: string, market?: string, query = ''): string {
    const params = new URLSearchParams(query);
    if (market) {
      params.set('market', market);
    }

    const queryString = params.toString();
    if (!queryString) {
      return `https://api.spotify.com/v1/${path}`;
    }

    return `https://api.spotify.com/v1/${path}?${queryString}`;
  }

  /**
   * Spotify Access Token을 발급받습니다. (Client Credentials Flow)
   */
  private async getSpotifyToken(): Promise<string> {
    // Client ID와 Secret을 Base64로 인코딩하여 인증 헤더 생성
    const auth = Buffer.from(
      `${this.SPOTIFY_CLIENT_ID}:${this.SPOTIFY_CLIENT_SECRET}`,
    ).toString('base64');

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('Spotify Token Error:', errorText);
      throw new Error(
        `Failed to get Spotify token: ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as SpotifyToken;
    return data.access_token;
  }

  private extractShowId(url: string): string {
    const match = url.match(/show\/([a-zA-Z0-9]+)/);
    if (!match) {
      throw new Error('Invalid Spotify show URL');
    }
    return match[1];
  }

  async fetchSpotifyShow(
    showUrl: string,
    onProgress?: SpotifyProgressCallback,
  ) {
    try {
      const showId = this.extractShowId(showUrl);
      const token = await this.getSpotifyToken();
      let showData: SpotifyShow | null = null;
      let selectedMarket = this.SPOTIFY_MARKETS[0] || 'US';
      const showErrors: string[] = [];

      // 1. 쇼(Podcast) 기본 정보 가져오기 (market fallback)
      for (const market of this.SPOTIFY_MARKETS) {
        const showRes = await fetch(
          this.buildSpotifyUrl(`shows/${showId}`, market),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (showRes.ok) {
          showData = (await showRes.json()) as SpotifyShow;
          selectedMarket = market;
          break;
        }

        const errorText = await showRes.text();
        showErrors.push(
          `${market}: ${showRes.status} ${showRes.statusText} ${errorText}`,
        );
      }

      if (!showData) {
        throw new Error(
          `Failed to fetch show for all markets. ${showErrors.join(' | ')}`,
        );
      }

      const channelInfo = {
        id: showId,
        title: showData.name || 'Spotify Podcast',
        description: showData.description || '',
        summary: showData.description || '',
        url: showUrl,
        thumbnail: showData.images?.[0]?.url || '',
        author: showData.publisher || 'Unknown',
        copyright: showData.publisher || '',
        owner: {
          name: showData.publisher || 'Unknown',
          email: '',
        },
        addedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        type: 'spotify',
      };

      // 2. 에피소드 목록 가져오기 (Paging 처리)
      let allEpisodes: SpotifyEpisode[] = [];
      let offset = 0;
      const limit = 50;
      const totalEpisodes = showData.total_episodes || 0;

      console.log(`[Spotify] 총 ${totalEpisodes}개 에피소드`);
      onProgress?.({ type: 'start', total: totalEpisodes });

      while (offset < totalEpisodes) {
        let episodesData: SpotifyEpisodesPage | null = null;
        const episodeErrors: string[] = [];

        for (const market of [selectedMarket, ...this.SPOTIFY_MARKETS]) {
          const episodesRes = await fetch(
            this.buildSpotifyUrl(
              `shows/${showId}/episodes`,
              market,
              `limit=${limit}&offset=${offset}`,
            ),
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          );

          if (episodesRes.ok) {
            episodesData = (await episodesRes.json()) as SpotifyEpisodesPage;
            break;
          }

          const errorText = await episodesRes.text();
          episodeErrors.push(
            `${market}: ${episodesRes.status} ${episodesRes.statusText} ${errorText}`,
          );
        }

        if (!episodesData) {
          throw new Error(
            `Failed to fetch episodes at offset ${offset}. ${episodeErrors.join(' | ')}`,
          );
        }

        if (!episodesData.items || episodesData.items.length === 0) {
          break;
        }

        allEpisodes = allEpisodes.concat(episodesData.items);
        offset += limit;

        console.log(
          `[Spotify] ${allEpisodes.length}/${totalEpisodes} 에피소드 가져옴`,
        );
        onProgress?.({
          type: 'fetch_page',
          fetched: allEpisodes.length,
          total: totalEpisodes,
        });

        // API 과부하 방지를 위한 아주 짧은 대기
        if (offset < totalEpisodes) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // 3. 데이터 포맷팅
      const episodes = allEpisodes.map((episode) => ({
        id: episode.id,
        title: episode.name || 'Untitled Episode',
        description: episode.description || episode.html_description || '',
        url:
          episode.external_urls?.spotify ||
          `https://open.spotify.com/episode/${episode.id}`,
        audioPath: episode.audio_preview_url || '',
        thumbnail: episode.images?.[0]?.url || channelInfo.thumbnail,
        publishedAt: episode.release_date || new Date().toISOString(),
        duration: episode.duration_ms
          ? Math.floor(episode.duration_ms / 1000)
          : null,
      }));

      console.log(`[Spotify] 완료: ${episodes.length}개 에피소드`);
      onProgress?.({ type: 'complete', total: episodes.length });

      return {
        channelInfo,
        episodes,
      };
    } catch (error) {
      console.error('Spotify fetch error:', error);
      throw error;
    }
  }

  async updateSpotifyShow(
    showUrl: string,
    onProgress?: SpotifyProgressCallback,
  ) {
    const { episodes } = await this.fetchSpotifyShow(showUrl, onProgress);
    return episodes;
  }
}

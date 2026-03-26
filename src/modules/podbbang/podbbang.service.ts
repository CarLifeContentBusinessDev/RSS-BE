import { Injectable } from '@nestjs/common';
import * as https from 'https';
import {
  PodbbangChannelResponse,
  PodbbangEpisodesResponse,
} from 'src/types/podbbang.types';

export type PodbbangProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'fetch_page'; current: number; total: number }
  | { type: 'complete'; total: number };

export type PodbbangProgressCallback = (event: PodbbangProgressEvent) => void;

@Injectable()
export class PodbbangService {
  private httpsGet<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            } else {
              try {
                resolve(JSON.parse(data));
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : 'Unknown error';
                reject(new Error(`JSON parse error: ${errorMessage}`));
              }
            }
          });
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }

  async fetchPodbbangChannel(
    channelId: string,
    onProgress?: PodbbangProgressCallback,
  ) {
    try {
      const firstPageUrl = `https://app-api6.podbbang.com/channels/${channelId}/episodes?offset=0&limit=20&sort=desc&episode_id=0&focus_center=0&with=image`;
      const firstPageData =
        await this.httpsGet<PodbbangEpisodesResponse>(firstPageUrl);

      const totalCount = firstPageData.summary?.totalCount || 0;
      let allEpisodes = [...firstPageData.data];

      console.log(`[Podbbang] 총 ${totalCount}개 에피소드`);
      onProgress?.({ type: 'start', total: totalCount });

      if (totalCount > 20) {
        const numPages = Math.ceil(totalCount / 20);

        for (let pageNum = 1; pageNum < numPages; pageNum++) {
          const pageUrl = `https://app-api6.podbbang.com/channels/${channelId}/episodes?offset=${pageNum}&limit=20&sort=desc&episode_id=0&focus_center=0&with=image`;
          const pageData =
            await this.httpsGet<PodbbangEpisodesResponse>(pageUrl);

          if (pageData.data && pageData.data.length > 0) {
            allEpisodes = allEpisodes.concat(pageData.data);
          }

          console.log(`[Podbbang] 페이지 ${pageNum + 1}/${numPages}`);
          onProgress?.({ type: 'fetch_page', current: pageNum + 1, total: numPages });
        }
      }

      const channelUrl = `https://app-api6.podbbang.com/channels/${channelId}`;
      const channelData =
        await this.httpsGet<PodbbangChannelResponse>(channelUrl);

      const episodesData = {
        data: allEpisodes,
        summary: firstPageData.summary,
      };

      const channelInfo = {
        id: channelId,
        title: channelData.title || 'Podbbang Channel',
        description: channelData.description || channelData.summary || '',
        summary: channelData.summary || channelData.description || '',
        url: `https://www.podbbang.com/channels/${channelId}`,
        thumbnail: channelData.image || channelData.thumbnail?.url || '',
        author: channelData.mc || channelData.copyright || 'Unknown',
        copyright: channelData.copyright || '',
        owner: {
          name: channelData.mc || channelData.copyright || 'Unknown',
          email: channelData.contacts?.email || '',
        },
        language: 'ko',
        addedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        type: 'podbbang',
      };

      const episodes =
        episodesData.data?.map((episode) => ({
          id: episode.id.toString(),
          title: episode.title || 'Untitled Episode',
          description: episode.description || '',
          url: `https://www.podbbang.com/channels/${channelId}/episodes/${episode.id}`,
          audioPath: episode.media?.url || '',
          thumbnail: episode.thumbnail?.url || episode.image?.url || '',
          publishedAt:
            episode.published_at ||
            episode.created_at ||
            new Date().toISOString(),
          duration: episode.duration || null,
        })) || [];

      console.log(`[Podbbang] 완료: ${episodes.length}개 에피소드`);
      onProgress?.({ type: 'complete', total: episodes.length });

      return {
        channelInfo,
        episodes,
      };
    } catch (error) {
      console.error('Podbbang fetch error:', error);

      if (error instanceof Error) {
        const errorMessage = error.message;
        if (errorMessage.includes('존재하지 않는 방송')) {
          throw new Error(
            `팟빵 채널을 찾을 수 없습니다. 채널 ID를 확인해주세요: ${channelId}`,
          );
        }
        if (errorMessage.includes('HTTP 400')) {
          throw new Error(`잘못된 채널 ID입니다: ${channelId}`);
        }
      }

      throw error;
    }
  }

  async updatePodbbangChannel(
    channelId: string,
    onProgress?: PodbbangProgressCallback,
  ) {
    const { episodes } = await this.fetchPodbbangChannel(channelId, onProgress);
    return episodes;
  }
}

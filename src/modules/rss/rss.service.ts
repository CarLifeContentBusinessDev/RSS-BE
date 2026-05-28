import { Injectable } from '@nestjs/common';
import { Podcast } from 'podcast';
import { Channel, Video } from 'src/types/channel.types';

@Injectable()
export class RssService {
  generateRSS(channelInfo: Channel, videos: Video[], baseUrl: string): string {
    const defaultAuthor =
      channelInfo.host || channelInfo.author || videos[0]?.author || 'Unknown';

    const feed = new Podcast({
      title: channelInfo.title || 'Podcast Channel',
      description:
        channelInfo.summary || channelInfo.description || 'Podcast RSS Feed',
      feedUrl: `${baseUrl}/rss/${channelInfo.id}`,
      siteUrl: channelInfo.url || baseUrl,
      imageUrl: channelInfo.thumbnail || '',
      author: channelInfo.author || defaultAuthor,
      copyright: channelInfo.copyright || channelInfo.author || '',
      language: channelInfo.language || 'ko',
      itunesAuthor: defaultAuthor,
      itunesOwner: {
        name: channelInfo.owner?.name || defaultAuthor,
        email: channelInfo.owner?.email || 'noreply@example.com',
      },
      itunesSummary: channelInfo.summary || channelInfo.description || '',
      itunesImage: channelInfo.thumbnail || '',
      itunesExplicit: false,
      itunesType: 'episodic',
      itunesCategory: channelInfo.category
        ? [{ text: channelInfo.category }]
        : [{ text: 'Society & Culture' }], // 추후 기본값 정의 필요함
      pubDate: new Date(),
      ttl: 60,
    });

    videos.forEach((video) => {
      const item: {
        title: string;
        description: string;
        url: string;
        guid: string;
        date: Date | string;
        itunesAuthor: string;
        itunesExplicit: boolean;
        itunesSubtitle: string;
        itunesSummary: string;
        itunesEpisodeType: 'full' | 'trailer' | 'bonus';
        itunesImage?: string;
        enclosure?: {
          url: string;
          type: string;
          size: number;
        };
        author?: string;
        itunesDuration?: number;
      } = {
        title: video.title,
        description: video.description || video.title,
        url: video.url,
        guid: video.id,
        date: video.publishedAt || video.uploadDate || new Date(),
        itunesAuthor: channelInfo.author || video.author || defaultAuthor,
        itunesExplicit: false,
        itunesSubtitle: video.title,
        itunesSummary: video.description || video.title,
        itunesEpisodeType: 'full' as const,
      };

      item.author = channelInfo.author || video.author || defaultAuthor;

      if (video.thumbnail) {
        item.itunesImage = video.thumbnail;
      }

      if (video.audioPath) {
        item.enclosure = {
          url: video.audioPath,
          type: 'audio/mpeg',
          size: video.audioSize || 0,
        };
      }

      if (video.duration) {
        item.itunesDuration = video.duration;
      }

      feed.addItem(item);
    });

    return feed.buildXml({ indent: '  ' });
  }
}

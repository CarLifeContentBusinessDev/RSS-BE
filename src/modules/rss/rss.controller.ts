import {
  Controller,
  Get,
  Param,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { RssService } from './rss.service';
import { ChannelDbService } from 'src/shared/services/channel-db.service';

@Controller('rss')
export class RssController {
  private readonly BASE_URL: string;

  constructor(
    private readonly rssService: RssService,
    private readonly channelDbService: ChannelDbService,
  ) {
    const port = process.env.PORT || '3000';
    this.BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;
  }

  @Get(':channelId')
  async getRssFeed(
    @Param('channelId') channelId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    try {
      const channel = await this.channelDbService.getChannel(channelId);

      if (!channel) {
        console.error('RSS: Channel not found:', channelId);
        throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
      }

      const rssXML = this.rssService.generateRSS(
        channel,
        channel.videos,
        this.BASE_URL,
      );

      res.set('Content-Type', 'application/rss+xml');
      res.send(rssXML);
    } catch (error) {
      console.error('Error generating RSS feed:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(
        `Error generating RSS feed: ${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

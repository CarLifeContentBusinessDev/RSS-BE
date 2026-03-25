// backend/src/modules/youtube/youtube.controller.ts
import {
  Controller,
  Post,
  Query,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { YoutubeService } from './youtube.service';

@Controller('youtube')
export class YoutubeController {
  private readonly BASE_URL: string;

  constructor(private readonly youtubeService: YoutubeService) {
    const port = process.env.PORT || '3000';
    this.BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;
  }

  @Sse('process-stream')
  processUrlStream(@Query('url') url: string): Observable<MessageEvent> {
    if (!url) {
      throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
    }

    return new Observable((subscriber) => {
      this.youtubeService
        .processAndSave(url, this.BASE_URL, (event) => {
          subscriber.next({ data: event } as MessageEvent);
        })
        .then((rssUrl) => {
          // complete 이벤트는 processAndSave 내부에서 이미 emit됨
          // rssUrl은 complete 이벤트에 포함되어 있으므로 여기선 스트림만 닫음
          void rssUrl;
          subscriber.complete();
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          subscriber.next({
            data: { type: 'error', message },
          } as MessageEvent);
          subscriber.complete();
        });
    });
  }

  @Post('process')
  async processUrl(@Body('url') url: string) {
    try {
      if (!url) {
        throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
      }

      const rssUrl = await this.youtubeService.processAndSave(
        url,
        this.BASE_URL,
      );
      return { rssUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (
        message.includes('Unsupported YouTube URL') ||
        message.includes('Invalid YouTube URL') ||
        message.includes('No videos found')
      ) {
        throw new HttpException(message, HttpStatus.BAD_REQUEST);
      }

      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('update/:channelId')
  async updateChannel(
    @Param('channelId') channelId: string,
    @Body('url') url: string,
  ) {
    try {
      if (!url) {
        throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
      }

      const updated = await this.youtubeService.updateChannel(channelId, url);
      return {
        success: true,
        updated: updated.newEpisodes,
        total: updated.totalEpisodes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

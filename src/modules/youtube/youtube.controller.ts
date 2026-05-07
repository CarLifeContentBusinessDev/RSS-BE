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
      let isSubscriberActive = true;
      const abortController = new AbortController();

      // 30분 타임아웃 (매우 긴 재생목록용)
      const timeoutHandle = setTimeout(
        () => {
          console.log('[YouTube] SSE 요청 타임아웃 — 처리 중단');
          isSubscriberActive = false;
          abortController.abort();
        },
        30 * 60 * 1000,
      );

      this.youtubeService
        .processAndSave(url, this.BASE_URL, (event) => {
          if (!isSubscriberActive) return;
          try {
            subscriber.next({ data: event } as MessageEvent);
          } catch (error) {
            console.error('[YouTube] 콜백 전송 에러:', error);
            isSubscriberActive = false;
          }
        }, abortController.signal)
        .then((rssUrl) => {
          void rssUrl;
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) return;
          subscriber.complete();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) {
            console.log('[YouTube] 처리 중단 — 구독이 없으므로 에러 전송 안함');
            return;
          }
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          console.error('[YouTube] 처리 에러:', message);
          subscriber.next({ data: { type: 'error', message } } as MessageEvent);
          subscriber.complete();
        });

      return () => {
        isSubscriberActive = false;
        clearTimeout(timeoutHandle);
        abortController.abort();
        console.log('[YouTube] SSE 연결 종료 — 처리 중단');
      };
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

  @Sse('update-stream/:channelId')
  updateChannelStream(
    @Param('channelId') channelId: string,
    @Query('url') url: string,
  ): Observable<MessageEvent> {
    if (!url) {
      throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
    }

    const fullChannelId = `youtube-${channelId}`;

    return new Observable((subscriber) => {
      let isSubscriberActive = true;
      const abortController = new AbortController();

      // 30분 타임아웃 (매우 긴 재생목록용)
      const timeoutHandle = setTimeout(
        () => {
          console.log('[YouTube] 업데이트 SSE 요청 타임아웃 — 처리 중단');
          isSubscriberActive = false;
          abortController.abort();
        },
        30 * 60 * 1000,
      );

      this.youtubeService
        .updateChannel(channelId, url, (event) => {
          if (!isSubscriberActive) return;
          try {
            subscriber.next({ data: event } as MessageEvent);
          } catch (error) {
            console.error('[YouTube] 업데이트 콜백 전송 에러:', error);
            isSubscriberActive = false;
          }
        }, abortController.signal)
        .then(() => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) return;
          subscriber.complete();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) {
            console.log('[YouTube] 업데이트 처리 중단 — 구독이 없으므로 에러 전송 생략');
            return;
          }
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          console.error('[YouTube] 업데이트 처리 에러:', message);
          subscriber.next({ data: { type: 'error', message } } as MessageEvent);
          subscriber.complete();
        });

      return () => {
        isSubscriberActive = false;
        clearTimeout(timeoutHandle);
        abortController.abort();
        console.log(`[YouTube] 업데이트 SSE 연결 종료: ${fullChannelId} — 처리 중단`);
      };
    });
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

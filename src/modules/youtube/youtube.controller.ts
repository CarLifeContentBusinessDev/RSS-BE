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
      let isTimedOut = false;

      // 30분 타임아웃 (매우 긴 재생목록용)
      const timeoutHandle = setTimeout(
        () => {
          if (!isTimedOut) {
            isTimedOut = true;
            console.log(
              '[YouTube] SSE 요청 타임아웃 — 구독만 종료 (처리 계속)',
            );
            isSubscriberActive = false;
          }
        },
        30 * 60 * 1000,
      );

      // 주의: 클라이언트가 끊겨도 서버 쪽 처리를 계속 진행하도록 signal을 전달하지 않습니다.
      this.youtubeService
        .processAndSave(url, this.BASE_URL, (event) => {
          if (!isSubscriberActive) return;
          try {
            subscriber.next({ data: event } as MessageEvent);
          } catch (error) {
            console.error('[YouTube] 콜백 전송 에러:', error);
            isSubscriberActive = false;
          }
        })
        .then((rssUrl) => {
          void rssUrl; // SSE에서는 이미 complete 이벤트로 전달됨
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) return;
          subscriber.complete();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive || isTimedOut) {
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
        console.log('[YouTube] SSE 연결 종료 — 구독만 종료 (처리 계속)');
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
      let isTimedOut = false;

      // 30분 타임아웃 (매우 긴 재생목록용)
      const timeoutHandle = setTimeout(
        () => {
          if (!isTimedOut) {
            isTimedOut = true;
            console.log(
              '[YouTube] 업데이트 SSE 요청 타임아웃 — 구독만 종료 (처리 계속)',
            );
            isSubscriberActive = false;
          }
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
        })
        .then(() => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) return;
          subscriber.complete();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive || isTimedOut) {
            console.log(
              '[YouTube] 업데이트 처리 중단 — 구독이 없으므로 에러送信 생략',
            );
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
        console.log(
          `[YouTube] 업데이트 SSE 연결 종료: ${fullChannelId} — 구독만 종료 (처리 계속)`,
        );
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

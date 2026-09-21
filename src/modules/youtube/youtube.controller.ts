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
  Get,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { YoutubeService } from './youtube.service';

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

interface UploadedImageFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Controller('youtube')
export class YoutubeController {
  private readonly BASE_URL: string;

  constructor(private readonly youtubeService: YoutubeService) {
    const port = process.env.PORT || '3000';
    this.BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;
  }

  private hasField(body: unknown, key: string): boolean {
    if (typeof body !== 'object' || body === null) {
      return false;
    }

    return key in body;
  }

  private validateImage(image: UploadedImageFile): void {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(image.mimetype)) {
      throw new HttpException(
        'Unsupported image type. Use JPEG, PNG, or WebP.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Sse('process-stream')
  processUrlStream(
    @Query('url') url: string,
    @Query('author') author?: string,
  ): Observable<MessageEvent> {
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
        .processAndSave(
          url,
          this.BASE_URL,
          (event) => {
            if (!isSubscriberActive) return;
            try {
              subscriber.next({ data: event } as MessageEvent);
            } catch (error) {
              console.error('[YouTube] 콜백 전송 에러:', error);
              isSubscriberActive = false;
            }
          },
          abortController.signal,
          author,
        )
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
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_SIZE_BYTES } }),
  )
  async processUrl(
    @Body() body: { url?: string; author?: string },
    @UploadedFile() image?: UploadedImageFile,
  ) {
    try {
      const url = body.url;

      if (!url) {
        throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
      }

      if (image) {
        this.validateImage(image);
      }

      const authorInput = this.hasField(body, 'author')
        ? body.author
        : undefined;

      const rssUrl = await this.youtubeService.processAndSave(
        url,
        this.BASE_URL,
        undefined,
        undefined,
        authorInput,
        image ? { buffer: image.buffer, mimetype: image.mimetype } : undefined,
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

      console.error('[YouTube] /process 처리 에러:', message);
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Sse('update-stream/:channelId')
  updateChannelStream(
    @Param('channelId') channelId: string,
    @Query('url') url: string,
    @Query('author') author?: string,
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
        .updateChannel(
          channelId,
          url,
          (event) => {
            if (!isSubscriberActive) return;
            try {
              subscriber.next({ data: event } as MessageEvent);
            } catch (error) {
              console.error('[YouTube] 업데이트 콜백 전송 에러:', error);
              isSubscriberActive = false;
            }
          },
          abortController.signal,
          author,
        )
        .then(() => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) return;
          subscriber.complete();
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          if (!isSubscriberActive) {
            console.log(
              '[YouTube] 업데이트 처리 중단 — 구독이 없으므로 에러 전송 생략',
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
        abortController.abort();
        console.log(
          `[YouTube] 업데이트 SSE 연결 종료: ${fullChannelId} — 처리 중단`,
        );
      };
    });
  }

  @Post('update/:channelId')
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_SIZE_BYTES } }),
  )
  async updateChannel(
    @Param('channelId') channelId: string,
    @Body() body: unknown,
    @UploadedFile() image?: UploadedImageFile,
  ) {
    try {
      if (image) {
        this.validateImage(image);
      }

      const hasAuthor = this.hasField(body, 'author');
      const hasTitle = this.hasField(body, 'title');
      const hasDescription = this.hasField(body, 'description');
      const hasCopyright = this.hasField(body, 'copyright');
      const bodyObj = body as
        | {
            url?: string;
            author?: unknown;
            title?: unknown;
            description?: unknown;
            copyright?: unknown;
          }
        | undefined;
      const authorInput = hasAuthor ? bodyObj?.author : undefined;
      const titleInput = hasTitle ? bodyObj?.title : undefined;
      const descriptionInput = hasDescription
        ? bodyObj?.description
        : undefined;
      const copyrightInput = hasCopyright ? bodyObj?.copyright : undefined;
      const hasMetadataOverride =
        hasAuthor || hasTitle || hasDescription || hasCopyright;
      const imageInput = image
        ? { buffer: image.buffer, mimetype: image.mimetype }
        : undefined;

      const url = bodyObj?.url;

      if ((hasMetadataOverride || imageInput) && !url) {
        await this.youtubeService.updateChannelMetadataOnly(
          channelId,
          {
            author: authorInput,
            title: titleInput,
            description: descriptionInput,
            copyright: copyrightInput,
          },
          imageInput,
        );
        return { success: true, updated: 0 };
      }

      if ((hasMetadataOverride || imageInput) && typeof url === 'string') {
        const existing = await this.youtubeService.getChannel(channelId);
        if (existing && existing.url === url) {
          await this.youtubeService.updateChannelMetadataOnly(
            channelId,
            {
              author: authorInput,
              title: titleInput,
              description: descriptionInput,
              copyright: copyrightInput,
            },
            imageInput,
          );
          return { success: true, updated: 0 };
        }
      }

      if (!url) {
        throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
      }

      const updated = await this.youtubeService.updateChannel(
        channelId,
        url,
        undefined,
        undefined,
        authorInput,
        imageInput,
        titleInput,
        descriptionInput,
        copyrightInput,
      );

      return {
        success: true,
        updated: updated.newEpisodes,
        total: updated.totalEpisodes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[YouTube] /update 처리 에러:', message);
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ⚠️ 임시 디버그용 — 진단 끝나면 삭제
  @Get('debug/cookie-test')
  async debugCookieTest() {
    return this.youtubeService.debugTestCookies();
  }
}

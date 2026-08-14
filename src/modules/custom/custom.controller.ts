import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  AnyFilesInterceptor,
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import {
  CustomItemFields,
  CustomItemInput,
  CustomService,
} from './custom.service';

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
];
const MAX_AUDIO_SIZE_BYTES = 300 * 1024 * 1024;

interface UploadedMulterFile {
  fieldname: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

const PUB_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Controller('custom')
export class CustomController {
  private readonly BASE_URL: string;

  constructor(private readonly customService: CustomService) {
    const port = process.env.PORT || '3000';
    this.BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;
  }

  private validateImage(image: UploadedMulterFile): void {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(image.mimetype)) {
      throw new HttpException(
        'Unsupported image type. Use JPEG, PNG, or WebP.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (image.size > MAX_IMAGE_SIZE_BYTES) {
      throw new HttpException(
        'Image file is too large. Max 5MB.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private validateAudio(audio: UploadedMulterFile, label: string): void {
    if (!ALLOWED_AUDIO_MIME_TYPES.includes(audio.mimetype)) {
      throw new HttpException(
        `Unsupported audio type for ${label}. Use MP3 or M4A.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (audio.size > MAX_AUDIO_SIZE_BYTES) {
      throw new HttpException(
        `Audio file for ${label} is too large. Max 300MB.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private parseItems(itemsRaw: unknown): CustomItemInput[] {
    if (typeof itemsRaw !== 'string' || !itemsRaw.trim()) {
      throw new HttpException('items is required', HttpStatus.BAD_REQUEST);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(itemsRaw);
    } catch {
      throw new HttpException(
        'items must be a valid JSON array',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new HttpException(
        'items must be a non-empty array',
        HttpStatus.BAD_REQUEST,
      );
    }

    return parsed.map((item: unknown, index) => {
      if (typeof item !== 'object' || item === null) {
        throw new HttpException(
          `items[${index}] must be an object`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const { title, description, pubDate, duration } = item as Record<
        string,
        unknown
      >;

      if (typeof title !== 'string' || !title.trim()) {
        throw new HttpException(
          `items[${index}].title is required`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (typeof pubDate !== 'string' || !PUB_DATE_PATTERN.test(pubDate)) {
        throw new HttpException(
          `items[${index}].pubDate must be in YYYY-MM-DD format`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (Number.isNaN(new Date(pubDate).getTime())) {
        throw new HttpException(
          `items[${index}].pubDate is not a valid date`,
          HttpStatus.BAD_REQUEST,
        );
      }

      if (duration !== undefined && typeof duration !== 'string') {
        throw new HttpException(
          `items[${index}].duration must be a string`,
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        title: title.trim(),
        description:
          typeof description === 'string' && description.trim()
            ? description.trim()
            : undefined,
        pubDate,
        duration:
          typeof duration === 'string' && duration.trim()
            ? duration.trim()
            : undefined,
      };
    });
  }

  // 아이템 추가/수정(PATCH·POST .../items) 공용 필드 파싱 — publishedAt/duration은 선택값
  // duration은 초 단위 정수 문자열로 온다 (mm:ss 파싱이 필요한 /custom/create의 items[]와 다름)
  private parseItemFields(body: {
    title?: string;
    description?: string;
    publishedAt?: string;
    duration?: string;
  }): CustomItemFields {
    const title = body.title?.trim();
    if (!title) {
      throw new HttpException('title is required', HttpStatus.BAD_REQUEST);
    }

    if (body.publishedAt && body.publishedAt.trim()) {
      const publishedAt = body.publishedAt.trim();
      if (!PUB_DATE_PATTERN.test(publishedAt)) {
        throw new HttpException(
          'publishedAt must be in YYYY-MM-DD format',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (Number.isNaN(new Date(publishedAt).getTime())) {
        throw new HttpException(
          'publishedAt is not a valid date',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    let duration: number | undefined;
    if (body.duration !== undefined && body.duration.trim() !== '') {
      const parsed = Number(body.duration.trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new HttpException(
          'duration must be a non-negative integer number of seconds',
          HttpStatus.BAD_REQUEST,
        );
      }
      duration = parsed;
    }

    return {
      title,
      description: body.description?.trim() || undefined,
      publishedAt: body.publishedAt?.trim() || undefined,
      duration,
    };
  }

  private handleError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('not found')) {
      throw new HttpException(message, HttpStatus.NOT_FOUND);
    }
    if (message.includes('Invalid duration format')) {
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }

    throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Post('create')
  @UseInterceptors(
    AnyFilesInterceptor({ limits: { fileSize: MAX_AUDIO_SIZE_BYTES } }),
  )
  async create(
    @Body() body: { title?: string; description?: string; items?: string },
    @UploadedFiles() files: UploadedMulterFile[] = [],
  ) {
    try {
      const title = body.title?.trim();
      if (!title) {
        throw new HttpException('title is required', HttpStatus.BAD_REQUEST);
      }

      const items = this.parseItems(body.items);

      const image = files.find((file) => file.fieldname === 'image');
      if (image) {
        this.validateImage(image);
      }

      const audioFiles = items.map((_item, index) => {
        const audio = files.find(
          (file) => file.fieldname === `item_${index}_audio`,
        );
        if (!audio) {
          throw new HttpException(
            `item_${index}_audio file is required`,
            HttpStatus.BAD_REQUEST,
          );
        }
        this.validateAudio(audio, `item ${index}`);
        return audio;
      });

      const thumbnailFiles = items.map((_item, index) => {
        const thumbnail = files.find(
          (file) => file.fieldname === `item_${index}_thumbnail`,
        );
        if (thumbnail) {
          this.validateImage(thumbnail);
        }
        return thumbnail;
      });

      const rssUrl = await this.customService.createCustomChannel(
        {
          title,
          description: body.description?.trim() || undefined,
          items,
        },
        this.BASE_URL,
        image ? { buffer: image.buffer, mimetype: image.mimetype } : undefined,
        audioFiles.map((file) => ({
          buffer: file.buffer,
          mimetype: file.mimetype,
        })),
        thumbnailFiles.map((file) =>
          file ? { buffer: file.buffer, mimetype: file.mimetype } : undefined,
        ),
      );

      return { rssUrl };
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':channelId')
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_SIZE_BYTES } }),
  )
  async updateChannel(
    @Param('channelId') channelId: string,
    @Body() body: { title?: string; description?: string },
    @UploadedFile() image?: UploadedMulterFile,
  ) {
    try {
      const title = body.title?.trim();
      if (!title) {
        throw new HttpException('title is required', HttpStatus.BAD_REQUEST);
      }
      if (image) {
        this.validateImage(image);
      }

      const channel = await this.customService.updateChannelMeta(
        channelId,
        { title, description: body.description?.trim() || undefined },
        image ? { buffer: image.buffer, mimetype: image.mimetype } : undefined,
      );

      return { success: true, channel };
    } catch (error) {
      this.handleError(error);
    }
  }

  @Post(':channelId/items')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'audio', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_AUDIO_SIZE_BYTES } },
    ),
  )
  async addItem(
    @Param('channelId') channelId: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      publishedAt?: string;
      duration?: string;
    },
    @UploadedFiles()
    files: {
      audio?: UploadedMulterFile[];
      thumbnail?: UploadedMulterFile[];
    } = {},
  ) {
    try {
      const fields = this.parseItemFields(body);
      const audio = files.audio?.[0];
      const thumbnail = files.thumbnail?.[0];
      if (!audio) {
        throw new HttpException(
          'audio file is required',
          HttpStatus.BAD_REQUEST,
        );
      }
      this.validateAudio(audio, 'audio');
      if (thumbnail) {
        this.validateImage(thumbnail);
      }

      const item = await this.customService.addItem(
        channelId,
        fields,
        { buffer: audio.buffer, mimetype: audio.mimetype },
        thumbnail
          ? { buffer: thumbnail.buffer, mimetype: thumbnail.mimetype }
          : undefined,
      );

      return { success: true, item };
    } catch (error) {
      this.handleError(error);
    }
  }

  @Patch(':channelId/items/:itemId')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'audio', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_AUDIO_SIZE_BYTES } },
    ),
  )
  async updateItem(
    @Param('channelId') channelId: string,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      publishedAt?: string;
      duration?: string;
    },
    @UploadedFiles()
    files: {
      audio?: UploadedMulterFile[];
      thumbnail?: UploadedMulterFile[];
    } = {},
  ) {
    try {
      const fields = this.parseItemFields(body);
      const audio = files.audio?.[0];
      const thumbnail = files.thumbnail?.[0];
      if (audio) {
        this.validateAudio(audio, 'audio');
      }
      if (thumbnail) {
        this.validateImage(thumbnail);
      }

      const item = await this.customService.updateItem(
        channelId,
        itemId,
        fields,
        audio ? { buffer: audio.buffer, mimetype: audio.mimetype } : undefined,
        thumbnail
          ? { buffer: thumbnail.buffer, mimetype: thumbnail.mimetype }
          : undefined,
      );

      return { success: true, item };
    } catch (error) {
      this.handleError(error);
    }
  }

  @Delete(':channelId/items/:itemId')
  async deleteItem(
    @Param('channelId') channelId: string,
    @Param('itemId') itemId: string,
  ) {
    try {
      await this.customService.deleteItem(channelId, itemId);
      return { success: true };
    } catch (error) {
      this.handleError(error);
    }
  }
}

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { parseDurationToSeconds } from 'src/common/utils/duration.util';
import { r2Config } from 'src/common/config/r2.config';
import { ChannelDbService } from 'src/shared/services/channel-db.service';
import { R2StorageService } from 'src/shared/services/r2-storage.service';
import { Channel, Video } from 'src/types/channel.types';
import type { Json } from 'src/types/database.types';

export interface CustomItemInput {
  title: string;
  description?: string;
  pubDate: string;
  duration?: string;
}

export interface CustomChannelInput {
  title: string;
  description?: string;
  items: CustomItemInput[];
}

export interface CustomItemFields {
  title: string;
  description?: string;
  publishedAt?: string;
  duration?: number;
}

interface UploadFile {
  buffer: Buffer;
  mimetype: string;
}

// 유튜브 파이프라인(DOWNLOAD_FOLDER)과 섞이지 않도록 커스텀 RSS 파일은 별도 폴더에 저장
const CUSTOM_STORAGE_FOLDER = process.env.CUSTOM_DOWNLOAD_FOLDER || 'rss_maker';

@Injectable()
export class CustomService {
  private readonly s3Client: S3Client;

  constructor(
    private readonly channelDbService: ChannelDbService,
    private readonly r2StorageService: R2StorageService,
  ) {
    if (
      !r2Config.endpoint ||
      !r2Config.accessKeyId ||
      !r2Config.secretAccessKey
    ) {
      throw new Error('R2 환경변수 설정을 확인해주세요.');
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });
  }

  private getImageExtension(mimetype: string): string {
    switch (mimetype) {
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return 'jpg';
    }
  }

  private async uploadChannelImage(
    channelId: string,
    imageFile: UploadFile,
  ): Promise<string> {
    const ext = this.getImageExtension(imageFile.mimetype);
    const imageKey = `${CUSTOM_STORAGE_FOLDER}/images/${channelId}.${ext}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: imageKey,
        Body: imageFile.buffer,
        ContentType: imageFile.mimetype,
        ContentLength: imageFile.buffer.length,
      }),
    );

    return `${r2Config.publicUrl}/${imageKey}`;
  }

  // 채널 썸네일과 같은 R2 버킷을 쓰지만 경로를 images/items/ 하위로 분리해 아이템 전용 썸네일임을 구분한다
  private async uploadItemThumbnail(
    itemId: string,
    imageFile: UploadFile,
  ): Promise<string> {
    const ext = this.getImageExtension(imageFile.mimetype);
    const imageKey = `${CUSTOM_STORAGE_FOLDER}/images/items/${itemId}.${ext}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: imageKey,
        Body: imageFile.buffer,
        ContentType: imageFile.mimetype,
        ContentLength: imageFile.buffer.length,
      }),
    );

    return `${r2Config.publicUrl}/${imageKey}`;
  }

  private getAudioExtension(mimetype: string): string {
    switch (mimetype) {
      case 'audio/mp4':
      case 'audio/x-m4a':
      case 'audio/m4a':
        return 'm4a';
      default:
        return 'mp3';
    }
  }

  // mp3/m4a 모두 허용하면서 확장자가 파일별로 달라질 수 있으므로, 오디오 교체 시
  // 이전 키와 확장자가 달라지면 호출부(addItem/updateItem)에서 이전 오브젝트를 별도로 정리한다
  private async uploadItemAudio(
    itemId: string,
    audioFile: UploadFile,
  ): Promise<{ url: string; size: number }> {
    const ext = this.getAudioExtension(audioFile.mimetype);
    const audioKey = `${CUSTOM_STORAGE_FOLDER}/${itemId}.${ext}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: audioKey,
        Body: audioFile.buffer,
        ContentType: audioFile.mimetype,
        ContentLength: audioFile.buffer.length,
      }),
    );

    return {
      url: `${r2Config.publicUrl}/${audioKey}`,
      size: audioFile.buffer.length,
    };
  }

  private buildVideo(
    itemId: string,
    input: {
      title: string;
      description?: string;
      pubDate: string;
      duration: number | null;
    },
    audioUrl: string,
    audioSize: number,
    thumbnail: string | undefined,
  ): Video {
    const publishedAt = new Date(
      `${input.pubDate}T00:00:00.000Z`,
    ).toISOString();

    return {
      id: itemId,
      title: input.title,
      description: input.description || undefined,
      url: audioUrl,
      audioPath: audioUrl,
      audioSize,
      thumbnail,
      uploadDate: publishedAt,
      publishedAt,
      duration: input.duration,
      tags: [],
    };
  }

  private async findChannelOrThrow(channelId: string): Promise<Channel> {
    const channel = await this.channelDbService.getChannel(channelId);
    if (!channel || channel.type !== 'custom') {
      throw new Error('Channel not found');
    }
    return channel;
  }

  async createCustomChannel(
    input: CustomChannelInput,
    baseUrl: string,
    image: UploadFile | undefined,
    audioFiles: UploadFile[],
    thumbnailFiles: (UploadFile | undefined)[] = [],
  ): Promise<string> {
    const channelId = `custom-${randomUUID()}`;

    const thumbnail = image
      ? await this.uploadChannelImage(channelId, image)
      : undefined;

    const videos: Video[] = await Promise.all(
      input.items.map(async (item, index) => {
        const itemId = randomUUID();
        const { url: audioUrl, size: audioSize } = await this.uploadItemAudio(
          itemId,
          audioFiles[index],
        );
        const duration = item.duration
          ? parseDurationToSeconds(item.duration)
          : null;

        const itemThumbnailFile = thumbnailFiles[index];
        const itemThumbnail = itemThumbnailFile
          ? await this.uploadItemThumbnail(itemId, itemThumbnailFile)
          : thumbnail;

        return this.buildVideo(
          itemId,
          { ...item, duration },
          audioUrl,
          audioSize,
          itemThumbnail,
        );
      }),
    );

    await this.channelDbService.addChannel({
      id: channelId,
      title: input.title,
      url: `${baseUrl}/rss/${channelId}`,
      thumbnail,
      type: 'custom',
      videos: videos as unknown as Json,
      description: input.description,
      language: 'ko',
    });

    return `${baseUrl}/rss/${channelId}`;
  }

  async updateChannelMeta(
    channelId: string,
    input: { title: string; description?: string },
    image: UploadFile | undefined,
  ): Promise<Channel> {
    const channel = await this.findChannelOrThrow(channelId);

    let thumbnail = channel.thumbnail;
    if (image) {
      const oldKey = this.r2StorageService.extractKey(channel.thumbnail);
      thumbnail = await this.uploadChannelImage(channelId, image);

      const newKey = this.r2StorageService.extractKey(thumbnail);
      if (oldKey && oldKey !== newKey) {
        await this.r2StorageService
          .deleteObjects([oldKey])
          .catch((error) => console.error('기존 썸네일 삭제 실패:', error));
      }
    }

    const updated = await this.channelDbService.updateChannelMetadata(
      channelId,
      {
        title: input.title,
        description: input.description ?? null,
        thumbnail,
      },
    );

    // updateChannelMetadata는 videos 컬럼을 select하지 않으므로 이미 들고 있던 값으로 채워준다
    return { ...updated, videos: channel.videos };
  }

  async addItem(
    channelId: string,
    input: CustomItemFields,
    audioFile: UploadFile,
    thumbnailFile: UploadFile | undefined,
  ): Promise<Video> {
    const channel = await this.findChannelOrThrow(channelId);

    const itemId = randomUUID();
    const { url: audioUrl, size: audioSize } = await this.uploadItemAudio(
      itemId,
      audioFile,
    );
    const thumbnail = thumbnailFile
      ? await this.uploadItemThumbnail(itemId, thumbnailFile)
      : channel.thumbnail;
    const pubDate = input.publishedAt || new Date().toISOString().slice(0, 10);
    const newVideo = this.buildVideo(
      itemId,
      {
        title: input.title,
        description: input.description,
        pubDate,
        duration: input.duration ?? null,
      },
      audioUrl,
      audioSize,
      thumbnail,
    );

    await this.channelDbService.updateChannelVideos(channelId, [
      ...channel.videos,
      newVideo,
    ]);

    return newVideo;
  }

  async updateItem(
    channelId: string,
    itemId: string,
    input: CustomItemFields,
    audioFile: UploadFile | undefined,
    thumbnailFile: UploadFile | undefined,
  ): Promise<Video> {
    const channel = await this.findChannelOrThrow(channelId);
    const existingIndex = channel.videos.findIndex(
      (video) => video.id === itemId,
    );
    if (existingIndex === -1) {
      throw new Error('Item not found');
    }
    const existing = channel.videos[existingIndex];

    let audioUrl = existing.audioPath as string;
    let audioSize = existing.audioSize as number;
    if (audioFile) {
      const oldAudioKey = this.r2StorageService.extractKey(audioUrl);
      const uploaded = await this.uploadItemAudio(itemId, audioFile);
      audioUrl = uploaded.url;
      audioSize = uploaded.size;

      const newAudioKey = this.r2StorageService.extractKey(audioUrl);
      if (oldAudioKey && oldAudioKey !== newAudioKey) {
        await this.r2StorageService
          .deleteObjects([oldAudioKey])
          .catch((error) =>
            console.error('기존 오디오 파일 삭제 실패:', error),
          );
      }
    }

    let thumbnail = existing.thumbnail;
    if (thumbnailFile) {
      const oldThumbnailKey = this.r2StorageService.extractKey(
        existing.thumbnail,
      );
      thumbnail = await this.uploadItemThumbnail(itemId, thumbnailFile);

      const newThumbnailKey = this.r2StorageService.extractKey(thumbnail);
      if (oldThumbnailKey && oldThumbnailKey !== newThumbnailKey) {
        await this.r2StorageService
          .deleteObjects([oldThumbnailKey])
          .catch((error) =>
            console.error('기존 아이템 썸네일 삭제 실패:', error),
          );
      }
    }

    const pubDate =
      input.publishedAt ||
      (existing.publishedAt || existing.uploadDate || '').slice(0, 10) ||
      new Date().toISOString().slice(0, 10);
    // duration을 보내지 않으면 기존 값을 유지한다 (title처럼 항상 재전송되는 필드가 아니므로)
    const duration =
      input.duration !== undefined
        ? input.duration
        : (existing.duration ?? null);
    const updatedVideo = this.buildVideo(
      itemId,
      {
        title: input.title,
        description: input.description,
        pubDate,
        duration,
      },
      audioUrl,
      audioSize,
      thumbnail,
    );

    const videos = [...channel.videos];
    videos[existingIndex] = updatedVideo;
    await this.channelDbService.updateChannelVideos(channelId, videos);

    return updatedVideo;
  }

  async deleteItem(channelId: string, itemId: string): Promise<void> {
    const channel = await this.findChannelOrThrow(channelId);
    const existing = channel.videos.find((video) => video.id === itemId);
    if (!existing) {
      throw new Error('Item not found');
    }

    const videos = channel.videos.filter((video) => video.id !== itemId);
    await this.channelDbService.updateChannelVideos(channelId, videos);

    const audioKey = this.r2StorageService.extractKey(existing.audioPath);
    if (audioKey) {
      await this.r2StorageService
        .deleteObjects([audioKey])
        .catch((error) => console.error('오디오 파일 삭제 실패:', error));
    }

    // 채널 썸네일을 그대로 물려받은 아이템이면 다른 아이템/채널이 참조 중일 수 있으니 지우지 않는다
    if (existing.thumbnail && existing.thumbnail !== channel.thumbnail) {
      const thumbnailKey = this.r2StorageService.extractKey(existing.thumbnail);
      if (thumbnailKey) {
        await this.r2StorageService
          .deleteObjects([thumbnailKey])
          .catch((error) => console.error('아이템 썸네일 삭제 실패:', error));
      }
    }
  }
}

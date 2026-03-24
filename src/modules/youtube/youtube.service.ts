import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { r2Config } from 'src/common/config/r2.config';
import { VideoInfo } from 'src/types/youtube.types';
import { Readable } from 'stream';
import ytpl from 'ytpl';
import { ChannelDbService } from 'src/shared/services/channel-db.service';
import type { Json } from 'src/types/database.types';
import { Video } from 'src/types/channel.types';
import YTDlpWrap from 'yt-dlp-wrap';
import { access, chmod, mkdir } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';

interface YtDlpVideoInfo {
  id: string;
  title: string;
  description?: string;
  thumbnail: string;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  duration?: number;
  tags?: string[];
  categories?: string[];
}

function parseYouTubeDate(dateStr: string | undefined): string {
  if (!dateStr || dateStr.length !== 8) {
    return new Date().toISOString();
  }

  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);

  if (isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

@Injectable()
export class YoutubeService {
  private s3Client: S3Client;
  private readonly ytDlpCommand: string;
  private ytDlpWrap: YTDlpWrap | null = null;
  private ytDlpInitPromise: Promise<void> | null = null;

  constructor(private readonly channelDbService: ChannelDbService) {
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

    this.ytDlpCommand = process.env.YT_DLP_PATH || 'yt-dlp';
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async tryUseYtDlpBinary(binaryPath: string): Promise<boolean> {
    try {
      const wrapper = new YTDlpWrap(binaryPath);
      await wrapper.getVersion();
      this.ytDlpWrap = wrapper;
      return true;
    } catch {
      return false;
    }
  }

  private async resolveYtDlpWrap(): Promise<YTDlpWrap> {
    if (this.ytDlpWrap) {
      return this.ytDlpWrap;
    }

    if (!this.ytDlpInitPromise) {
      this.ytDlpInitPromise = (async () => {
        if (await this.tryUseYtDlpBinary(this.ytDlpCommand)) {
          return;
        }

        const cacheDir =
          process.env.YT_DLP_CACHE_DIR ||
          join(process.cwd(), '.cache', 'yt-dlp');
        const binaryName =
          process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const binaryPath = join(cacheDir, binaryName);

        await mkdir(cacheDir, { recursive: true });

        if (!(await this.fileExists(binaryPath))) {
          await YTDlpWrap.downloadFromGithub(binaryPath);
          if (process.platform !== 'win32') {
            await chmod(binaryPath, 0o755);
          }
        }

        if (!(await this.tryUseYtDlpBinary(binaryPath))) {
          throw new Error(
            `Failed to initialize yt-dlp. Set YT_DLP_PATH or allow download to ${binaryPath}.`,
          );
        }
      })()
        .catch((error) => {
          this.ytDlpWrap = null;
          throw error;
        })
        .finally(() => {
          this.ytDlpInitPromise = null;
        });
    }

    await this.ytDlpInitPromise;

    if (!this.ytDlpWrap) {
      throw new Error('yt-dlp is not initialized');
    }

    return this.ytDlpWrap;
  }

  private getUrlType(
    url: string,
  ): 'video' | 'playlist' | 'channel' | 'unknown' {
    if (url.includes('playlist?list=') || url.includes('/playlist?list=')) {
      return 'playlist';
    }
    if (
      url.includes('/channel/') ||
      url.includes('/@') ||
      url.includes('/c/')
    ) {
      return 'channel';
    }
    if (url.includes('watch?v=') || url.includes('youtu.be/')) {
      return 'video';
    }
    return 'unknown';
  }

  private async getPlaylistInfo(url: string): Promise<{
    channelInfo: {
      id: string;
      title: string;
      url: string;
      thumbnail?: string;
      author?: string;
      description?: string;
    };
    videoIds: string[];
  }> {
    try {
      const result = await ytpl(url, { limit: Infinity });
      const videoIds = result.items.map((item) => item.id);

      return {
        channelInfo: {
          id: result.id,
          title: result.title,
          url: result.url,
          thumbnail: result.bestThumbnail?.url || undefined,
          author: result.author?.name || undefined,
          description: result.description || undefined,
        },
        videoIds,
      };
    } catch (error) {
      throw new Error(
        `Failed to get playlist info: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async getVideoInfo(videoId: string): Promise<VideoInfo> {
    try {
      const ytDlpWrap = await this.resolveYtDlpWrap();
      const output = await ytDlpWrap.execPromise([
        '--dump-json',
        '--no-playlist',
        `https://www.youtube.com/watch?v=${videoId}`,
      ]);

      const info = JSON.parse(output) as YtDlpVideoInfo;
      return {
        videoId: info.id,
        title: info.title,
        description: info.description || null,
        thumbnail: info.thumbnail,
        author: info.uploader || info.channel || 'Unknown',
        publishedAt: parseYouTubeDate(info.upload_date),
        audioUrl: '',
        audioSize: 0,
        duration: info.duration || 0,
        tags: info.tags || [],
        category: info.categories?.[0] || undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to execute yt-dlp. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async getAudioStream(videoUrl: string): Promise<Readable> {
    const ytDlpWrap = await this.resolveYtDlpWrap();
    return ytDlpWrap.execStream([
      '-f',
      'bestaudio',
      '-o',
      '-',
      '--no-playlist',
      videoUrl,
    ]);
  }

  async uploadAudio(
    videoId: string,
    videoUrl: string,
  ): Promise<{ url: string; size: number }> {
    const audioName = `${process.env.DOWNLOAD_FOLDER}/${videoId}.mp3`;

    try {
      const audioStream = await this.getAudioStream(videoUrl);
      const chunks: Uint8Array[] = [];

      for await (const chunk of audioStream) {
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
          continue;
        }

        chunks.push(chunk as Uint8Array);
      }
      const buffer = Buffer.concat(chunks);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: audioName,
          Body: buffer,
          ContentType: 'audio/mpeg',
          ContentLength: buffer.length,
        }),
      );

      return {
        url: `${r2Config.publicUrl}/${audioName}`,
        size: buffer.length,
      };
    } catch (error) {
      console.error(
        '오디오 업로드 실패:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async makeAudioUrl(videoId: string): Promise<VideoInfo> {
    try {
      const videoInfo = await this.getVideoInfo(videoId);
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const audioData = await this.uploadAudio(videoId, videoUrl);

      return {
        ...videoInfo,
        audioUrl: audioData.url,
        audioSize: audioData.size,
      };
    } catch (error) {
      console.error('오디오 URL 생성 실패:', error);
      throw error;
    }
  }

  private async processVideo(videoId: string): Promise<VideoInfo> {
    return await this.makeAudioUrl(videoId);
  }

  private convertToVideo(videoInfo: VideoInfo): Video {
    return {
      id: videoInfo.videoId,
      title: videoInfo.title,
      description: videoInfo.description || undefined,
      url: `https://www.youtube.com/watch?v=${videoInfo.videoId}`,
      audioPath: videoInfo.audioUrl,
      audioSize: videoInfo.audioSize,
      thumbnail: videoInfo.thumbnail,
      publishedAt: videoInfo.publishedAt,
      uploadDate: videoInfo.publishedAt,
      duration: videoInfo.duration,
      tags: videoInfo.tags || [],
      contentType: videoInfo.category || '기타',
    };
  }

  private extractVideoId(url: string): string {
    const patterns = [
      /(?:youtube\.com\/watch\?v=)([^&]+)/,
      /(?:youtu\.be\/)([^?]+)/,
      /(?:youtube\.com\/embed\/)([^?]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    throw new Error('Invalid YouTube URL');
  }

  async makeUrl(url: string) {
    const urlType = this.getUrlType(url);

    let videoIds: string[] = [];
    let channelInfo: {
      id: string;
      title: string;
      url: string;
      thumbnail?: string;
      author?: string;
      description?: string;
    } | null = null;

    if (urlType === 'video') {
      const videoId = this.extractVideoId(url);
      videoIds = [videoId];
    } else {
      const playlistData = await this.getPlaylistInfo(url);
      videoIds = playlistData.videoIds;
      channelInfo = playlistData.channelInfo;
    }

    const results: VideoInfo[] = [];
    const errors: { videoId: string; error: string }[] = [];

    for (let i = 0; i < videoIds.length; i++) {
      const videoId = videoIds[i];

      try {
        const result = await this.processVideo(videoId);
        results.push(result);
      } catch (error) {
        errors.push({
          videoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (i < videoIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return {
      type: urlType,
      url,
      channelInfo,
      total: videoIds.length,
      success: results.length,
      failed: errors.length,
      videos: results,
      errors,
    };
  }

  private aggregateMetadata(videos: VideoInfo[]): {
    tags: string[];
    category: string | null;
    contentType: string | null;
  } {
    const allTags = new Set<string>();

    videos.forEach((video) => {
      video.tags?.forEach((tag) => allTags.add(tag));
    });

    return {
      tags: Array.from(allTags).slice(0, 10),
      category: null,
      contentType: null,
    };
  }

  async processAndSave(url: string, baseUrl: string): Promise<string> {
    const result = await this.makeUrl(url);
    const metadata = this.aggregateMetadata(result.videos);

    if (result.type === 'video' && result.videos.length > 0) {
      const firstVideo = result.videos[0];
      const channelId = `youtube-video-${firstVideo.videoId}`;

      await this.channelDbService.addChannel({
        id: channelId,
        title: firstVideo.title,
        url: `https://www.youtube.com/watch?v=${firstVideo.videoId}`,
        thumbnail: firstVideo.thumbnail,
        type: 'youtube',
        videos: result.videos.map((v) =>
          this.convertToVideo(v),
        ) as unknown as Json,
        description: firstVideo.description || undefined,
        author: firstVideo.author,
        language: 'ko',
        category: metadata.category,
        content_type: metadata.contentType,
        publisher: firstVideo.author,
        host: firstVideo.author,
        tags: metadata.tags as unknown as Json,
      });

      return `${baseUrl}/rss/${channelId}`;
    }

    if (result.channelInfo) {
      const channelId = `youtube-${result.channelInfo.id}`;

      await this.channelDbService.addChannel({
        id: channelId,
        title: result.channelInfo.title,
        url: result.channelInfo.url,
        thumbnail: result.channelInfo.thumbnail,
        type: 'youtube',
        videos: result.videos.map((v) =>
          this.convertToVideo(v),
        ) as unknown as Json,
        description: result.channelInfo.description,
        author: result.channelInfo.author,
        language: 'ko',
        category: metadata.category,
        content_type: metadata.contentType,
        publisher: result.channelInfo.author,
        host: result.channelInfo.author,
        tags: metadata.tags as unknown as Json,
      });

      return `${baseUrl}/rss/${channelId}`;
    }

    throw new Error('Failed to process YouTube URL');
  }

  async updateChannel(
    channelId: string,
    url: string,
  ): Promise<{ newEpisodes: number; totalEpisodes: number }> {
    const existingChannel = await this.channelDbService.getChannel(channelId);

    if (!existingChannel) {
      throw new Error('Channel not found');
    }

    const existingVideoIds = new Set(
      existingChannel.videos.map((v: Video) => v.id),
    );
    const result = await this.makeUrl(url);
    const newVideos = result.videos.filter(
      (video) => !existingVideoIds.has(video.videoId),
    );

    if (newVideos.length === 0) {
      return {
        newEpisodes: 0,
        totalEpisodes: existingChannel.videos.length,
      };
    }

    const newVideoItems = newVideos.map((v) => this.convertToVideo(v));
    const updatedVideos = [...newVideoItems, ...existingChannel.videos];

    await this.channelDbService.updateChannelVideos(channelId, updatedVideos);

    return {
      newEpisodes: newVideos.length,
      totalEpisodes: updatedVideos.length,
    };
  }
}

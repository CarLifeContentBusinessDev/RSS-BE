import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { r2Config } from 'src/common/config/r2.config';
import { VideoInfo } from 'src/types/youtube.types';
import ytpl from 'ytpl';
import { ChannelDbService } from 'src/shared/services/channel-db.service';
import type { Json } from 'src/types/database.types';
import { Video } from 'src/types/channel.types';
import YTDlpWrap from 'yt-dlp-wrap';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

interface YtDlpChannelEntry {
  id?: string;
}

interface YtDlpChannelInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  uploader_id?: string;
  channel_id?: string;
  description?: string;
  thumbnail?: string;
  entries?: YtDlpChannelEntry[];
}

export type YoutubeProgressEvent =
  | { type: 'start'; total: number }
  | { type: 'video_start'; current: number; total: number; videoId: string }
  | {
      type: 'video_done';
      current: number;
      total: number;
      videoId: string;
      title: string;
    }
  | {
      type: 'video_skip';
      current: number;
      total: number;
      videoId: string;
      reason: string;
    }
  | {
      type: 'complete';
      success: number;
      failed: number;
      total: number;
      rssUrl: string;
    };

export type ProgressCallback = (event: YoutubeProgressEvent) => void;

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
  private cookiesFilePath: string | null = null;

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
        const cacheDir =
          process.env.YT_DLP_CACHE_DIR ||
          join(process.cwd(), '.cache', 'yt-dlp');
        await mkdir(cacheDir, { recursive: true });

        const r2CookiesKey = process.env.YOUTUBE_COOKIES_R2_KEY;
        if (r2CookiesKey) {
          try {
            const res = await this.s3Client.send(
              new GetObjectCommand({
                Bucket: r2Config.bucketName,
                Key: r2CookiesKey,
              }),
            );
            const body = await res.Body?.transformToString('utf-8');
            if (body) {
              const cookiesPath = join(cacheDir, 'cookies.txt');
              await writeFile(cookiesPath, body, 'utf-8');
              this.cookiesFilePath = cookiesPath;
              console.log('[YouTube] R2에서 쿠키 파일 다운로드 완료');
            }
          } catch (e) {
            console.error('[YouTube] 쿠키 파일 다운로드 실패:', e);
          }
        } else if (process.env.YOUTUBE_COOKIES_FILE) {
          this.cookiesFilePath = process.env.YOUTUBE_COOKIES_FILE;
          console.log('[YouTube] 쿠키 파일 경로 적용됨');
        }

        if (await this.tryUseYtDlpBinary(this.ytDlpCommand)) {
          return;
        }

        const binaryName =
          process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        const binaryPath = join(cacheDir, binaryName);

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
      url.includes('/c/') ||
      url.includes('/user/')
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
      return this.getCollectionInfoByYtDlp(url, 'playlist', error);
    }
  }

  private async getCollectionInfoByYtDlp(
    url: string,
    type: 'playlist' | 'channel',
    fallbackError?: unknown,
  ): Promise<{
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
      const ytDlpWrap = await this.resolveYtDlpWrap();
      const output = await ytDlpWrap.execPromise([
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-reverse',
        ...this.getBaseArgs(),
        url,
      ]);

      const info = JSON.parse(output) as YtDlpChannelInfo;
      const videoIds =
        info.entries
          ?.map((entry) => entry.id)
          .filter((id): id is string => Boolean(id)) || [];

      if (videoIds.length === 0) {
        throw new Error(`No videos found in YouTube ${type} URL.`);
      }

      return {
        channelInfo: {
          id:
            info.id ||
            info.channel_id ||
            info.uploader_id ||
            `youtube-${type}-${Date.now()}`,
          title:
            info.title ||
            (type === 'playlist' ? 'YouTube Playlist' : 'YouTube Channel'),
          url,
          thumbnail: info.thumbnail || undefined,
          author: info.uploader || info.channel || undefined,
          description: info.description || undefined,
        },
        videoIds,
      };
    } catch (error) {
      const originalMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : fallbackError
            ? JSON.stringify(fallbackError)
            : 'Unknown error';
      const fallbackMessage =
        error instanceof Error ? error.message : String(error);

      throw new Error(
        `Failed to get ${type} info: ${originalMessage}. Fallback with yt-dlp failed: ${fallbackMessage}`,
      );
    }
  }

  private getBaseArgs(): string[] {
    const args = ['--js-runtimes', 'node'];
    if (this.cookiesFilePath) {
      args.push('--cookies', this.cookiesFilePath);
    }
    return args;
  }

  private async getChannelInfo(url: string): Promise<{
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
    return this.getCollectionInfoByYtDlp(url, 'channel');
  }

  private async getVideoInfo(videoId: string): Promise<VideoInfo> {
    try {
      const ytDlpWrap = await this.resolveYtDlpWrap();
      const output = await ytDlpWrap.execPromise([
        '--dump-json',
        '--no-playlist',
        ...this.getBaseArgs(),
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

  private async downloadAudioBuffer(videoUrl: string): Promise<Buffer> {
    const ytDlpWrap = await this.resolveYtDlpWrap();
    const tempDir = await mkdtemp(join(tmpdir(), 'yt-audio-'));
    const tempFilePath = join(tempDir, 'audio.bin');

    try {
      await ytDlpWrap.execPromise([
        '-f',
        'bestaudio',
        '--no-playlist',
        '--no-part',
        ...this.getBaseArgs(),
        '-o',
        tempFilePath,
        videoUrl,
      ]);

      return await readFile(tempFilePath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async uploadAudio(
    videoId: string,
    videoUrl: string,
  ): Promise<{ url: string; size: number }> {
    const audioName = `${process.env.DOWNLOAD_FOLDER}/${videoId}.mp3`;

    try {
      let buffer: Buffer | null = null;
      let lastError: unknown;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          buffer = await this.downloadAudioBuffer(videoUrl);
          break;
        } catch (error) {
          lastError = error;

          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      if (!buffer) {
        throw new Error(
          `Failed to download audio after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }

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

  async makeUrl(
    url: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) {
    const urlType = this.getUrlType(url);

    if (urlType === 'unknown') {
      throw new Error(
        'Unsupported YouTube URL. Use video, playlist, or channel URL.',
      );
    }

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
    } else if (urlType === 'channel') {
      const channelData = await this.getChannelInfo(url);
      videoIds = channelData.videoIds;
      channelInfo = channelData.channelInfo;
    } else {
      const playlistData = await this.getPlaylistInfo(url);
      videoIds = playlistData.videoIds;
      channelInfo = playlistData.channelInfo;
    }

    console.log(`[YouTube] 총 ${videoIds.length}개 영상 처리 시작`);
    onProgress?.({ type: 'start', total: videoIds.length });

    const results: VideoInfo[] = [];
    const errors: { videoId: string; error: string }[] = [];

    for (let i = 0; i < videoIds.length; i++) {
      if (signal?.aborted) {
        console.log('[YouTube] 처리 중단됨 (클라이언트 연결 종료)');
        break;
      }

      const videoId = videoIds[i];
      const current = i + 1;

      console.log(
        `[YouTube] (${current}/${videoIds.length}) 처리 중: ${videoId}`,
      );
      onProgress?.({
        type: 'video_start',
        current,
        total: videoIds.length,
        videoId,
      });

      try {
        const result = await this.processVideo(videoId);
        results.push(result);
        console.log(
          `[YouTube] (${current}/${videoIds.length}) 완료: ${result.title}`,
        );
        onProgress?.({
          type: 'video_done',
          current,
          total: videoIds.length,
          videoId,
          title: result.title,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isPrivate =
          message.includes('Private video') ||
          message.includes('Sign in if you');
        console.warn(
          `[YouTube] (${current}/${videoIds.length}) ${isPrivate ? '비공개 영상 건너뜀' : '오류'}: ${videoId} — ${message}`,
        );
        onProgress?.({
          type: 'video_skip',
          current,
          total: videoIds.length,
          videoId,
          reason: isPrivate ? '비공개 영상' : message,
        });
        errors.push({ videoId, error: message });
      }

      if (i < videoIds.length - 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }

    console.log(
      `[YouTube] 처리 완료 — 성공: ${results.length}, 실패: ${errors.length}`,
    );

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

  async processAndSave(
    url: string,
    baseUrl: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.makeUrl(url, onProgress, signal);
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

      const rssUrl = `${baseUrl}/rss/${channelId}`;
      onProgress?.({
        type: 'complete',
        success: result.success,
        failed: result.failed,
        total: result.total,
        rssUrl,
      });
      return rssUrl;
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

      const rssUrl = `${baseUrl}/rss/${channelId}`;
      onProgress?.({
        type: 'complete',
        success: result.success,
        failed: result.failed,
        total: result.total,
        rssUrl,
      });
      return rssUrl;
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

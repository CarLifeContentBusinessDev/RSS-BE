import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { constants, createReadStream } from 'fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { r2Config } from 'src/common/config/r2.config';
import { ChannelDbService } from 'src/shared/services/channel-db.service';
import { Video } from 'src/types/channel.types';
import type { Json } from 'src/types/database.types';
import { VideoInfo } from 'src/types/youtube.types';
import YTDlpWrap from 'yt-dlp-wrap';
import ytpl from 'ytpl';

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
    }
  | { type: 'ping' };

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
        // n-challenge solver가 node를 찾을 수 있도록 현재 프로세스의 node 경로를 PATH에 추가
        const nodeBinDir = dirname(process.execPath);
        const pathSep = delimiter;
        if (!process.env.PATH?.includes(nodeBinDir)) {
          process.env.PATH = `${nodeBinDir}${pathSep}${process.env.PATH || ''}`;
        }

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

        // 14일 초과 시 재다운로드 — n-challenge solver 등 YouTube 대응 개선 반영
        const MAX_BINARY_AGE_MS = 14 * 24 * 60 * 60 * 1000;
        if (await this.fileExists(binaryPath)) {
          try {
            const { mtimeMs } = await stat(binaryPath);
            if (Date.now() - mtimeMs > MAX_BINARY_AGE_MS) {
              console.log(
                '[YouTube] yt-dlp 바이너리 14일 초과 — 최신 버전 다운로드 중...',
              );
              await rm(binaryPath, { force: true });
            }
          } catch {
            // stat 실패 시 기존 파일 유지
          }
        }

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
    // ytpl can undercount playlist entries for restricted/private items.
    // Prefer yt-dlp first so we get the most complete entry list.
    try {
      return await this.getCollectionInfoByYtDlp(url, 'playlist');
    } catch {
      // Fallback to ytpl below.
    }

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
      const output = await this.execWithTimeout(ytDlpWrap, [
        '--flat-playlist',
        '--dump-single-json',
        '--playlist-reverse',
        ...this.getTabArgs(),
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

  // playlist/channel 목록 조회용 — youtube:tab 추출기가 데스크톱 HTML을 요구하므로 UA 오버라이드 없음
  private getTabArgs(): string[] {
    if (this.cookiesFilePath) {
      return ['--cookies', this.cookiesFilePath];
    }
    return [];
  }

  // 개별 영상 정보/다운로드용 — web/web_safari 클라이언트는 쿠키 인증 시 PO Token 불필요
  // yt-dlp 2026.03+ 기본값이 deno로 변경됨 — node를 명시적으로 지정해야 n-challenge 해결 가능
  private getVideoArgs(): string[] {
    const args: string[] = [
      '--js-runtimes',
      'node',
      '--extractor-args',
      'youtube:player_client=web,web_safari',
    ];
    if (this.cookiesFilePath) {
      args.unshift('--cookies', this.cookiesFilePath);
    }
    return args;
  }

  private async execWithTimeout(
    wrapper: YTDlpWrap,
    args: string[],
  ): Promise<string> {
    const timeoutMs = Number(process.env.YT_DLP_TIMEOUT_MS) || 120000;
    const execPromise = wrapper.execPromise(args);
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    );

    try {
      return await Promise.race([execPromise, timeoutPromise]);
    } catch (e) {
      console.error(
        '[YouTube] yt-dlp exec error/timeout:',
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
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
      const output = await this.execWithTimeout(ytDlpWrap, [
        '--dump-json',
        '--no-playlist',
        ...this.getVideoArgs(),
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

  // 변경됨: Buffer 대신 파일 경로와 임시 폴더 반환
  private async downloadAudioFile(
    videoUrl: string,
  ): Promise<{ tempFilePath: string; tempDir: string }> {
    const ytDlpWrap = await this.resolveYtDlpWrap();
    const tempDir = await mkdtemp(join(tmpdir(), 'yt-audio-'));
    const tempFilePath = join(tempDir, 'audio.bin');

    await this.execWithTimeout(ytDlpWrap, [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--no-part',
      ...this.getVideoArgs(),
      '-o',
      tempFilePath,
      videoUrl,
    ]);

    return { tempFilePath, tempDir };
  }

  // 변경됨: 스트림을 사용하여 S3/R2에 업로드
  async uploadAudio(
    videoId: string,
    videoUrl: string,
  ): Promise<{ url: string; size: number }> {
    const audioName = `${process.env.DOWNLOAD_FOLDER}/${videoId}.mp3`;
    let tempFilePath = '';
    let tempDir = '';

    try {
      // 우선 R2에 해당 오디오가 이미 존재하는지 확인합니다. 존재하면 재다운로드/업로드를 건너뜁니다.
      try {
        const head = await this.s3Client.send(
          new HeadObjectCommand({
            Bucket: r2Config.bucketName,
            Key: audioName,
          }),
        );
        const existingSize = head.ContentLength ?? 0;
        console.log(
          `[YouTube] 오디오가 이미 존재하여 업로드 건너뜀: ${audioName}`,
        );
        return {
          url: `${r2Config.publicUrl}/${audioName}`,
          size: existingSize,
        };
      } catch (headErr: unknown) {
        // NotFound(404)가 아닌 다른 에러일 경우 경고만 남기고 계속 진행
        const err = headErr as Record<string, unknown> | null | undefined;
        const isNotFound =
          err &&
          (err['name'] === 'NotFound' ||
            (err['$metadata'] as Record<string, unknown> | undefined)?.[
              'httpStatusCode'
            ] === 404);
        if (!isNotFound) {
          console.warn(
            '[YouTube] R2 헤더 조회 중 에러 발생, 다운로드 시도 계속:',
            headErr,
          );
        }
        // 없으면 계속 진행하여 다운로드/업로드 수행
      }
      let downloadedInfo: { tempFilePath: string; tempDir: string } | null =
        null;
      let lastError: unknown;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          downloadedInfo = await this.downloadAudioFile(videoUrl);
          break;
        } catch (error) {
          lastError = error;

          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      if (!downloadedInfo) {
        throw new Error(
          `Failed to download audio after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      }

      tempFilePath = downloadedInfo.tempFilePath;
      tempDir = downloadedInfo.tempDir;

      const fileStats = await stat(tempFilePath);
      const fileStream = createReadStream(tempFilePath);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: r2Config.bucketName,
          Key: audioName,
          Body: fileStream,
          ContentType: 'audio/mpeg',
          ContentLength: fileStats.size,
          Metadata: {
            'src-size': String(fileStats.size),
          },
        }),
      );

      return {
        url: `${r2Config.publicUrl}/${audioName}`,
        size: fileStats.size,
      };
    } catch (error) {
      console.error(
        '오디오 업로드 실패:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      // 임시 폴더 및 파일은 업로드 성공/실패 여부와 상관없이 무조건 정리
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch((e) =>
          console.error('임시 파일 삭제 실패:', e),
        );
      }
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

  private safeCallback(
    callback: ProgressCallback | undefined,
    event: YoutubeProgressEvent,
    signal?: AbortSignal,
  ): void {
    if (!callback || signal?.aborted) return;
    try {
      callback(event);
    } catch (error) {
      console.error('[YouTube] 콜백 에러:', error);
      // 콜백 에러는 무시하고 계속 진행
    }
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
    this.safeCallback(
      onProgress,
      { type: 'start', total: videoIds.length },
      signal,
    );

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
      this.safeCallback(
        onProgress,
        {
          type: 'video_start',
          current,
          total: videoIds.length,
          videoId,
        },
        signal,
      );

      const keepaliveTimer = onProgress
        ? setInterval(
            () => this.safeCallback(onProgress, { type: 'ping' }, signal),
            20000,
          )
        : null;

      try {
        const result = await this.processVideo(videoId);
        results.push(result);
        console.log(
          `[YouTube] (${current}/${videoIds.length}) 완료: ${result.title}`,
        );
        this.safeCallback(
          onProgress,
          {
            type: 'video_done',
            current,
            total: videoIds.length,
            videoId,
            title: result.title,
          },
          signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isPrivate =
          message.includes('Private video') ||
          message.includes('Sign in if you');
        const isDRM = message.includes('DRM protected');
        const skipReason = isPrivate
          ? '비공개 영상'
          : isDRM
            ? 'DRM 보호 영상'
            : null;
        console.warn(
          `[YouTube] (${current}/${videoIds.length}) ${skipReason ? `${skipReason} 건너뜀` : '오류'}: ${videoId} — ${message}`,
        );
        this.safeCallback(
          onProgress,
          {
            type: 'video_skip',
            current,
            total: videoIds.length,
            videoId,
            reason: skipReason ?? message,
          },
          signal,
        );
        errors.push({ videoId, error: message });
      } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
      }

      if (i < videoIds.length - 1 && !signal?.aborted) {
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

    // 연결 종료 후 DB 저장 시도를 방지
    if (signal?.aborted) {
      console.log('[YouTube] 연결 중단됨 — DB 저장 스킵');
      throw new Error('Process aborted by client');
    }

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
      this.safeCallback(
        onProgress,
        {
          type: 'complete',
          success: result.success,
          failed: result.failed,
          total: result.total,
          rssUrl,
        },
        signal,
      );
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
      this.safeCallback(
        onProgress,
        {
          type: 'complete',
          success: result.success,
          failed: result.failed,
          total: result.total,
          rssUrl,
        },
        signal,
      );
      return rssUrl;
    }

    throw new Error('Failed to process YouTube URL');
  }

  async updateChannel(
    channelId: string,
    url: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{ newEpisodes: number; totalEpisodes: number }> {
    const fullChannelId = `youtube-${channelId}`;
    const existingChannel =
      await this.channelDbService.getChannel(fullChannelId);

    if (!existingChannel) {
      throw new Error('Channel not found');
    }

    const existingVideoIds = new Set(
      existingChannel.videos.map((v: Video) => v.id),
    );
    const result = await this.makeUrl(url, onProgress, signal);

    // 연결 종료 후 DB 저장 시도를 방지
    if (signal?.aborted) {
      console.log('[YouTube] 연결 중단됨 — DB 저장 스텝');
      throw new Error('Process aborted by client');
    }

    const newVideos = result.videos.filter(
      (video) => !existingVideoIds.has(video.videoId),
    );

    const baseUrl =
      process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const rssUrl = `${baseUrl}/rss/${fullChannelId}`;

    if (newVideos.length === 0) {
      this.safeCallback(
        onProgress,
        {
          type: 'complete',
          success: 0,
          failed: 0,
          total: result.total,
          rssUrl,
        },
        signal,
      );
      return {
        newEpisodes: 0,
        totalEpisodes: existingChannel.videos.length,
      };
    }

    const newVideoItems = newVideos.map((v) => this.convertToVideo(v));
    const updatedVideos = [...newVideoItems, ...existingChannel.videos];

    await this.channelDbService.updateChannelVideos(
      fullChannelId,
      updatedVideos,
    );

    this.safeCallback(
      onProgress,
      {
        type: 'complete',
        success: newVideos.length,
        failed: result.failed,
        total: result.total,
        rssUrl,
      },
      signal,
    );

    return {
      newEpisodes: newVideos.length,
      totalEpisodes: updatedVideos.length,
    };
  }

  // ⚠️ 임시 디버그용 — 진단 끝나면 삭제
  async debugTestCookies(): Promise<{
    ok: boolean;
    cookiesFilePath: string | null;
    ytDlpVersion?: string;
    testResult?: string;
    error?: string;
    baseArgs?: string[];
  }> {
    try {
      const ytDlpWrap = await this.resolveYtDlpWrap();
      const version = await ytDlpWrap.getVersion();
      const videoArgs = this.getVideoArgs();

      const args = [
        '--simulate',
        '--print',
        'title',
        ...videoArgs,
        'https://www.youtube.com/watch?v=jokNw9t1iaA',
      ];

      const output = await this.execWithTimeout(ytDlpWrap, args);

      return {
        ok: true,
        cookiesFilePath: this.cookiesFilePath,
        ytDlpVersion: version,
        testResult: output.trim(),
        baseArgs: videoArgs,
      };
    } catch (error) {
      return {
        ok: false,
        cookiesFilePath: this.cookiesFilePath,
        error: error instanceof Error ? error.message : String(error),
        baseArgs: this.getVideoArgs(),
      };
    }
  }
}

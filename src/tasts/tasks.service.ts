import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelDbService } from '../shared/services/channel-db.service';
import { PodbbangService } from '../modules/podbbang/podbbang.service';
import { SpotifyService } from '../modules/spotify/spotify.service';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly channelDbService: ChannelDbService,
    private readonly podbbangService: PodbbangService,
    private readonly spotifyService: SpotifyService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    try {
      const channels = await this.channelDbService.getAllChannels();
      const results = await Promise.allSettled(
        channels.map(async (channel) => {
          try {
            if (channel.type === 'podbbang') {
              const realId = channel.id.replace('podbbang_', '');
              const episodes =
                await this.podbbangService.updatePodbbangChannel(realId);
              await this.channelDbService.updateChannelVideos(
                channel.id,
                episodes,
              );

              return `[Podbbang] ${channel.title} 업데이트 완료`;
            } else if (channel.type === 'spotify') {
              const showId = channel.id.replace('spotify_', '');
              const showUrl = `https://open.spotify.com/show/$${showId}`;
              const episodes =
                await this.spotifyService.updateSpotifyShow(showUrl);
              await this.channelDbService.updateChannelVideos(
                channel.id,
                episodes,
              );

              return `[Spotify] ${channel.title} 업데이트 완료`;
            }
          } catch (e) {
            const errorMsg = e instanceof Error ? e.message : 'Unknown error';
            this.logger.error(
              `채널 업데이트 실패 (${channel.title}): ${errorMsg}`,
            );
            throw e;
          }
        }),
      );

      const successCount = results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failCount = results.filter((r) => r.status === 'rejected').length;

      this.logger.log(
        `업데이트 완료: 성공 ${successCount}건, 실패 ${failCount}건`,
      );
    } catch (error) {
      this.logger.error('스케줄러 전체 실행 중 치명적 오류 발생', error);
    }
  }
}

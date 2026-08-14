import { Module } from '@nestjs/common';
import { SharedModule } from './shared/shared.module';
import { ChannelModule } from './modules/channel/channel.module';
import { RssModule } from './modules/rss/rss.module';
import { PodbbangModule } from './modules/podbbang/podbbang.module';
import { SpotifyModule } from './modules/spotify/spotify.module';
import { YoutubeModule } from './modules/youtube/youtube.module';
import { ApplePodcastsModule } from './modules/apple-podcasts/apple-podcasts.module';
import { CustomModule } from './modules/custom/custom.module';
import { AppController } from './app.controller';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksService } from './tasts/tasks.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SharedModule,
    ChannelModule,
    RssModule,
    PodbbangModule,
    SpotifyModule,
    YoutubeModule,
    ApplePodcastsModule,
    CustomModule,
  ],
  controllers: [AppController],
  providers: [TasksService],
})
export class AppModule {}

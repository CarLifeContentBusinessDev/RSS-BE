import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ChannelDbService } from '../../shared/services/channel-db.service';
import { PodbbangService } from '../podbbang/podbbang.service';
import { SpotifyService } from '../spotify/spotify.service';
import { ApplePodcastsService } from '../apple-podcasts/apple-podcasts.service';

@Controller('api')
export class ChannelController {
  constructor(
    private readonly channelDbService: ChannelDbService,
    private readonly podbbangService: PodbbangService,
    private readonly spotifyService: SpotifyService,
    private readonly applePodcastsService: ApplePodcastsService,
  ) {}

  @Get('health')
  async health() {
    try {
      const channels = await this.channelDbService.getAllChannels();
      return {
        status: 'ok',
        message: 'YouTube RSS Maker is running',
        channels: channels.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('channels')
  async getChannels() {
    try {
      const channels = await this.channelDbService.getAllChannels();
      return { channels };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete('channel/:channelId')
  async deleteChannel(@Param('channelId') channelId: string) {
    try {
      const channel = await this.channelDbService.getChannel(channelId);
      if (!channel) {
        throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
      }

      await this.channelDbService.deleteChannel(channelId);
      return { success: true, message: 'Channel deleted successfully' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('podbbang/channel')
  async addPodbbangChannel(@Body() body: { channelId: string }) {
    const { channelId } = body;

    if (!channelId) {
      throw new HttpException('channelId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const { channelInfo, episodes } =
        await this.podbbangService.fetchPodbbangChannel(channelId);

      const channelData = {
        ...channelInfo,
        id: `podbbang_${channelId}`,
        type: 'podbbang',
        category: null,
        content_type: null,
        publisher: channelInfo.author,
        host: channelInfo.author,
        tags: [],
      };

      await this.channelDbService.addChannel(channelData);

      await this.channelDbService.updateChannelVideos(
        `podbbang_${channelId}`,
        episodes,
      );

      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
      return {
        rssUrl: `${baseUrl}/rss/podbbang_${channelId}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('podbbang/update/:channelId')
  async updatePodbbangChannel(@Param('channelId') channelId: string) {
    const fullChannelId = `podbbang_${channelId}`;

    try {
      const channel = await this.channelDbService.getChannel(fullChannelId);

      if (!channel) {
        throw new HttpException(
          '채널이 존재하지 않습니다.',
          HttpStatus.NOT_FOUND,
        );
      }

      const episodes =
        await this.podbbangService.updatePodbbangChannel(channelId);
      await this.channelDbService.updateChannelVideos(fullChannelId, episodes);

      return {
        success: true,
        updated: episodes.length,
      };
    } catch (error) {
      console.error('Error updating Podbbang channel:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('spotify/show')
  async addSpotifyShow(
    @Body() body: { showUrl?: string; spotifyUrl?: string; showId?: string },
  ) {
    let url = body.spotifyUrl || body.showUrl;

    if (!url && body.showId) {
      url = `https://open.spotify.com/show/${body.showId}`;
    }

    if (!url) {
      throw new HttpException(
        'spotifyUrl, showUrl, or showId is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const feedUrl =
        await this.applePodcastsService.getRssFeedFromSpotify(url);

      return {
        feedUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.NOT_FOUND);
    }
  }

  @Post('spotify/update/:showId')
  async updateSpotifyShow(@Param('showId') showId: string) {
    const fullChannelId = `spotify_${showId}`;

    try {
      const channel = await this.channelDbService.getChannel(fullChannelId);

      if (!channel) {
        throw new HttpException(
          '채널이 존재하지 않습니다.',
          HttpStatus.NOT_FOUND,
        );
      }

      const showUrl = `https://open.spotify.com/show/${showId}`;
      const episodes = await this.spotifyService.updateSpotifyShow(showUrl);
      await this.channelDbService.updateChannelVideos(fullChannelId, episodes);

      return {
        success: true,
        updated: episodes.length,
      };
    } catch (error) {
      console.error('Error updating Spotify show:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('spotify/find-rss')
  async findSpotifyRss(@Body() body: { spotifyUrl: string }) {
    const { spotifyUrl } = body;

    if (!spotifyUrl) {
      throw new HttpException('spotifyUrl is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const { channelInfo } =
        await this.spotifyService.fetchSpotifyShow(spotifyUrl);

      const feedUrl = await this.applePodcastsService.getRssFeedFromSpotify(
        spotifyUrl,
        channelInfo.title,
      );

      const showIdMatch = spotifyUrl.match(/show\/([a-zA-Z0-9]+)/);
      const showId = showIdMatch ? showIdMatch[1] : channelInfo.id;
      const fullChannelId = `spotify_${showId}`;
      const channelData = {
        ...channelInfo,
        id: fullChannelId,
        type: 'spotify',
        category: null,
        content_type: null,
        publisher: channelInfo.author,
        host: channelInfo.author,
        tags: [],
        videos: [],
        external_rss_url: feedUrl,
      };

      await this.channelDbService.addChannel(channelData);

      return {
        feedUrl,
        channelId: fullChannelId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message.includes('Active premium subscription required')) {
        throw new HttpException(
          'Spotify API access denied: app owner needs an active Premium subscription.',
          HttpStatus.FORBIDDEN,
        );
      }

      if (message.includes('Failed to get Spotify token')) {
        throw new HttpException(message, HttpStatus.UNAUTHORIZED);
      }

      if (
        message.includes('Podcast not found on Apple Podcasts') ||
        message.includes('No matching podcast found') ||
        message.includes('RSS feed URL not available')
      ) {
        throw new HttpException(message, HttpStatus.NOT_FOUND);
      }

      throw new HttpException(message, HttpStatus.BAD_GATEWAY);
    }
  }

  @Get('spotify/find-rss')
  async findSpotifyRssByQuery(@Query('spotifyUrl') spotifyUrl: string) {
    return this.findSpotifyRss({ spotifyUrl });
  }
}

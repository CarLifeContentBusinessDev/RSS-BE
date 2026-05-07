import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import {
  ChannelInsert,
  ChannelUpdate,
  ChannelRow,
} from '../../types/database.types';
import type { Json } from '../../types/database.types';
import { Channel, Video } from '../../types/channel.types';

@Injectable()
export class ChannelDbService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private readonly channelListColumns =
    'id,title,url,thumbnail,type,episode_count,description,summary,author,copyright,owner,language,added_at,last_update,category,content_type,publisher,host,tags,external_rss_url';

  async addChannel(
    channel: Omit<ChannelInsert, 'added_at' | 'last_update'>,
  ): Promise<Channel> {
    const supabase = this.supabaseService.getClient();

    const newChannel: ChannelInsert = {
      id: channel.id,
      title: channel.title,
      url: channel.url,
      thumbnail: channel.thumbnail || null,
      type: channel.type || 'youtube',
      videos: (channel.videos || []) as unknown as Json,
      episode_count: Array.isArray(channel.videos) ? channel.videos.length : 0,
      description: channel.description || null,
      summary: channel.summary || null,
      author: channel.author || null,
      copyright: channel.copyright || null,
      owner: (channel.owner || null) as unknown as Json,
      language: channel.language || 'ko',
      added_at: new Date().toISOString(),
      last_update: null,
      category: channel.category ?? null,
      content_type: channel.content_type ?? null,
      publisher: channel.publisher ?? null,
      host: channel.host ?? null,
      tags: (channel.tags ?? null) as Json | null,
      external_rss_url: channel.external_rss_url ?? null,
    };

    const { data, error } = await supabase
      .from('channels')
      .upsert([newChannel], { onConflict: 'id' })
      .select()
      .single();

    if (error) {
      console.error('Failed to add channel:', error);
      throw new Error(error.message);
    }

    return this.formatChannel(data);
  }

  async getAllChannels(includeVideos = false): Promise<Channel[]> {
    const supabase = this.supabaseService.getClient();
    const selectColumns = includeVideos ? '*' : this.channelListColumns;

    const { data, error } = await supabase
      .from('channels')
      .select(selectColumns as any)
      .order('added_at', { ascending: false });

    if (error) {
      console.error('Failed to get channels:', error);
      throw new Error(error.message);
    }

    return (data ?? []).map((channel) =>
      this.formatChannel(channel as unknown as ChannelRow),
    );
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      console.error('Failed to get channel:', error);
      throw new Error(error.message);
    }

    return this.formatChannel(data);
  }

  async updateChannelVideos(
    channelId: string,
    videos: Video[],
  ): Promise<Channel> {
    const supabase = this.supabaseService.getClient();

    const updateData: ChannelUpdate = {
      videos: videos as unknown as Json,
      episode_count: videos.length,
      last_update: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('channels')
      .update(updateData)
      .eq('id', channelId)
      .select()
      .single();

    if (error) {
      console.error('Failed to update channel videos:', error);
      throw new Error(error.message);
    }

    return this.formatChannel(data);
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    const supabase = this.supabaseService.getClient();

    const { error } = await supabase
      .from('channels')
      .delete()
      .eq('id', channelId);

    if (error) {
      console.error('Failed to delete channel:', error);
      throw new Error(error.message);
    }

    return true;
  }

  private getEpisodeCountFromVideos(videos: Json): number {
    return Array.isArray(videos) ? videos.length : 0;
  }

  private resolveEpisodeCount(data: ChannelRow): number {
    const episodeCount = (data as { episode_count?: unknown }).episode_count;

    if (typeof episodeCount === 'number') {
      return episodeCount;
    }

    return this.getEpisodeCountFromVideos(data.videos);
  }

  private formatChannel(data: ChannelRow): Channel {
    return {
      id: data.id,
      title: data.title,
      url: data.url,
      thumbnail: data.thumbnail || undefined,
      type: data.type,
      addedAt: data.added_at,
      lastUpdate: data.last_update || undefined,
      episodeCount: this.resolveEpisodeCount(data),
      videos: (data.videos as unknown as Video[]) || [],
      description: data.description || undefined,
      summary: data.summary || undefined,
      author: data.author || undefined,
      copyright: data.copyright || undefined,
      owner: data.owner as unknown as Channel['owner'],
      language: data.language,
      category: data.category || undefined,
      contentType: data.content_type || undefined,
      publisher: data.publisher || undefined,
      host: data.host || undefined,
      tags: (data.tags as unknown as string[]) || undefined,
      externalRssUrl: data.external_rss_url || undefined,
    };
  }
}

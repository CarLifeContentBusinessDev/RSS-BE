export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      channels: {
        Row: {
          id: string;
          title: string;
          url: string;
          thumbnail: string | null;
          type: string;
          videos: Json;
          episode_count: number | null;
          description: string | null;
          summary: string | null;
          author: string | null;
          copyright: string | null;
          owner: Json | null;
          language: string;
          added_at: string;
          last_update: string | null;
          category: string | null;
          content_type: string | null;
          publisher: string | null;
          host: string | null;
          tags: Json | null;
          external_rss_url: string | null;
        };
        Insert: {
          id: string;
          title: string;
          url: string;
          thumbnail?: string | null;
          type?: string;
          videos?: Json;
          episode_count?: number | null;
          description?: string | null;
          summary?: string | null;
          author?: string | null;
          copyright?: string | null;
          owner?: Json | null;
          language?: string;
          added_at?: string;
          last_update?: string | null;
          category?: string | null;
          content_type?: string | null;
          publisher?: string | null;
          host?: string | null;
          tags?: Json | null;
          external_rss_url?: string | null;
        };
        Update: {
          id?: string;
          title?: string;
          url?: string;
          thumbnail?: string | null;
          type?: string;
          videos?: Json;
          episode_count?: number | null;
          description?: string | null;
          summary?: string | null;
          author?: string | null;
          copyright?: string | null;
          owner?: Json | null;
          language?: string;
          added_at?: string;
          last_update?: string | null;
          category?: string | null;
          content_type?: string | null;
          publisher?: string | null;
          host?: string | null;
          tags?: Json | null;
          external_rss_url?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

export type ChannelRow = Database['public']['Tables']['channels']['Row'];
export type ChannelInsert = Database['public']['Tables']['channels']['Insert'];
export type ChannelUpdate = Database['public']['Tables']['channels']['Update'];

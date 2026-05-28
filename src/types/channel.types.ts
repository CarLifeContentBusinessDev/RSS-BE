export interface Channel {
  id: string;
  title: string;
  url: string;
  thumbnail?: string;
  type: string;
  addedAt: string;
  lastUpdate?: string;
  episodeCount: number;
  videos: Video[];
  description?: string;
  summary?: string;
  author?: string;
  copyright?: string;
  owner?: {
    name: string;
    email: string;
  };
  language: string;
  category?: string;
  contentType?: string;
  publisher?: string;
  host?: string;
  tags?: string[];
  externalRssUrl?: string;
}

export interface Video {
  id: string;
  title: string;
  description?: string;
  author?: string;
  url: string;
  audioPath?: string;
  audioSize?: number;
  thumbnail?: string;
  uploadDate?: string;
  publishedAt?: string;
  duration?: number | null;
  tags?: string[];
  contentType?: string;
}

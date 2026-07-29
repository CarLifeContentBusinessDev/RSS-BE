import { Module, Global } from '@nestjs/common';
import { SupabaseService } from './services/supabase.service';
import { ChannelDbService } from './services/channel-db.service';
import { R2StorageService } from './services/r2-storage.service';

@Global()
@Module({
  providers: [SupabaseService, ChannelDbService, R2StorageService],
  exports: [SupabaseService, ChannelDbService, R2StorageService],
})
export class SharedModule {}

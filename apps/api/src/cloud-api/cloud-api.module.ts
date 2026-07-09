import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { SettingsModule } from '../settings/settings.module';
import { CloudApiService } from './cloud-api.service';

@Module({
  imports: [MediaModule, SettingsModule],
  providers: [CloudApiService],
  exports: [CloudApiService],
})
export class CloudApiModule {}

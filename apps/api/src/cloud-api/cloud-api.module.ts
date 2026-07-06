import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { CloudApiService } from './cloud-api.service';

@Module({
  imports: [MediaModule],
  providers: [CloudApiService],
  exports: [CloudApiService],
})
export class CloudApiModule {}

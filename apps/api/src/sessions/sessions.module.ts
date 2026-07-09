import { Module } from '@nestjs/common';
import { AntibanModule } from '../antiban/antiban.module';
import { ContactsModule } from '../contacts/contacts.module';
import { MediaModule } from '../media/media.module';
import { SettingsModule } from '../settings/settings.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionsGateway } from './sessions.gateway';

@Module({
  imports: [AntibanModule, ContactsModule, MediaModule, SettingsModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionsGateway],
  exports: [SessionsService, SessionsGateway],
})
export class SessionsModule {}

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AntibanModule } from '../antiban/antiban.module';
import { QueueModule } from '../queue/queue.module';
import { AiService, AI_PROVIDER_TOKEN, type AiProvider } from './ai.service';
import { AiController } from './ai.controller';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Module({
  imports: [QueueModule, AntibanModule, ConfigModule],
  controllers: [AiController],
  providers: [
    {
      provide: AI_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AiProvider => {
        const providerName = config.get<string>('AI_PROVIDER') ?? 'anthropic';
        const aiModel = config.get<string>('AI_MODEL') ?? 'claude-haiku-4-5';
        const timeoutMs = +(config.get<string>('AI_TIMEOUT_MS') ?? '30000');
        if (providerName === 'openai') {
          return new OpenAiProvider(config.getOrThrow<string>('OPENAI_API_KEY'), aiModel, timeoutMs);
        }
        return new AnthropicProvider(config.getOrThrow<string>('ANTHROPIC_API_KEY'), aiModel, timeoutMs);
      },
    },
    AiService,
  ],
  exports: [AiService],
})
export class AiModule {}

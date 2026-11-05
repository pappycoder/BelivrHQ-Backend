import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { BotProtectionController } from './bot-protection.controller';
import { BotProtectionInterceptor } from './bot-protection.interceptor';
import { BotProtectionService } from './bot-protection.service';

@Module({
  imports: [AuthModule],
  controllers: [BotProtectionController],
  providers: [
    BotProtectionService,
    { provide: APP_INTERCEPTOR, useClass: BotProtectionInterceptor },
  ],
})
export class BotProtectionModule {}

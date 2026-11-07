import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MembersModule } from '../members/members.module';
import { VisitorsModule } from '../visitors/visitors.module';
import { IntakeController, IntakePublicController } from './intake.controller';
import { IntakeService } from './intake.service';
@Module({
  imports: [AuthModule, MembersModule, VisitorsModule],
  controllers: [IntakeController, IntakePublicController],
  providers: [IntakeService],
})
export class IntakeModule {}

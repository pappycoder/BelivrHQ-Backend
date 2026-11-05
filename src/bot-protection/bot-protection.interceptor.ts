import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { BotProtectionService } from './bot-protection.service';
import { protectedAction } from './protected-actions';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';

@Injectable()
export class BotProtectionInterceptor implements NestInterceptor {
  constructor(private readonly bots: BotProtectionService) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const path = decodeURIComponent(request.path)
      .replace(/^\/api\/v1/i, '')
      .replace(/\/$/, '');
    const policy = protectedAction(request.method, path);
    if (policy) {
      await this.bots.verify(
        request.method,
        path,
        request.body ?? {},
        policy.authenticated ? request.user?.sub : undefined,
      );
      delete request.body.altcha;
      delete request.body.website;
    }
    return next.handle();
  }
}

import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { SkipRateLimit } from '../common/guards/rate-limit.guard';
import { HealthService } from './health.service';

@ApiTags('Health')
@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness; independent of external services' })
  live() {
    return { status: 'alive', timestamp: new Date().toISOString(), uptime: process.uptime() };
  }

  @Get(['', 'ready'])
  @ApiOperation({ summary: 'Readiness, including dependency and worker availability' })
  @ApiResponse({ status: 200, description: 'All required services and workers are ready' })
  @ApiResponse({ status: 503, description: 'A required dependency or worker is unavailable' })
  async check(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.check();
    response.status(result.status === 'healthy' ? 200 : 503);
    return result;
  }
}

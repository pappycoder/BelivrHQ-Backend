/**
 * @file main.ts
 * @description Application entry point for the ChurchOS Backend API.
 *
 * This file bootstraps the NestJS application with the following configuration:
 * 1. Validates environment variables with Zod.
 * 2. Creates the NestJS application instance from AppModule.
 * 3. Sets a global URL prefix (`/api/v1`) for all routes.
 * 4. Configures a global ValidationPipe for incoming request validation.
 * 5. Registers global exception filter for standardized error responses.
 * 6. Enables CORS for the ChurchOS web frontend.
 * 7. Sets up Swagger/OpenAPI documentation at `/api/v1/docs`.
 * 8. Starts the HTTP server on the configured port.
 *
 * @module main
 * @since 1.0.0
 */

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { env } from './config/env.validation';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { SentryInterceptor } from './common/interceptors/sentry.interceptor';

/**
 * Bootstraps and starts the NestJS application.
 *
 * Steps performed:
 * - Validates environment variables with Zod (fails fast on missing vars).
 * - Creates the application from the root AppModule.
 * - Configures global route prefix `/api/v1`.
 * - Enables automatic DTO validation via ValidationPipe.
 * - Registers global exception filter for standardized error responses.
 * - Enables CORS for cross-origin requests from the web frontend.
 * - Generates and serves Swagger/OpenAPI documentation.
 * - Starts listening on the configured PORT.
 *
 * @returns {Promise<void>}
 */
async function bootstrap(): Promise<void> {
  // Initialize Sentry (only if SENTRY_DSN is set).
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
      profilesSampleRate: env.NODE_ENV === 'production' ? 0.05 : 1.0,
      sendDefaultPii: false,
      beforeSendTransaction(event) {
        if (event.request) {
          delete event.request.headers;
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          if (event.request.url) event.request.url = event.request.url.split('?')[0];
        }
        for (const span of event.spans ?? []) {
          span.data = {};
          if (span.description) span.description = span.description.split('?')[0];
        }
        return event;
      },
      beforeSend(event) {
        if (event.request) {
          delete event.request.headers;
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          if (event.request.url) event.request.url = event.request.url.split('?')[0];
        }
        return event;
      },
    });
  }

  // Create the NestJS application instance.
  // NestFactory.create() initializes the IoC container, resolves all modules,
  // and creates the underlying HTTP adapter (Express by default).
  // Keep the exact HTTP payload for signed payment webhooks. Providers sign
  // the raw bytes, so re-serializing a parsed JSON body is not safe.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Set a global prefix for all routes.
  // Every controller route will be prefixed with `/api/v1`.
  // Example: @Get('members') on MembersController → GET /api/v1/members
  app.setGlobalPrefix('api/v1');
  app.set('query parser', 'extended');

  // Enable security headers with Helmet.
  // Sets various HTTP headers to help protect the app from common web vulnerabilities.
  app.use(helmet());

  // Enable gzip compression.
  // Compresses response bodies for faster transfer to clients.
  app.use(compression());

  // Configure global ValidationPipe.
  // This pipe automatically validates incoming request bodies, query params,
  // and path params against class-validator decorators on DTO classes.
  // - whitelist: true → strips properties not defined in the DTO
  // - forbidNonWhitelisted: true → throws 400 if unknown properties are sent
  // - transform: true → automatically transforms payloads to DTO class instances
  // - enableImplicitConversion: true → converts query strings to their types (e.g., ?page=1 → number)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Register global exception filter.
  // Catches all unhandled exceptions and returns standardized JSON error responses.
  // Handles HttpException, ZodError, Prisma errors, and generic errors.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Register global logging interceptor.
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Register global response interceptor.
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Register global Sentry interceptor.
  app.useGlobalInterceptors(new SentryInterceptor());

  // Enable CORS (Cross-Origin Resource Sharing).
  // Allows the ChurchOS web frontend (Next.js) running on a different port/origin
  // to make API requests to this backend. Credentials are enabled to support
  // cookie-based authentication if needed.
  app.enableCors({
    origin: env.WEB_URL,
    credentials: true,
  });

  // Configure Swagger/OpenAPI documentation.
  // The DocumentBuilder creates a configuration object that defines the API
  // metadata: title, description, version, authentication scheme (Bearer JWT),
  // and endpoint tags for grouping related controllers.
  if (env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('ChurchOS API')
      .setDescription(
        'Church Management & Digital Ministry Platform API\n\n' +
          '## Overview\n' +
          'This API powers the ChurchOS platform: a comprehensive church management system ' +
          'built for Nigerian churches. It handles member management, attendance tracking, ' +
          'giving/donations, WhatsApp integration, event management, pastoral care, and more.\n\n' +
          '## Authentication\n' +
          'All protected endpoints require a valid Supabase Auth JWT token. ' +
          'Obtain a token via the `/auth/login` endpoint or Supabase client.\n\n' +
          '## Multi-Tenancy\n' +
          'All data is scoped by `church_id`. Users can only access data for their church.',
      )
      .setVersion('1.0')
      .setContact('ChurchOS Team', 'https://churchos.ng', 'support@churchos.ng')
      .setLicense('GPL-3.0', 'https://www.gnu.org/licenses/gpl-3.0.html')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your Supabase Auth JWT token',
          in: 'header',
        },
        'supabase-auth',
      )
      .build();

    // Generate the Swagger document and serve it.
    // SwaggerModule.createDocument() scans all controllers and their decorators
    // (@ApiProperty, @ApiOperation, etc.) to build the OpenAPI 3.0 spec.
    // SwaggerModule.setup() serves the Swagger UI at the specified path.
    const document = SwaggerModule.createDocument(app, config, {
      extraModels: [],
      deepScanRoutes: true,
    });
    SwaggerModule.setup('api/v1/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: false,
        docExpansion: 'none',
        filter: true,
        showRequestDuration: true,
      },
      customSiteTitle: 'ChurchOS API Documentation',
    });
  }

  // Start the HTTP server.
  // The PORT is read from validated environment variables.
  const port = env.PORT;
  await app.listen(port);

  // Enable graceful shutdown hooks.
  // Ensures Prisma, Redis, and other resources disconnect cleanly on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/v1/docs`);
}

// Execute the bootstrap function.
// This is the entry point called by Node.js when the application starts.
bootstrap();

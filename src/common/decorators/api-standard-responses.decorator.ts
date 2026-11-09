import { applyDecorators, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
} from '@nestjs/swagger';

/**
 * Standard error response schemas for Swagger documentation.
 */
const ERROR_RESPONSES = {
  unauthorized: {
    status: 401,
    description: 'Unauthorized: Invalid or missing JWT token',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'UNAUTHORIZED' },
            message: { type: 'string', example: 'Invalid or missing authentication token' },
          },
        },
      },
    },
  },
  forbidden: {
    status: 403,
    description: 'Forbidden: Insufficient permissions',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'FORBIDDEN' },
            message: {
              type: 'string',
              example: 'You do not have permission to perform this action',
            },
          },
        },
      },
    },
  },
  notFound: {
    status: 404,
    description: 'Not Found: Resource does not exist',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'NOT_FOUND' },
            message: { type: 'string', example: 'Resource not found' },
          },
        },
      },
    },
  },
  conflict: {
    status: 409,
    description: 'Conflict: Resource already exists',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'CONFLICT' },
            message: { type: 'string', example: 'Resource already exists' },
          },
        },
      },
    },
  },
  badRequest: {
    status: 400,
    description: 'Bad Request: Invalid input data',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string', example: 'Validation failed' },
            details: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  internalError: {
    status: 500,
    description: 'Internal Server Error',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'INTERNAL_ERROR' },
            message: { type: 'string', example: 'An unexpected error occurred' },
          },
        },
      },
    },
  },
};

/**
 * Decorator for documenting a standard CRUD create endpoint.
 *
 * @param summary - Brief description of the operation
 * @param description - Detailed description (optional)
 * @returns Combined decorators for operation, responses, and HTTP code
 *
 * @example
 * ```typescript
 * @ApiCreateEndpoint('Create a new member')
 * @Post()
 * async create(@Body() dto: CreateMemberDto) { ... }
 * ```
 */
export function ApiCreateEndpoint(summary: string, description?: string) {
  return applyDecorators(
    HttpCode(HttpStatus.CREATED),
    ApiOperation({ summary, description: description || summary }),
    ApiResponse({ status: 201, description: 'Resource created successfully' }),
    ApiBadRequestResponse(ERROR_RESPONSES.badRequest),
    ApiUnauthorizedResponse(ERROR_RESPONSES.unauthorized),
    ApiForbiddenResponse(ERROR_RESPONSES.forbidden),
    ApiConflictResponse(ERROR_RESPONSES.conflict),
    ApiInternalServerErrorResponse(ERROR_RESPONSES.internalError),
  );
}

/**
 * Decorator for documenting a standard CRUD read (list) endpoint.
 *
 * @param summary - Brief description of the operation
 * @param description - Detailed description (optional)
 * @returns Combined decorators for operation, responses
 *
 * @example
 * ```typescript
 * @ApiListEndpoint('List all members')
 * @Get()
 * async findAll() { ... }
 * ```
 */
export function ApiListEndpoint(summary: string, description?: string) {
  return applyDecorators(
    ApiOperation({ summary, description: description || summary }),
    ApiResponse({ status: 200, description: 'List retrieved successfully' }),
    ApiUnauthorizedResponse(ERROR_RESPONSES.unauthorized),
    ApiForbiddenResponse(ERROR_RESPONSES.forbidden),
    ApiInternalServerErrorResponse(ERROR_RESPONSES.internalError),
  );
}

/**
 * Decorator for documenting a standard CRUD read (single) endpoint.
 *
 * @param summary - Brief description of the operation
 * @param description - Detailed description (optional)
 * @returns Combined decorators for operation, responses
 *
 * @example
 * ```typescript
 * @ApiGetEndpoint('Get member by ID')
 * @Get(':id')
 * async findOne(@Param('id') id: string) { ... }
 * ```
 */
export function ApiGetEndpoint(summary: string, description?: string) {
  return applyDecorators(
    ApiOperation({ summary, description: description || summary }),
    ApiResponse({ status: 200, description: 'Resource retrieved successfully' }),
    ApiNotFoundResponse(ERROR_RESPONSES.notFound),
    ApiUnauthorizedResponse(ERROR_RESPONSES.unauthorized),
    ApiForbiddenResponse(ERROR_RESPONSES.forbidden),
    ApiInternalServerErrorResponse(ERROR_RESPONSES.internalError),
  );
}

/**
 * Decorator for documenting a standard CRUD update endpoint.
 *
 * @param summary - Brief description of the operation
 * @param description - Detailed description (optional)
 * @returns Combined decorators for operation, responses
 *
 * @example
 * ```typescript
 * @ApiUpdateEndpoint('Update member details')
 * @Patch(':id')
 * async update(@Param('id') id: string, @Body() dto: UpdateMemberDto) { ... }
 * ```
 */
export function ApiUpdateEndpoint(summary: string, description?: string) {
  return applyDecorators(
    ApiOperation({ summary, description: description || summary }),
    ApiResponse({ status: 200, description: 'Resource updated successfully' }),
    ApiBadRequestResponse(ERROR_RESPONSES.badRequest),
    ApiNotFoundResponse(ERROR_RESPONSES.notFound),
    ApiUnauthorizedResponse(ERROR_RESPONSES.unauthorized),
    ApiForbiddenResponse(ERROR_RESPONSES.forbidden),
    ApiConflictResponse(ERROR_RESPONSES.conflict),
    ApiInternalServerErrorResponse(ERROR_RESPONSES.internalError),
  );
}

/**
 * Decorator for documenting a standard CRUD delete endpoint.
 *
 * @param summary - Brief description of the operation
 * @param description - Detailed description (optional)
 * @returns Combined decorators for operation, responses
 *
 * @example
 * ```typescript
 * @ApiDeleteEndpoint('Delete a member')
 * @Delete(':id')
 * async remove(@Param('id') id: string) { ... }
 * ```
 */
export function ApiDeleteEndpoint(summary: string, description?: string) {
  return applyDecorators(
    HttpCode(HttpStatus.NO_CONTENT),
    ApiOperation({ summary, description: description || summary }),
    ApiResponse({ status: 204, description: 'Resource deleted successfully' }),
    ApiNotFoundResponse(ERROR_RESPONSES.notFound),
    ApiUnauthorizedResponse(ERROR_RESPONSES.unauthorized),
    ApiForbiddenResponse(ERROR_RESPONSES.forbidden),
    ApiInternalServerErrorResponse(ERROR_RESPONSES.internalError),
  );
}

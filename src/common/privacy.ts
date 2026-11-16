import { HttpException } from '@nestjs/common';

export const HTTP_LOG_REDACTIONS = [
  'req.headers',
  'req.query',
  'req.params',
  'req.body',
  'req.url',
  'res.headers',
  'err.message',
  'err.stack',
  'err.cause',
];

/** Public-link path segments are bearer credentials, just like query tokens. */
export function observationText(value: string): string {
  return value
    .split(/[?#]/)[0]
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/((?:forms|intake|register)\/public\/)[^/\s]+/gi, '$1[redacted]');
}

/** Log the registered route template, never a caller-controlled unmatched path. */
export function requestLogPath(request: { route?: { path?: unknown } }): string {
  return typeof request.route?.path === 'string'
    ? observationText(request.route.path)
    : '/unmatched';
}

/** Provider/Prisma exception messages and stacks can contain credentials or record values. */
export function errorDiagnostic(error: unknown): string {
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^P\d{4}$/.test(error.code)
  )
    return error.code;
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  return 'unexpected_error';
}

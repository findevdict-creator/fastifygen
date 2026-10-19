import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** An error with an HTTP status and a stable code, sent in Directus' error format. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }

  toJSON() {
    return { errors: [{ message: this.message, extensions: { code: this.code, ...this.extensions } }] };
  }
}

export class InvalidQueryError extends ApiError {
  constructor(message: string) {
    super(message, 400, 'INVALID_QUERY');
  }
}

export class InvalidPayloadError extends ApiError {
  constructor(message: string, extensions: Record<string, unknown> = {}) {
    super(message, 400, 'INVALID_PAYLOAD', extensions);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "You don't have permission to access this") {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Item not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class RouteNotFoundError extends ApiError {
  constructor(method: string, url: string) {
    super(`Route ${method} ${url} doesn't exist`, 404, 'ROUTE_NOT_FOUND');
  }
}

export class MethodNotAllowedError extends ApiError {
  constructor(message: string) {
    super(message, 405, 'METHOD_NOT_ALLOWED');
  }
}

interface PostgresError {
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
  table?: string;
}

/** Turns known errors into {@link ApiError}s and sends every error in one format. */
export class ErrorMapper {
  static toApiError(error: unknown): ApiError | null {
    if (error instanceof ApiError) return error;

    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      const isQuery = fastifyError.validationContext === 'querystring' || fastifyError.validationContext === 'params';
      return isQuery ? new InvalidQueryError(fastifyError.message) : new InvalidPayloadError(fastifyError.message);
    }

    const pg = error as PostgresError;
    const extra = { ...(pg.constraint ? { constraint: pg.constraint } : {}), ...(pg.column ? { field: pg.column } : {}) };
    switch (pg.code) {
      case '23503':
        return new ApiError(pg.detail ?? 'Referenced item does not exist', 400, 'INVALID_FOREIGN_KEY', extra);
      case '23505':
        return new ApiError(pg.detail ?? 'Value must be unique', 400, 'RECORD_NOT_UNIQUE', extra);
      case '23502':
        return new ApiError(`Value for "${pg.column ?? 'field'}" is required`, 400, 'NOT_NULL_VIOLATION', extra);
      case '23514':
        return new ApiError('Value does not pass a check constraint', 400, 'CONTAINS_INVALID_VALUE', extra);
      case '22P02':
      case '22007':
      case '22008':
      case '22003':
        return new InvalidPayloadError('Value has the wrong format for its column');
      case '42501':
        return new ForbiddenError();
    }

    const status = fastifyError.statusCode;
    if (status && status >= 400 && status < 500) {
      return new ApiError(fastifyError.message, status, fastifyError.code ?? 'BAD_REQUEST');
    }
    return null;
  }

  /** Fastify not-found handler, so unknown routes answer in the same format: `fastify.setNotFoundHandler(ErrorMapper.notFound)`. */
  static notFound(request: FastifyRequest, reply: FastifyReply) {
    const error = new RouteNotFoundError(request.method, request.url.split('?')[0] ?? request.url);
    return reply.status(error.status).send(error.toJSON());
  }

  /** Fastify error handler: `fastify.setErrorHandler(ErrorMapper.handler)`. */
  static handler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const apiError = ErrorMapper.toApiError(error);
    if (apiError) return reply.status(apiError.status).send(apiError.toJSON());
    request.log.error(error);
    return reply
      .status(500)
      .send({ errors: [{ message: 'An unexpected error occurred', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
  }
}

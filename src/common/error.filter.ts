import { randomUUID } from 'node:crypto';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const sql = typeof exception === 'object' && exception ? (exception as any).driverError ?? exception : {};
    const status = exception instanceof HttpException ? exception.getStatus() : sql.code === '23505' ? 409 : ['23503','23514','22003','22P02'].includes(sql.code) ? 400 : 500;
    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = typeof body === 'object' && body && 'message' in body ? body.message : undefined;
    const correlationId = String(response.getHeader('X-Correlation-Id') ?? randomUUID());
    response.status(status).json({
      code: typeof body === 'object' && body && 'code' in body ? body.code : sql.code === '23505' ? (sql.constraint === 'ux_active_table_slot' ? 'TABLE_SLOT_CONFLICT':'DUPLICATE_RESOURCE') : ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN',
        404: 'NOT_FOUND', 409: 'CONFLICT', 503: 'DEPENDENCY_UNAVAILABLE' } as Record<number, string>)[status] ?? 'INTERNAL_ERROR',
      message: message ?? (status === 500 ? 'Internal server error' : 'Request failed'),
      correlationId,
      ...(typeof body === 'object' && body && 'details' in body && body.details !== null
        ? { details: Array.isArray(body.details) ? {violations:body.details} : body.details } : {}),
    });
  }
}

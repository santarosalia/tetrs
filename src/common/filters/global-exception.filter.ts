import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BaseGameException } from '../exceptions/base.exception';
import { ErrorResponse, LogContext } from '../interfaces/shared.interface';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: HttpStatus;
    let errorResponse: ErrorResponse;

    if (exception instanceof BaseGameException) {
      // 커스텀 게임 예외 처리
      status = exception.getStatus();
      errorResponse = {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      // NestJS HTTP 예외 처리
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      errorResponse = {
        code: 'HTTP_ERROR',
        message:
          typeof exceptionResponse === 'string'
            ? exceptionResponse
            : (exceptionResponse as any)?.message || exception.message,
        details:
          typeof exceptionResponse === 'object' ? exceptionResponse : undefined,
      };
    } else {
      // 예상치 못한 예외 처리
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorResponse = {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        details:
          process.env.NODE_ENV === 'development'
            ? {
                error:
                  exception instanceof Error
                    ? exception.message
                    : String(exception),
                stack: exception instanceof Error ? exception.stack : undefined,
              }
            : undefined,
      };
    }

    // 로그 컨텍스트 생성
    const logContext: LogContext = {
      method: request.method,
      url: request.url,
      statusCode: status,
      errorCode: errorResponse.code,
      userAgent: request.get('User-Agent'),
      ip: request.ip,
    };

    // 에러 로깅
    if (status >= 500) {
      this.logger.error(
        `Server error: ${errorResponse.message}`,
        exception instanceof Error ? exception.stack : undefined,
        logContext,
      );
    } else {
      this.logger.warn(`Client error: ${errorResponse.message}`, logContext);
    }

    // 응답 전송
    response.status(status).json({
      success: false,
      error: errorResponse,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

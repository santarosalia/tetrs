import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorResponse } from '../interfaces/error-response.interface';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_SERVER_ERROR';
    let details: any = null;

    // HttpException 처리
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const responseObj = exceptionResponse as any;
        message = responseObj.message || exception.message;
        details = responseObj.error || responseObj.details;
      }

      // 상태 코드에 따른 에러 코드 매핑
      switch (status) {
        case HttpStatus.BAD_REQUEST:
          code = 'BAD_REQUEST';
          break;
        case HttpStatus.UNAUTHORIZED:
          code = 'UNAUTHORIZED';
          break;
        case HttpStatus.FORBIDDEN:
          code = 'FORBIDDEN';
          break;
        case HttpStatus.NOT_FOUND:
          code = 'NOT_FOUND';
          break;
        case HttpStatus.CONFLICT:
          code = 'CONFLICT';
          break;
        case HttpStatus.UNPROCESSABLE_ENTITY:
          code = 'VALIDATION_ERROR';
          break;
        case HttpStatus.TOO_MANY_REQUESTS:
          code = 'RATE_LIMIT_EXCEEDED';
          break;
        default:
          code = 'HTTP_EXCEPTION';
      }
    } else if (exception instanceof Error) {
      // 일반 Error 객체 처리
      message = exception.message;

      // 특정 에러 타입에 따른 코드 매핑
      if (exception.name === 'ValidationError') {
        code = 'VALIDATION_ERROR';
        status = HttpStatus.BAD_REQUEST;
      } else if (exception.name === 'TypeError') {
        code = 'TYPE_ERROR';
      } else if (exception.name === 'ReferenceError') {
        code = 'REFERENCE_ERROR';
      } else {
        code = 'GENERAL_ERROR';
      }
    }

    // 에러 로깅
    this.logger.error(
      `Exception occurred: ${message}`,
      exception instanceof Error ? exception.stack : 'Unknown error',
      {
        path: request.url,
        method: request.method,
        statusCode: status,
        userAgent: request.get('User-Agent'),
        ip: request.ip,
      },
    );

    // 에러 응답 생성
    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        details,
      },
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    // 응답 전송
    response.status(status).json(errorResponse);
  }
}

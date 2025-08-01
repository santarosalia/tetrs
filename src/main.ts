import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 전역 예외 필터 등록
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS 설정
  app.enableCors();

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

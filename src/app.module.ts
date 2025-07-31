import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameModule } from './modules/game.module';
import { PrismaService } from './services/prisma.service';

@Module({
  imports: [GameModule],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}

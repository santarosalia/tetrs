import { Module } from '@nestjs/common';
import { GameController } from '../controllers/game.controller';
import { GameService } from '../services/game.service';
import { GameGateway } from '../gateways/game.gateway';
import { PrismaService } from '../services/prisma.service';
import { RedisService } from '../services/redis.service';
import { LoggerService } from '../common/services/logger.service';

@Module({
  controllers: [GameController],
  providers: [
    GameService,
    GameGateway,
    PrismaService,
    RedisService,
    LoggerService,
  ],
  exports: [GameService],
})
export class GameModule {}

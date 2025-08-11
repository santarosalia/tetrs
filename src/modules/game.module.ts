import { Module } from '@nestjs/common';
import { GameController } from '../controllers/game.controller';
import { GameGateway } from '../gateways/game.gateway';
import { GameService } from '../services/game.service';
import { TetrisLogicService } from '../services/tetris-logic.service';
import { NetworkSyncService } from '../services/network-sync.service';
import { PrismaService } from '../services/prisma.service';
import { RedisService } from '../services/redis.service';
import { TetrisCoreService } from '../common/services/tetris-core.service';
import { LoggerService } from '../common/services/logger.service';

@Module({
  controllers: [GameController],
  providers: [
    GameGateway,
    GameService,
    TetrisLogicService,
    NetworkSyncService,
    PrismaService,
    RedisService,
    TetrisCoreService,
    LoggerService,
  ],
  exports: [
    GameGateway,
    GameService,
    TetrisLogicService,
    NetworkSyncService,
    PrismaService,
    RedisService,
    TetrisCoreService,
    LoggerService,
  ],
})
export class GameModule {}

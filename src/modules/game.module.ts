import { Module } from '@nestjs/common';
import { GameController } from '../controllers/game.controller';
import { GameService } from '../services/game.service';
import { GameGateway } from '../gateways/game.gateway';
import { PrismaService } from '../services/prisma.service';

@Module({
  controllers: [GameController],
  providers: [GameService, GameGateway, PrismaService],
  exports: [GameService],
})
export class GameModule {}

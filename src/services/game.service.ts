import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CreateGameDto } from '../dto/create-game.dto';
import { JoinGameDto } from '../dto/join-game.dto';
import { GameStatus, PlayerStatus } from '@prisma/client';

@Injectable()
export class GameService {
  constructor(private readonly prisma: PrismaService) {}

  async createGame(createGameDto: CreateGameDto) {
    return await this.prisma.game.create({
      data: {
        maxPlayers: createGameDto.maxPlayers || 99,
        status: GameStatus.WAITING,
        currentPlayers: 0,
      },
    });
  }

  async joinGame(gameId: string, joinGameDto: JoinGameDto) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });
    if (!game) {
      throw new Error('Game not found');
    }

    if (game.status !== GameStatus.WAITING) {
      throw new Error('Game is not accepting players');
    }

    if (game.currentPlayers >= game.maxPlayers) {
      throw new Error('Game is full');
    }

    const player = await this.prisma.player.create({
      data: {
        name: joinGameDto.name,
        socketId: joinGameDto.socketId,
        gameId: gameId,
        status: PlayerStatus.ALIVE,
      },
    });

    // Update game player count
    await this.prisma.game.update({
      where: { id: gameId },
      data: { currentPlayers: { increment: 1 } },
    });

    return player;
  }

  async getGame(gameId: string) {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: { players: true },
    });
    if (!game) {
      throw new Error('Game not found');
    }
    return game;
  }

  async getAllGames() {
    return await this.prisma.game.findMany({
      include: { players: true },
    });
  }

  async startGame(gameId: string) {
    const game = await this.getGame(gameId);
    if (game.status !== GameStatus.WAITING) {
      throw new Error('Game cannot be started');
    }
    if (game.currentPlayers < 2) {
      throw new Error('Need at least 2 players to start');
    }

    return await this.prisma.game.update({
      where: { id: gameId },
      data: { status: GameStatus.PLAYING },
    });
  }

  async eliminatePlayer(playerId: string) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });
    if (!player) {
      throw new Error('Player not found');
    }

    const updatedPlayer = await this.prisma.player.update({
      where: { id: playerId },
      data: { status: PlayerStatus.ELIMINATED },
    });

    // Check if game should end
    const alivePlayers = await this.prisma.player.count({
      where: {
        gameId: player.gameId,
        status: PlayerStatus.ALIVE,
      },
    });

    if (alivePlayers <= 1) {
      const updateData: any = { status: GameStatus.FINISHED };

      if (alivePlayers === 1) {
        const winner = await this.prisma.player.findFirst({
          where: {
            gameId: player.gameId,
            status: PlayerStatus.ALIVE,
          },
        });
        if (winner) {
          updateData.winnerId = winner.id;
        }
      }

      await this.prisma.game.update({
        where: { id: player.gameId },
        data: updateData,
      });
    }

    return updatedPlayer;
  }

  async updatePlayerStats(
    playerId: string,
    stats: {
      score?: number;
      linesCleared?: number;
      level?: number;
    },
  ) {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
    });
    if (!player) {
      throw new Error('Player not found');
    }

    return await this.prisma.player.update({
      where: { id: playerId },
      data: stats,
    });
  }

  async leaveGame(playerId: string): Promise<void> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });
    if (!player) {
      throw new Error('Player not found');
    }

    await this.prisma.player.delete({
      where: { id: playerId },
    });

    // Update game player count
    await this.prisma.game.update({
      where: { id: player.gameId },
      data: { currentPlayers: { decrement: 1 } },
    });
  }
}

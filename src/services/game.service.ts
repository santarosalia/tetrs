import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { CreateGameDto } from '../dto/create-game.dto';
import { JoinGameDto } from '../dto/join-game.dto';
import { GameStatus, PlayerStatus } from '@prisma/client';
import {
  GameNotFoundException,
  GameNotAcceptingPlayersException,
  GameFullException,
  GameCannotStartException,
  PlayerNotFoundException,
} from '../common/exceptions/game.exception';
import { LoggerService } from '../common/services/logger.service';
import { TetrisMapService } from './tetris-map.service';

@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly logger: LoggerService,
    private readonly tetrisMapService: TetrisMapService,
  ) {}

  async createGame(createGameDto: CreateGameDto) {
    // Redis에 실시간 게임 상태 생성
    const redisGame = await this.redisService.createGame({
      status: 'WAITING',
      maxPlayers: createGameDto.maxPlayers || 99,
      currentPlayers: 0,
      linesSent: 0,
      linesReceived: 0,
    });

    // PostgreSQL에 영속성 데이터 저장
    await this.prisma.game.create({
      data: {
        id: redisGame.id,
        maxPlayers: redisGame.maxPlayers,
        status: GameStatus.WAITING,
        currentPlayers: 0,
      },
    });

    this.logger.logGameCreated(redisGame.id, redisGame.maxPlayers);

    return redisGame;
  }

  async joinGame(gameId: string, joinGameDto: JoinGameDto) {
    // Redis에서 게임 상태 확인
    const game = await this.redisService.getGame(gameId);
    if (!game) {
      throw new GameNotFoundException(gameId);
    }

    if (game.status !== 'WAITING') {
      throw new GameNotAcceptingPlayersException(gameId);
    }

    if (game.currentPlayers >= game.maxPlayers) {
      throw new GameFullException(gameId);
    }

    // Redis에 플레이어 생성
    const player = await this.redisService.createPlayer({
      name: joinGameDto.name,
      socketId: joinGameDto.socketId,
      gameId: gameId,
      status: 'ALIVE',
      score: 0,
      linesCleared: 0,
      level: 0,
    });

    // Redis 게임 플레이어 수 증가
    await this.redisService.incrementGamePlayers(gameId);

    // PostgreSQL에도 플레이어 저장 (영속성)
    await this.prisma.player.create({
      data: {
        id: player.id,
        name: player.name,
        socketId: player.socketId,
        gameId: gameId,
        status: PlayerStatus.ALIVE,
      },
    });

    this.logger.logGameJoined(gameId, player.id, player.name);

    return player;
  }

  async getGame(gameId: string) {
    // Redis에서 실시간 게임 상태 가져오기
    const game = await this.redisService.getGame(gameId);
    if (!game) {
      throw new GameNotFoundException(gameId);
    }

    // Redis에서 플레이어 목록 가져오기
    const players = await this.redisService.getPlayersByGame(gameId);

    return {
      ...game,
      players,
    };
  }

  async getAllGames() {
    // Redis에서 모든 게임 가져오기
    const games = await this.redisService.getAllGames();

    // 각 게임의 플레이어 정보도 포함
    const gamesWithPlayers = await Promise.all(
      games.map(async (game) => {
        const players = await this.redisService.getPlayersByGame(game.id);
        return { ...game, players };
      }),
    );

    return gamesWithPlayers;
  }

  async startGame(gameId: string) {
    const game = await this.getGame(gameId);
    if (game.status !== 'WAITING') {
      throw new GameCannotStartException('Game is not in waiting state');
    }
    if (game.currentPlayers < 2) {
      throw new GameCannotStartException('Need at least 2 players to start');
    }

    // Redis 게임 상태 업데이트
    await this.redisService.setGameStatus(gameId, 'PLAYING');

    // PostgreSQL 게임 상태 업데이트
    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: GameStatus.PLAYING },
    });

    this.logger.logGameStarted(gameId, game.currentPlayers);

    return await this.redisService.getGame(gameId);
  }

  async eliminatePlayer(playerId: string) {
    const player = await this.redisService.getPlayer(playerId);
    if (!player) {
      throw new PlayerNotFoundException(playerId);
    }

    // Redis 플레이어 상태 업데이트
    await this.redisService.updatePlayer(playerId, { status: 'ELIMINATED' });

    // PostgreSQL 플레이어 상태 업데이트
    await this.prisma.player.update({
      where: { id: playerId },
      data: { status: PlayerStatus.ELIMINATED },
    });

    this.logger.logPlayerEliminated(player.gameId!, playerId, player.name);

    // 게임 종료 조건 확인
    const alivePlayers = (
      await this.redisService.getPlayersByGame(player.gameId!)
    ).filter((p) => p.status === 'ALIVE');

    if (alivePlayers.length <= 1) {
      const updateData: any = { status: 'FINISHED' };

      if (alivePlayers.length === 1) {
        updateData.winnerId = alivePlayers[0].id;
      }

      // Redis 게임 상태 업데이트
      await this.redisService.updateGame(player.gameId!, updateData);

      // PostgreSQL 게임 상태 업데이트
      await this.prisma.game.update({
        where: { id: player.gameId },
        data: {
          status: GameStatus.FINISHED,
          winnerId: updateData.winnerId,
        },
      });

      this.logger.logGameFinished(player.gameId!, updateData.winnerId);
    }

    return await this.redisService.getPlayer(playerId);
  }

  async updatePlayerStats(
    playerId: string,
    stats: {
      score?: number;
      linesCleared?: number;
      level?: number;
    },
  ) {
    const player = await this.redisService.getPlayer(playerId);
    if (!player) {
      throw new PlayerNotFoundException(playerId);
    }

    // Redis 플레이어 통계 업데이트
    await this.redisService.updatePlayerStats(playerId, stats);

    // PostgreSQL 플레이어 통계 업데이트 (영속성)
    await this.prisma.player.update({
      where: { id: playerId },
      data: stats,
    });

    this.logger.logStatsUpdated(playerId, player.gameId!, stats);

    return await this.redisService.getPlayer(playerId);
  }

  async leaveGame(playerId: string): Promise<void> {
    const player = await this.redisService.getPlayer(playerId);
    if (!player) {
      throw new PlayerNotFoundException(playerId);
    }

    // Redis에서 플레이어 삭제
    await this.redisService.deletePlayer(playerId);

    // Redis 게임 플레이어 수 감소
    if (player.gameId) {
      await this.redisService.decrementGamePlayers(player.gameId);
    }

    // PostgreSQL에서 플레이어 삭제
    await this.prisma.player.delete({
      where: { id: playerId },
    });

    // PostgreSQL 게임 플레이어 수 업데이트
    if (player.gameId) {
      await this.prisma.game.update({
        where: { id: player.gameId },
        data: { currentPlayers: { decrement: 1 } },
      });
    }

    this.logger.logPlayerLeft(player.gameId!, playerId, player.name);
  }

  // 실시간 게임 이벤트 발행
  async publishGameEvent(
    gameId: string,
    event: string,
    data: any,
  ): Promise<void> {
    await this.redisService.publish(`game:${gameId}`, { event, data });
  }

  // 게임 통계 업데이트
  async updateGameStats(
    gameId: string,
    linesSent: number,
    linesReceived: number,
  ): Promise<void> {
    await this.redisService.updateGameStats(gameId, linesSent, linesReceived);
  }

  // 테트리스 맵 관련 메서드들
  async getGameMapState(gameId: string) {
    return await this.tetrisMapService.getGameMapState(gameId);
  }

  async getPlayerMap(gameId: string, playerId: string) {
    return await this.tetrisMapService.getPlayerMap(gameId, playerId);
  }

  async updatePlayerMap(gameId: string, playerId: string, mapData: any) {
    await this.tetrisMapService.updatePlayerMap(gameId, playerId, mapData);
    // 맵 업데이트 후 전체 게임 상태 브로드캐스트
    await this.tetrisMapService.publishGameMapState(gameId);
  }

  async initializePlayerMap(
    gameId: string,
    playerId: string,
    playerName: string,
  ) {
    await this.tetrisMapService.initializePlayerMap(
      gameId,
      playerId,
      playerName,
    );
  }

  async deletePlayerMap(gameId: string, playerId: string) {
    await this.tetrisMapService.deletePlayerMap(gameId, playerId);
  }
}

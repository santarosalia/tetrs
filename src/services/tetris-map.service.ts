import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';
import { LoggerService } from '../common/services/logger.service';
import {
  TetrisMap,
  GameMapState,
} from '../common/interfaces/tetris-map.interface';

@Injectable()
export class TetrisMapService {
  constructor(
    private readonly redisService: RedisService,
    private readonly logger: LoggerService,
  ) {}

  // 게임의 모든 플레이어 맵 상태 가져오기
  async getGameMapState(gameId: string): Promise<GameMapState | null> {
    const game = await this.redisService.getGame(gameId);
    if (!game) return null;

    const players = await this.redisService.getPlayersByGame(gameId);
    const playerMaps: TetrisMap[] = [];

    for (const player of players) {
      const playerMap = await this.getPlayerMap(gameId, player.id);
      if (playerMap) {
        playerMaps.push(playerMap);
      }
    }

    return {
      gameId,
      players: playerMaps,
      gameStatus: game.status,
      lastUpdated: new Date().toISOString(),
    };
  }

  // 특정 플레이어의 맵 상태 가져오기
  async getPlayerMap(
    gameId: string,
    playerId: string,
  ): Promise<TetrisMap | null> {
    const mapData = await this.redisService
      .getRedisInstance()
      .hgetall(`tetris:${gameId}:${playerId}`);
    if (!mapData || Object.keys(mapData).length === 0) {
      return null;
    }

    return {
      playerId: mapData.playerId,
      playerName: mapData.playerName,
      width: parseInt(mapData.width),
      height: parseInt(mapData.height),
      grid: JSON.parse(mapData.grid),
      currentPiece: mapData.currentPiece
        ? JSON.parse(mapData.currentPiece)
        : undefined,
      nextPiece: mapData.nextPiece ? JSON.parse(mapData.nextPiece) : undefined,
      score: parseInt(mapData.score),
      linesCleared: parseInt(mapData.linesCleared),
      level: parseInt(mapData.level),
      gameOver: mapData.gameOver === 'true',
      lastUpdated: mapData.lastUpdated,
    };
  }

  // 플레이어 맵 상태 업데이트
  async updatePlayerMap(
    gameId: string,
    playerId: string,
    mapData: Partial<TetrisMap>,
  ): Promise<void> {
    const existingMap = await this.getPlayerMap(gameId, playerId);
    const updatedMap = {
      ...existingMap,
      ...mapData,
      lastUpdated: new Date().toISOString(),
    };

    await this.redisService
      .getRedisInstance()
      .hset(`tetris:${gameId}:${playerId}`, {
        playerId: updatedMap.playerId,
        playerName: updatedMap.playerName,
        width: updatedMap.width.toString(),
        height: updatedMap.height.toString(),
        grid: JSON.stringify(updatedMap.grid),
        currentPiece: updatedMap.currentPiece
          ? JSON.stringify(updatedMap.currentPiece)
          : '',
        nextPiece: updatedMap.nextPiece
          ? JSON.stringify(updatedMap.nextPiece)
          : '',
        score: updatedMap.score.toString(),
        linesCleared: updatedMap.linesCleared.toString(),
        level: updatedMap.level.toString(),
        gameOver: updatedMap.gameOver.toString(),
        lastUpdated: updatedMap.lastUpdated,
      });

    // 만료 시간 설정 (1시간)
    await this.redisService
      .getRedisInstance()
      .expire(`tetris:${gameId}:${playerId}`, 3600);

    this.logger.log('Tetris map updated', {
      gameId,
      playerId,
      action: 'TETRIS_MAP_UPDATED',
    });
  }

  // 새 플레이어 맵 초기화
  async initializePlayerMap(
    gameId: string,
    playerId: string,
    playerName: string,
  ): Promise<void> {
    const initialMap: TetrisMap = {
      playerId,
      playerName,
      width: 10,
      height: 20,
      grid: Array(20)
        .fill(null)
        .map(() => Array(10).fill(0)),
      score: 0,
      linesCleared: 0,
      level: 1,
      gameOver: false,
      lastUpdated: new Date().toISOString(),
    };

    await this.updatePlayerMap(gameId, playerId, initialMap);

    this.logger.log('Tetris map initialized', {
      gameId,
      playerId,
      playerName,
      action: 'TETRIS_MAP_INITIALIZED',
    });
  }

  // 플레이어 맵 삭제
  async deletePlayerMap(gameId: string, playerId: string): Promise<void> {
    await this.redisService
      .getRedisInstance()
      .del(`tetris:${gameId}:${playerId}`);

    this.logger.log('Tetris map deleted', {
      gameId,
      playerId,
      action: 'TETRIS_MAP_DELETED',
    });
  }

  // 게임의 모든 맵 삭제
  async deleteGameMaps(gameId: string): Promise<void> {
    const players = await this.redisService.getPlayersByGame(gameId);

    for (const player of players) {
      await this.deletePlayerMap(gameId, player.id);
    }

    this.logger.log('All tetris maps deleted for game', {
      gameId,
      action: 'TETRIS_MAPS_DELETED',
    });
  }

  // 맵 상태 변경 이벤트 발행
  async publishMapUpdate(
    gameId: string,
    playerId: string,
    mapData: TetrisMap,
  ): Promise<void> {
    await this.redisService.publish(`tetris:${gameId}`, {
      event: 'MAP_UPDATED',
      data: {
        playerId,
        mapData,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // 게임 전체 맵 상태 이벤트 발행
  async publishGameMapState(gameId: string): Promise<void> {
    const gameMapState = await this.getGameMapState(gameId);
    if (gameMapState) {
      await this.redisService.publish(`tetris:${gameId}`, {
        event: 'GAME_MAP_STATE',
        data: gameMapState,
      });
    }
  }

  // 실시간 맵 구독
  async subscribeToMapUpdates(
    gameId: string,
    callback: (data: any) => void,
  ): Promise<void> {
    await this.redisService.subscribe(`tetris:${gameId}`, callback);
  }
}

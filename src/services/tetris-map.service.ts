import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';
import { LoggerService } from '../common/services/logger.service';
import { TetrisLogicService } from './tetris-logic.service';
import {
  TetrisMap,
  GameMapState,
  TetrisBlock,
} from '../common/interfaces/tetris-map.interface';

@Injectable()
export class TetrisMapService {
  constructor(
    private readonly redisService: RedisService,
    private readonly logger: LoggerService,
    private readonly tetrisLogic: TetrisLogicService,
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
      heldPiece: mapData.heldPiece ? JSON.parse(mapData.heldPiece) : null,
      canHold: mapData.canHold === 'true',
      ghostPiece: mapData.ghostPiece
        ? JSON.parse(mapData.ghostPiece)
        : undefined,
      score: parseInt(mapData.score),
      linesCleared: parseInt(mapData.linesCleared),
      level: parseInt(mapData.level),
      gameOver: mapData.gameOver === 'true',
      paused: mapData.paused === 'true',
      isGameStarted: mapData.isGameStarted === 'true',
      lastUpdated: mapData.lastUpdated,
      tetrominoBag: mapData.tetrominoBag
        ? JSON.parse(mapData.tetrominoBag)
        : undefined,
      bagIndex: mapData.bagIndex ? parseInt(mapData.bagIndex) : undefined,
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
        heldPiece: updatedMap.heldPiece
          ? JSON.stringify(updatedMap.heldPiece)
          : '',
        canHold: updatedMap.canHold.toString(),
        ghostPiece: updatedMap.ghostPiece
          ? JSON.stringify(updatedMap.ghostPiece)
          : '',
        score: updatedMap.score.toString(),
        linesCleared: updatedMap.linesCleared.toString(),
        level: updatedMap.level.toString(),
        gameOver: updatedMap.gameOver.toString(),
        paused: updatedMap.paused.toString(),
        isGameStarted: updatedMap.isGameStarted.toString(),
        lastUpdated: updatedMap.lastUpdated,
        tetrominoBag: updatedMap.tetrominoBag
          ? JSON.stringify(updatedMap.tetrominoBag)
          : '',
        bagIndex: updatedMap.bagIndex?.toString() || '',
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
    // 7-bag 시스템 초기화
    this.tetrisLogic.initializeTetrominoBag();

    const initialMap: TetrisMap = {
      playerId,
      playerName,
      width: 10,
      height: 20,
      grid: this.tetrisLogic.createEmptyBoard(),
      currentPiece: undefined,
      nextPiece: this.tetrisLogic.getNextTetrominoFromBag(),
      heldPiece: null,
      canHold: true,
      ghostPiece: undefined,
      score: 0,
      linesCleared: 0,
      level: 1,
      gameOver: false,
      paused: false,
      isGameStarted: false,
      lastUpdated: new Date().toISOString(),
      tetrominoBag: this.tetrisLogic['tetrominoBag'],
      bagIndex: this.tetrisLogic['bagIndex'],
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

  // 새로운 테트로미노 생성
  spawnNewPiece(): TetrisBlock | null {
    const nextPieceType = this.tetrisLogic.getNextTetrominoFromBag();
    return this.tetrisLogic.createTetromino(nextPieceType);
  }

  // 테트로미노 이동
  movePiece(
    currentPiece: TetrisBlock,
    board: number[][],
    offsetX: number,
    offsetY: number,
  ): TetrisBlock | null {
    return this.tetrisLogic.moveTetromino(
      currentPiece,
      board,
      offsetX,
      offsetY,
    );
  }

  // 테트로미노 회전 (벽킥 포함)
  rotatePiece(
    currentPiece: TetrisBlock,
    board: number[][],
  ): TetrisBlock | null {
    return this.tetrisLogic.rotateTetrominoWithWallKick(currentPiece, board);
  }

  // 하드 드롭
  hardDrop(
    currentPiece: TetrisBlock,
    board: number[][],
  ): { droppedPiece: TetrisBlock; dropDistance: number } {
    const originalY = currentPiece.position.y;
    const droppedPiece = this.tetrisLogic.dropTetromino(currentPiece, board);
    const dropDistance = droppedPiece.position.y - originalY;

    return { droppedPiece, dropDistance };
  }

  // 라인 클리어 및 점수 계산
  clearLinesAndCalculateScore(
    board: number[][],
    level: number,
  ): { newBoard: number[][]; linesCleared: number; score: number } {
    const { newBoard, linesCleared } = this.tetrisLogic.clearLines(board);
    const score = this.tetrisLogic.calculateScore(linesCleared, level);

    return { newBoard, linesCleared, score };
  }

  // 고스트 피스 계산
  getGhostPiece(currentPiece: TetrisBlock, board: number[][]): TetrisBlock {
    return this.tetrisLogic.getGhostPiece(currentPiece, board);
  }

  // 게임 오버 체크
  isGameOver(board: number[][]): boolean {
    return this.tetrisLogic.isGameOver(board);
  }

  // 레벨 계산
  calculateLevel(lines: number): number {
    return this.tetrisLogic.calculateLevel(lines);
  }

  // 드롭 간격 계산
  calculateDropInterval(level: number, distanceToBottom: number = 0): number {
    return this.tetrisLogic.calculateDropInterval(level, distanceToBottom);
  }
}

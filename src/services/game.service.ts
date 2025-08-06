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
import { TetrisLogicService } from './tetris-logic.service';
import { TetrisBlock } from '../common/interfaces/tetris-map.interface';
import { TetrominoType } from '../common/interfaces/shared.interface';

export interface PlayerGameState {
  playerId: string;
  roomId: string;
  gameStarted: boolean;
  score: number;
  level: number;
  linesCleared: number;
  currentPiece: TetrisBlock | null;
  nextPiece: TetrominoType;
  heldPiece: TetrominoType | null;
  canHold: boolean;
  ghostPiece: TetrisBlock | null;
  board: number[][];
  gameOver: boolean;
  paused: boolean;
  isGameStarted: boolean;
  startTime: Date;
  lastActivity: Date;
  // 7-bag 시스템
  tetrominoBag: TetrominoType[];
  bagIndex: number;
  bagNumber: number; // 현재 가방 번호 추가
  // 게임 시드 (프론트엔드와 동기화용)
  gameSeed: number;
  // 서버 권위적: 다음 피스 큐 (클라이언트 전송용)
  nextPieces?: TetrominoType[];
}

@Injectable()
export class GameService {
  private readonly MAX_PLAYERS_PER_ROOM = 99;
  private gameTimers = new Map<string, NodeJS.Timeout>();

  // 성능 최적화를 위한 캐시
  private readonly gameStateCache = new Map<
    string,
    { state: PlayerGameState; timestamp: number }
  >();
  private readonly CACHE_TTL = 5000; // 5초 캐시 TTL

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly logger: LoggerService,
    private readonly tetrisMapService: TetrisMapService,
    private readonly tetrisLogic: TetrisLogicService,
  ) {}

  // 게임 타이머 시작 (최적화됨)
  private startGameTimer(playerId: string): void {
    // 기존 타이머가 있으면 제거
    this.stopGameTimer(playerId);

    const timer = setInterval(async () => {
      try {
        const playerState = await this.getPlayerGameState(playerId);
        if (!playerState || playerState.gameOver) {
          this.stopGameTimer(playerId);
          return;
        }

        // 자동으로 블록 떨어뜨리기
        await this.autoDropPiece(playerId);
      } catch (error) {
        this.logger.logError(error);
        this.stopGameTimer(playerId);
      }
    }, 1000);

    this.gameTimers.set(playerId, timer);
  }

  // 게임 타이머 정지 (최적화됨)
  private stopGameTimer(playerId: string): void {
    const timer = this.gameTimers.get(playerId);
    if (timer) {
      clearInterval(timer);
      this.gameTimers.delete(playerId);
    }
  }

  // 게임 타이머 정지 (모든 플레이어) - 최적화됨
  private stopAllGameTimers(): void {
    const timerIds = Array.from(this.gameTimers.keys());
    timerIds.forEach((playerId) => this.stopGameTimer(playerId));
  }

  // 메모리 누수 방지를 위한 정리 메서드 추가
  private cleanupTimers(): void {
    this.stopAllGameTimers();
    this.gameTimers.clear();
  }

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

  /**
   * 자동 룸 배정으로 게임 참여
   */
  async joinGameAuto(joinGameDto: JoinGameDto) {
    try {
      // 1. 게임 중인 방 우선 찾기, 없으면 대기 중인 방 찾기
      let availableRoom = await this.findAvailableRoom();

      // 2. 사용 가능한 룸이 없으면 새 룸 생성
      if (!availableRoom) {
        availableRoom = await this.createNewRoom();
        this.logger.log(`새 게임 룸 생성: ${availableRoom.id}`, {
          roomId: availableRoom.id,
        });
      }

      // 3. 플레이어를 룸에 참여시킴
      const player = await this.joinPlayerToRoom(availableRoom.id, joinGameDto);

      // 4. 개인 게임 상태 초기화 (게임 시작하지 않음)
      await this.initializePlayerGameState(player.id, availableRoom.id);

      // 5. 룸 상태 업데이트
      await this.updateRoomActivity(availableRoom.id);

      // 6. 자동 게임 시작 제거 - 사용자가 명시적으로 시작해야 함

      this.logger.log(
        `플레이어 ${player.name}이(가) 자동으로 룸 ${availableRoom.id}에 배정됨`,
        {
          roomId: availableRoom.id,
          playerId: player.id,
          playerName: player.name,
        },
      );

      return { roomId: availableRoom.id, player };
    } catch (error) {
      this.logger.log(`자동 룸 배정 실패: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * 플레이어 개인 게임 상태 초기화 (최적화됨)
   */
  private async initializePlayerGameState(
    playerId: string,
    roomId: string,
  ): Promise<void> {
    // 룸 정보 가져오기
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error(`룸 ${roomId}을 찾을 수 없습니다.`);
    }

    // 최적화된 시드 생성
    const gameSeed = this.generateOptimizedSeed(playerId, roomId);

    // 테트리스 표준 7-bag 시스템 초기화
    const initialBag = this.generateNewBagWithSeed(gameSeed);

    const gameState: PlayerGameState = {
      playerId,
      roomId,
      gameStarted: false,
      score: 0,
      level: 0,
      linesCleared: 0,
      currentPiece: null,
      nextPiece: initialBag[0],
      heldPiece: null,
      canHold: true,
      ghostPiece: null,
      board: this.tetrisLogic.createEmptyBoard(),
      gameOver: false,
      paused: false,
      isGameStarted: false,
      startTime: new Date(),
      lastActivity: new Date(),
      tetrominoBag: initialBag,
      bagIndex: 1,
      bagNumber: 1,
      gameSeed,
    };

    await this.redisService.set(
      `player_game:${playerId}`,
      JSON.stringify(gameState),
    );

    this.logger.log(
      `플레이어 게임 상태 초기화: ${playerId} (룸: ${roomId}, 시드: ${gameSeed})`,
      { playerId, roomId, gameSeed },
    );
  }

  // 최적화된 시드 생성 메서드
  private generateOptimizedSeed(playerId: string, roomId: string): number {
    const timestamp = Date.now();
    const randomOffset = Math.floor(Math.random() * 1000000000);
    const playerHash = this.hashString(playerId);
    const roomHash = this.hashString(roomId);
    const microtime = Number(process.hrtime.bigint() % 1000000000n);
    const additionalRandom = Math.floor(Math.random() * 1000000);

    const gameSeed =
      timestamp ^
      randomOffset ^
      playerHash ^
      roomHash ^
      microtime ^
      additionalRandom;
    const finalSeed = Math.abs(gameSeed) % 2147483647;
    const adjustedSeed = finalSeed < 1000 ? finalSeed + 10000 : finalSeed;
    const safeSeed = adjustedSeed === 0 ? 12345 : adjustedSeed;

    return safeSeed;
  }

  /**
   * 플레이어 개인 게임 시작
   */
  private async startPlayerGame(
    playerId: string,
    roomId: string,
  ): Promise<void> {
    try {
      // 룸 정보 가져오기
      const room = await this.getRoom(roomId);
      if (!room) {
        throw new Error(`룸 ${roomId}을 찾을 수 없습니다.`);
      }

      // 기존 게임 상태에서 시드 가져오기 (룸 시드 우선)
      const existingState = await this.getPlayerGameState(playerId);
      const roomSeed =
        room.roomSeed || Date.now() + Math.floor(Math.random() * 1000);
      const gameSeed =
        existingState?.gameSeed || roomSeed + playerId.charCodeAt(0);

      // 시드 기반 7-bag 시스템 초기화
      const initialBag = this.generateNewBagWithSeed(gameSeed);

      // 초기 게임 상태 설정
      const initialGameState: PlayerGameState = {
        playerId,
        roomId,
        gameStarted: true,
        score: 0,
        level: 1,
        linesCleared: 0,
        currentPiece: this.tetrisLogic.createTetrisBlock(initialBag[0]), // 첫 번째 조각을 현재 조각으로
        nextPiece: initialBag[1], // 두 번째 조각을 다음 조각으로
        heldPiece: null,
        canHold: true,
        ghostPiece: this.tetrisLogic.getGhostPiece(
          this.tetrisLogic.createTetrisBlock(initialBag[0]),
          this.tetrisLogic.createEmptyBoard(),
        ),
        board: this.tetrisLogic.createEmptyBoard(),
        gameOver: false,
        paused: false,
        isGameStarted: true,
        startTime: new Date(),
        lastActivity: new Date(),
        tetrominoBag: initialBag,
        bagIndex: 2, // 두 번째 조각까지 사용했으므로 인덱스를 2로 설정
        bagNumber: 1, // 첫 번째 가방
        gameSeed,
      };

      // 디버깅 로그 추가
      this.logger.log(`게임 시작 - currentPiece 생성:`, {
        playerId,
        initialBag: initialBag,
        currentPiece: initialGameState.currentPiece,
        nextPiece: initialGameState.nextPiece,
        ghostPiece: initialGameState.ghostPiece,
      });

      // currentPiece 생성 확인 로그
      this.logger.log(`currentPiece 생성 확인:`, {
        playerId,
        initialBag0: initialBag[0],
        createdPiece: this.tetrisLogic.createTetrisBlock(initialBag[0]),
        finalCurrentPiece: initialGameState.currentPiece,
      });

      // Redis에 게임 상태 저장
      await this.redisService.set(
        `player_game:${playerId}`,
        JSON.stringify(initialGameState),
      );

      // 게임 타이머 시작 (레벨 1로 시작)
      this.restartGameTimerWithLevel(playerId, initialGameState.level);

      // 클라이언트에게 초기 게임 상태 전송
      await this.publishGameStateUpdate(playerId, initialGameState);

      // 게임 시작 이벤트 전송
      await this.redisService.publish(`game_started:${playerId}`, {
        type: 'game_started',
        playerId,
        roomId,
        gameSeed,
        timestamp: Date.now(),
      });

      this.logger.logGameStarted(roomId, 1);

      this.logger.log(
        `플레이어 게임 시작: ${playerId} (룸: ${roomId}, 시드: ${gameSeed})`,
        {
          playerId,
          roomId,
          gameSeed,
          roomSeed: room.roomSeed,
        },
      );

      // 디버깅 로그 추가
      this.logger.log(`게임 시작 - currentPiece 생성:`, {
        playerId,
        initialBag: initialBag,
        currentPiece: initialGameState.currentPiece,
        nextPiece: initialGameState.nextPiece,
        ghostPiece: initialGameState.ghostPiece,
      });
    } catch (error) {
      this.logger.logError(error);
    }
  }

  /**
   * 플레이어 게임 상태 가져오기 (캐시 최적화됨)
   */
  async getPlayerGameState(playerId: string): Promise<PlayerGameState | null> {
    try {
      // 캐시에서 먼저 확인
      const cached = this.gameStateCache.get(playerId);
      const now = Date.now();

      if (cached && now - cached.timestamp < this.CACHE_TTL) {
        return cached.state;
      }

      const gameStateData = await this.redisService.get(
        `player_game:${playerId}`,
      );
      const gameState = gameStateData ? JSON.parse(gameStateData) : null;

      // 게임이 시작되었는데 currentPiece가 null인 경우 새로운 피스 생성
      if (gameState && gameState.gameStarted && !gameState.currentPiece) {
        // 게임이 시작되었지만 currentPiece가 null인 경우 게임을 다시 시작
        if (gameState.gameStarted && !gameState.currentPiece) {
          await this.startPlayerGame(playerId, gameState.roomId);

          // 다시 게임 상태를 가져옴
          const updatedGameStateData = await this.redisService.get(
            `player_game:${playerId}`,
          );
          const updatedGameState = updatedGameStateData
            ? JSON.parse(updatedGameStateData)
            : null;

          // 캐시 업데이트
          if (updatedGameState) {
            this.gameStateCache.set(playerId, {
              state: updatedGameState,
              timestamp: now,
            });
          }

          return updatedGameState;
        }

        // 새로운 피스 생성
        const newPiece = this.tetrisLogic.createTetrisBlock(
          gameState.nextPiece,
        );
        const nextPiece = this.getNextPiece(gameState);

        // 게임 상태 업데이트
        const updatedGameState = {
          ...gameState,
          currentPiece: newPiece,
          nextPiece: nextPiece,
          ghostPiece: this.tetrisLogic.getGhostPiece(newPiece, gameState.board),
        };

        // Redis에 업데이트된 상태 저장
        await this.redisService.set(
          `player_game:${playerId}`,
          JSON.stringify(updatedGameState),
        );

        // 캐시 업데이트
        this.gameStateCache.set(playerId, {
          state: updatedGameState,
          timestamp: now,
        });

        return updatedGameState;
      }

      // 캐시 업데이트
      if (gameState) {
        this.gameStateCache.set(playerId, {
          state: gameState,
          timestamp: now,
        });
      }

      return gameState;
    } catch (error) {
      this.logger.log(`플레이어 게임 상태 조회 실패: ${error.message}`, {
        error,
        playerId,
      });
      return null;
    }
  }

  // 캐시 무효화 메서드
  private invalidateCache(playerId: string): void {
    this.gameStateCache.delete(playerId);
  }

  /**
   * 플레이어 게임 상태 업데이트 (캐시 최적화됨)
   */
  async updatePlayerGameState(
    playerId: string,
    updates: Partial<PlayerGameState>,
  ): Promise<void> {
    try {
      const gameState = await this.getPlayerGameState(playerId);
      if (!gameState) {
        throw new Error('플레이어 게임 상태를 찾을 수 없습니다');
      }

      const updatedState = {
        ...gameState,
        ...updates,
        lastActivity: new Date(),
      };

      // Redis에 직접 저장 (JSON.stringify 최적화)
      const serializedState = JSON.stringify(updatedState);
      await this.redisService.set(`player_game:${playerId}`, serializedState);

      // 캐시 무효화
      this.invalidateCache(playerId);
    } catch (error) {
      this.logger.log(`플레이어 게임 상태 업데이트 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
  }

  // 최적화된 게임 상태 업데이트 (배치 처리)
  async updatePlayerGameStateBatch(
    updates: Array<{ playerId: string; updates: Partial<PlayerGameState> }>,
  ): Promise<void> {
    const promises = updates.map(async ({ playerId, updates }) => {
      return this.updatePlayerGameState(playerId, updates);
    });

    await Promise.all(promises);
  }

  /**
   * 플레이어 입력 처리 (서버 권위적)
   */
  async handlePlayerInput(
    playerId: string,
    input: {
      action: string;
      // 클라이언트에서 전송하는 게임 상태 데이터 제거
      // 서버에서만 게임 로직 처리
    },
  ): Promise<PlayerGameState | null> {
    try {
      const gameState = await this.getPlayerGameState(playerId);
      if (!gameState || !gameState.gameStarted) {
        throw new Error('게임이 시작되지 않았습니다');
      }

      // 서버에서만 게임 로직 처리 (클라이언트 상태 무시)
      const updatedState = await this.handlePlayerInputServerOnly(
        playerId,
        input.action,
      );

      return updatedState;
    } catch (error) {
      this.logger.log(`플레이어 입력 처리 실패: ${error.message}`, {
        error,
        playerId,
        input,
      });
      return null;
    }
  }

  // 서버 전용 게임 로직 처리 (클라이언트 상태 무시)
  async handlePlayerInputServerOnly(
    playerId: string,
    action: string,
  ): Promise<PlayerGameState | null> {
    try {
      const playerState = await this.getPlayerGameState(playerId);
      if (!playerState || playerState.gameOver) {
        return null;
      }

      // 테트리스 로직 시작 로그
      this.logger.logTetrisLogic(playerId, action, {
        currentPiece: playerState.currentPiece,
        board: playerState.board,
        score: playerState.score,
        level: playerState.level,
        linesCleared: playerState.linesCleared,
        gameOver: playerState.gameOver,
        nextPiece: playerState.nextPiece,
        heldPiece: playerState.heldPiece,
        ghostPiece: playerState.ghostPiece,
        tetrominoBag: playerState.tetrominoBag,
        bagIndex: playerState.bagIndex,
      });

      const updatedState = { ...playerState };

      // 서버에서 게임 로직 처리
      switch (action) {
        case 'moveLeft':
          if (updatedState.currentPiece) {
            const fromPosition = { ...updatedState.currentPiece.position };
            const movedPiece = this.tetrisLogic.moveTetrisBlock(
              updatedState.currentPiece,
              updatedState.board,
              -1,
              0,
            );
            if (movedPiece) {
              updatedState.currentPiece = movedPiece;
              // 고스트 피스 업데이트
              updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
                movedPiece,
                updatedState.board,
              );
              this.logger.logPieceMovement(playerId, 'moveLeft', {
                fromPosition,
                toPosition: movedPiece.position,
                pieceType: movedPiece.type,
                success: true,
              });
            } else {
              this.logger.logPieceMovement(playerId, 'moveLeft', {
                fromPosition,
                pieceType: updatedState.currentPiece.type,
                success: false,
                reason: 'Collision detected',
              });
            }
          }
          break;

        case 'moveRight':
          if (updatedState.currentPiece) {
            const fromPosition = { ...updatedState.currentPiece.position };
            const movedPiece = this.tetrisLogic.moveTetrisBlock(
              updatedState.currentPiece,
              updatedState.board,
              1,
              0,
            );
            if (movedPiece) {
              updatedState.currentPiece = movedPiece;
              // 고스트 피스 업데이트
              updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
                movedPiece,
                updatedState.board,
              );
              this.logger.logPieceMovement(playerId, 'moveRight', {
                fromPosition,
                toPosition: movedPiece.position,
                pieceType: movedPiece.type,
                success: true,
              });
            } else {
              this.logger.logPieceMovement(playerId, 'moveRight', {
                fromPosition,
                pieceType: updatedState.currentPiece.type,
                success: false,
                reason: 'Collision detected',
              });
            }
          }
          break;

        case 'moveDown':
          if (updatedState.currentPiece) {
            const fromPosition = { ...updatedState.currentPiece.position };
            const movedPiece = this.tetrisLogic.moveTetrisBlock(
              updatedState.currentPiece,
              updatedState.board,
              0,
              1,
            );
            if (movedPiece) {
              updatedState.currentPiece = movedPiece;
              // 고스트 피스 업데이트
              updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
                movedPiece,
                updatedState.board,
              );
              this.logger.logPieceMovement(playerId, 'moveDown', {
                fromPosition,
                toPosition: movedPiece.position,
                pieceType: movedPiece.type,
                success: true,
              });
            } else {
              // 조각을 보드에 고정
              updatedState.board = this.tetrisLogic.placeTetrisBlock(
                updatedState.currentPiece,
                updatedState.board,
              );

              // 라인 클리어 및 점수 계산
              const oldScore = updatedState.score;
              const oldLevel = updatedState.level;
              const clearResult =
                this.tetrisLogic.clearLinesAndCalculateScoreForServer(
                  updatedState.board,
                  updatedState.level,
                );
              updatedState.board = clearResult.newBoard;
              updatedState.linesCleared += clearResult.linesCleared;
              updatedState.score += clearResult.score;

              // 라인 클리어 로그
              if (clearResult.linesCleared > 0) {
                this.logger.logLineClear(playerId, {
                  linesCleared: clearResult.linesCleared,
                  oldScore,
                  newScore: updatedState.score,
                  oldLevel,
                  newLevel: updatedState.level,
                });
              }

              // 다음 조각 생성
              updatedState.currentPiece = this.createNewPiece(updatedState);
              updatedState.nextPiece = this.getNextPiece(updatedState);
              // 고스트 피스 업데이트
              updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
                updatedState.currentPiece,
                updatedState.board,
              );

              // 7-bag 시스템 로그
              this.logger.logTetrominoBag(playerId, 'nextPiece', {
                bag: updatedState.tetrominoBag,
                bagIndex: updatedState.bagIndex,
                nextPiece: updatedState.nextPiece,
                bagLength: updatedState.tetrominoBag.length,
                willRegenerate:
                  updatedState.bagIndex >= updatedState.tetrominoBag.length,
              });

              // 레벨 업데이트
              updatedState.level = this.calculateLevel(
                updatedState.linesCleared,
              );

              // 레벨이 변경되었으면 타이머 재시작
              if (updatedState.level !== playerState.level) {
                this.restartGameTimerWithLevel(playerId, updatedState.level);
              }

              // 표준 테트리스 게임오버 체크: 새로운 피스가 스폰될 수 없으면 게임오버
              updatedState.gameOver = this.tetrisLogic.isGameOverForServer(
                updatedState.board,
              );

              // 게임오버인 경우 처리
              if (updatedState.gameOver) {
                this.logger.log(`게임오버 (moveDown): ${playerId}`, {
                  playerId,
                  finalScore: updatedState.score,
                  finalLevel: updatedState.level,
                  finalLines: updatedState.linesCleared,
                });

                // 게임 타이머 정지
                this.stopGameTimer(playerId);

                // 게임오버 처리
                await this.handleGameOver(playerId);
              }

              this.logger.logPieceMovement(playerId, 'moveDown', {
                fromPosition,
                pieceType: updatedState.currentPiece?.type || 'unknown',
                success: false,
                reason: 'Piece placed on board',
              });
            }
          }
          break;

        case 'rotate':
          if (updatedState.currentPiece) {
            const rotatedPiece = this.tetrisLogic.rotateTetrisBlockWithWallKick(
              updatedState.currentPiece,
              updatedState.board,
            );
            if (rotatedPiece) {
              updatedState.currentPiece = rotatedPiece;
              // 고스트 피스 업데이트
              updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
                rotatedPiece,
                updatedState.board,
              );
              this.logger.logPieceMovement(playerId, 'rotate', {
                pieceType: rotatedPiece.type,
                success: true,
              });
            } else {
              this.logger.logPieceMovement(playerId, 'rotate', {
                pieceType: updatedState.currentPiece.type,
                success: false,
                reason: 'Rotation failed - wall kick not possible',
              });
            }
          }
          break;

        case 'hardDrop':
          if (updatedState.currentPiece) {
            const dropResult = this.tetrisLogic.hardDropTetrisBlock(
              updatedState.currentPiece,
              updatedState.board,
            );
            updatedState.currentPiece = dropResult.droppedPiece;
            updatedState.score += dropResult.dropDistance * 2; // 하드드롭 보너스

            // 조각을 보드에 고정
            updatedState.board = this.tetrisLogic.placeTetrisBlock(
              updatedState.currentPiece,
              updatedState.board,
            );

            // 라인 클리어 및 점수 계산
            const oldScore = updatedState.score;
            const oldLevel = updatedState.level;
            const clearResult =
              this.tetrisLogic.clearLinesAndCalculateScoreForServer(
                updatedState.board,
                updatedState.level,
              );
            updatedState.board = clearResult.newBoard;
            updatedState.linesCleared += clearResult.linesCleared;
            updatedState.score += clearResult.score;

            // 라인 클리어 로그
            if (clearResult.linesCleared > 0) {
              this.logger.logLineClear(playerId, {
                linesCleared: clearResult.linesCleared,
                oldScore,
                newScore: updatedState.score,
                oldLevel,
                newLevel: updatedState.level,
              });
            }

            // 다음 조각 생성
            updatedState.currentPiece = this.createNewPiece(updatedState);
            updatedState.nextPiece = this.getNextPiece(updatedState);
            // 고스트 피스 업데이트
            updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
              updatedState.currentPiece,
              updatedState.board,
            );

            // 레벨 업데이트
            updatedState.level = this.calculateLevel(updatedState.linesCleared);

            // 레벨이 변경되었으면 타이머 재시작
            if (updatedState.level !== playerState.level) {
              this.restartGameTimerWithLevel(playerId, updatedState.level);
            }

            // 표준 테트리스 게임오버 체크: 새로운 피스가 스폰될 수 없으면 게임오버
            updatedState.gameOver = this.tetrisLogic.isGameOverForServer(
              updatedState.board,
            );

            // 게임오버인 경우 처리
            if (updatedState.gameOver) {
              this.logger.log(`게임오버 (hardDrop): ${playerId}`, {
                playerId,
                finalScore: updatedState.score,
                finalLevel: updatedState.level,
                finalLines: updatedState.linesCleared,
              });

              // 게임 타이머 정지
              this.stopGameTimer(playerId);

              // 게임오버 처리
              await this.handleGameOver(playerId);
            }

            this.logger.logPieceMovement(playerId, 'hardDrop', {
              pieceType: updatedState.currentPiece?.type || 'unknown',
              success: true,
              reason: `Dropped ${dropResult.dropDistance} lines`,
            });
          }
          break;

        case 'hold':
          if (updatedState.canHold) {
            const temp = updatedState.heldPiece;
            updatedState.heldPiece = updatedState.currentPiece.type;
            updatedState.currentPiece = this.tetrisLogic.createTetrisBlock(
              temp || this.getNextPiece(updatedState),
            );
            // 고스트 피스 업데이트
            updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
              updatedState.currentPiece,
              updatedState.board,
            );
            updatedState.canHold = false;
          }
          break;

        default:
          this.logger.logInvalidInput(playerId, action, 'Unknown action');
          return null;
      }

      // 상태 업데이트
      await this.updatePlayerGameState(playerId, updatedState);

      // 게임 상태 변경 이벤트 발행
      await this.publishGameStateUpdate(playerId, updatedState);

      // 플레이어 상태 변경 이벤트 발행 (룸의 다른 플레이어들에게 알림)
      if (updatedState.roomId) {
        await this.publishPlayerStateChanged(updatedState.roomId);
      }

      this.logger.logGameLogic(playerId, action, {
        newScore: updatedState.score,
        newLevel: updatedState.level,
        newLines: updatedState.linesCleared,
        gameOver: updatedState.gameOver,
      });

      return updatedState;
    } catch (error) {
      this.logger.logError(error);
      return null;
    }
  }

  // 서버에서 자동으로 블록을 떨어뜨리는 메서드
  async autoDropPiece(playerId: string): Promise<PlayerGameState | null> {
    try {
      const playerState = await this.getPlayerGameState(playerId);
      if (!playerState || playerState.gameOver || !playerState.currentPiece) {
        return null;
      }

      // 현재 조각을 한 칸 아래로 이동
      const movedPiece = this.tetrisLogic.moveTetrisBlock(
        playerState.currentPiece,
        playerState.board,
        0,
        1,
      );

      if (movedPiece) {
        // 이동 가능한 경우
        const updatedState = {
          ...playerState,
          currentPiece: movedPiece,
          // 고스트 피스 업데이트
          ghostPiece: this.tetrisLogic.getGhostPiece(
            movedPiece,
            playerState.board,
          ),
        };
        await this.updatePlayerGameState(playerId, updatedState);
        await this.publishGameStateUpdate(playerId, updatedState);
        return updatedState;
      } else {
        // 이동 불가능한 경우 (바닥에 닿음)
        const updatedState = { ...playerState };

        // 조각을 보드에 고정
        updatedState.board = this.tetrisLogic.placeTetrisBlock(
          updatedState.currentPiece,
          updatedState.board,
        );

        // 라인 클리어 및 점수 계산
        const clearResult =
          this.tetrisLogic.clearLinesAndCalculateScoreForServer(
            updatedState.board,
            updatedState.level,
          );
        updatedState.board = clearResult.newBoard;
        updatedState.linesCleared += clearResult.linesCleared;
        updatedState.score += clearResult.score;

        // 테트리스 표준: 다음 조각 생성
        updatedState.currentPiece = this.createNewPiece(updatedState);
        updatedState.nextPiece = this.getNextPiece(updatedState);
        // 고스트 피스 업데이트
        updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
          updatedState.currentPiece,
          updatedState.board,
        );

        // 레벨 업데이트
        updatedState.level = this.calculateLevel(updatedState.linesCleared);

        // 레벨이 변경되었으면 타이머 재시작
        if (updatedState.level !== playerState.level) {
          this.restartGameTimerWithLevel(playerId, updatedState.level);
        }

        // 표준 테트리스 게임오버 체크: 새로운 피스가 스폰될 수 없으면 게임오버
        updatedState.gameOver = this.tetrisLogic.isGameOverForServer(
          updatedState.board,
        );

        // 게임오버인 경우 처리
        if (updatedState.gameOver) {
          this.logger.log(`게임오버 (자동 드롭): ${playerId}`, {
            playerId,
            finalScore: updatedState.score,
            finalLevel: updatedState.level,
            finalLines: updatedState.linesCleared,
          });

          // 게임 타이머 정지
          this.stopGameTimer(playerId);

          // 게임오버 처리
          await this.handleGameOver(playerId);
        }

        await this.updatePlayerGameState(playerId, updatedState);
        await this.publishGameStateUpdate(playerId, updatedState);

        // 플레이어 상태 변경 이벤트 발행 (룸의 다른 플레이어들에게 알림)
        if (updatedState.roomId) {
          await this.publishPlayerStateChanged(updatedState.roomId);
        }

        return updatedState;
      }
    } catch (error) {
      this.logger.logError(error);
      return null;
    }
  }

  // 새로운 조각 생성
  private createNewPiece(playerState: PlayerGameState): any {
    const pieceType = this.getNextPiece(playerState);
    const newPiece = this.tetrisLogic.createTetrisBlock(pieceType);
    return newPiece;
  }

  // 테트리스 표준 7-bag 시스템에서 다음 조각 가져오기
  private getNextPiece(playerState: PlayerGameState): TetrominoType {
    // 가방이 비어있거나 모든 조각을 사용했으면 새로운 가방 생성
    if (
      !playerState.tetrominoBag ||
      playerState.bagIndex >= playerState.tetrominoBag.length
    ) {
      // 가방 번호 증가
      playerState.bagNumber++;

      // 시드에 가방 번호를 추가하여 각 가방마다 다른 순서 생성
      const bagSeed = playerState.gameSeed + playerState.bagNumber;

      // 시드 기반으로 새로운 7-bag 생성
      playerState.tetrominoBag = this.generateNewBagWithSeed(bagSeed);
      playerState.bagIndex = 0;

      // 디버깅 로그
      if (process.env.NODE_ENV === 'development') {
        console.log(
          `Server: Generated new bag for player ${playerState.playerId} (gameSeed: ${playerState.gameSeed}, bagSeed: ${bagSeed}, bagNumber: ${playerState.bagNumber}):`,
          playerState.tetrominoBag,
        );
      }
    }

    const pieceType = playerState.tetrominoBag[playerState.bagIndex];
    playerState.bagIndex++;

    // 디버깅 로그
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `Server: Player ${playerState.playerId} got piece: ${pieceType} (bagIndex: ${playerState.bagIndex}/${playerState.tetrominoBag.length}, bagNumber: ${playerState.bagNumber}, bag: ${playerState.tetrominoBag.join(',')})`,
      );
    }

    return pieceType;
  }

  // 테트리스 표준: 다음 피스들을 미리 생성하여 큐에 저장
  private generateNextPieces(
    playerState: PlayerGameState,
    count: number = 6,
  ): TetrominoType[] {
    const pieces: TetrominoType[] = [];
    for (let i = 0; i < count; i++) {
      pieces.push(this.getNextPiece(playerState));
    }
    return pieces;
  }

  // 테트리스 표준 7-bag 시스템으로 새로운 가방 생성 (시드 기반)
  private generateNewBagWithSeed(seed: number): TetrominoType[] {
    const pieces: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    const bag = [...pieces];

    // 시드 기반 셔플 (Fisher-Yates 알고리즘)
    const seededRandom = this.createSeededRandom(seed);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }

    // 디버깅을 위한 로그 (개발 환경에서만)
    if (process.env.NODE_ENV === 'development') {
      console.log(`Generated bag with seed ${seed}:`, bag);
    }

    return bag;
  }

  // 시드 기반 랜덤 생성기 (클라이언트와 동일한 알고리즘)
  private createSeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      // 클라이언트와 동일한 Linear Congruential Generator 사용
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  // 서버 권위적: 클라이언트에게 전송할 다음 피스 큐 생성
  private generateNextPiecesForClient(
    playerState: PlayerGameState,
    count: number = 6,
  ): TetrominoType[] {
    const pieces: TetrominoType[] = [];

    // 현재 가방 상태를 저장
    const currentBagIndex = playerState.bagIndex;
    const currentBagNumber = playerState.bagNumber;
    const currentBag = [...playerState.tetrominoBag];

    for (let i = 0; i < count; i++) {
      pieces.push(this.getNextPiece(playerState));
    }

    // 가방 상태를 원래대로 복원 (클라이언트 전송용이므로 실제 상태는 변경하지 않음)
    playerState.bagIndex = currentBagIndex;
    playerState.bagNumber = currentBagNumber;
    playerState.tetrominoBag = currentBag;

    return pieces;
  }

  // 문자열을 해시하는 유틸리티 메서드
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // 32비트 정수로 변환
    }
    return Math.abs(hash);
  }

  /**
   * 게임 상태 업데이트 이벤트 발행 (서버 권위적 블록 생성)
   */
  async publishGameStateUpdate(
    playerId: string,
    gameState: PlayerGameState,
  ): Promise<void> {
    try {
      // 게임이 시작되었지만 currentPiece가 null인 경우 새로운 피스 생성
      if (gameState.gameStarted && !gameState.currentPiece) {
        this.logger.log(
          `publishGameStateUpdate에서 currentPiece가 null이므로 새로운 피스 생성: ${playerId}`,
          {
            playerId,
            gameState: gameState,
          },
        );

        // 새로운 피스 생성
        const newPiece = this.tetrisLogic.createTetrisBlock(
          gameState.nextPiece,
        );
        const nextPiece = this.getNextPiece(gameState);

        // 게임 상태 업데이트
        const updatedGameState = {
          ...gameState,
          currentPiece: newPiece,
          nextPiece: nextPiece,
          ghostPiece: this.tetrisLogic.getGhostPiece(newPiece, gameState.board),
        };

        // Redis에 업데이트된 상태 저장
        await this.redisService.set(
          `player_game:${playerId}`,
          JSON.stringify(updatedGameState),
        );

        this.logger.log(
          `publishGameStateUpdate에서 새로운 피스 생성 완료: ${playerId}`,
          {
            playerId,
            newPiece: newPiece,
            nextPiece: nextPiece,
          },
        );

        // 업데이트된 상태로 게임 상태 업데이트 발행
        await this.publishGameStateUpdateInternal(playerId, updatedGameState);
        return;
      }

      // 기존 로직
      await this.publishGameStateUpdateInternal(playerId, gameState);
    } catch (error) {
      this.logger.log(`게임 상태 업데이트 발행 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
  }

  private async publishGameStateUpdateInternal(
    playerId: string,
    gameState: PlayerGameState,
  ): Promise<void> {
    // 클라이언트용 게임 상태 생성 (서버 상태와 분리)
    const clientGameState = {
      ...gameState,
      // 서버 권위적: 클라이언트에는 필요한 정보만 전송
      currentPiece: gameState.currentPiece,
      ghostPiece: gameState.ghostPiece,
      nextPieces: this.generateNextPiecesForClient(gameState, 6),
    };

    // currentPiece가 null인 경우 새로운 조각 생성
    if (!clientGameState.currentPiece && !gameState.gameOver) {
      this.logger.log(
        `currentPiece가 null이므로 새로운 조각 생성: ${playerId}`,
        {
          playerId,
          gameState: gameState,
        },
      );

      // 새로운 조각 생성
      const newPieceType = this.getNextPiece(gameState);
      const newPiece = this.tetrisLogic.createTetrisBlock(newPieceType);

      // 게임 상태 업데이트
      const updatedGameState = {
        ...gameState,
        currentPiece: newPiece,
        ghostPiece: this.tetrisLogic.getGhostPiece(newPiece, gameState.board),
        nextPiece: this.getNextPiece({ ...gameState, currentPiece: newPiece }),
      };

      // Redis에 업데이트된 게임 상태 저장
      await this.redisService.set(
        `player_game:${playerId}`,
        JSON.stringify(updatedGameState),
      );

      // 업데이트된 상태로 클라이언트 전송
      clientGameState.currentPiece = newPiece;
      clientGameState.ghostPiece = updatedGameState.ghostPiece;
      clientGameState.nextPiece = updatedGameState.nextPiece;

      this.logger.log(`새로운 조각 생성 완료: ${playerId}`, {
        playerId,
        newPiece,
        updatedGameState: updatedGameState,
      });
    }

    // 디버깅 로그 추가
    this.logger.log(`클라이언트로 전송할 게임 상태:`, {
      playerId,
      originalCurrentPiece: gameState.currentPiece,
      clientCurrentPiece: clientGameState.currentPiece,
      originalGhostPiece: gameState.ghostPiece,
      clientGhostPiece: clientGameState.ghostPiece,
    });

    this.logger.log(`게임 상태 업데이트 이벤트 발행: ${playerId}`, {
      playerId,
      gameState: clientGameState,
    });

    // Redis에 게임 상태 업데이트 발행
    await this.redisService.publish(`game_state_update:${playerId}`, {
      type: 'game_state_update',
      playerId,
      gameState: clientGameState,
      timestamp: Date.now(),
    });
  }

  /**
   * 조각 배치 시뮬레이션
   */
  private simulatePiecePlacement(
    board: number[][],
    piece: string,
    pieceX: number = 3,
    pieceY: number = 16,
    pieceRotation: number = 0,
  ): number[][] {
    const newBoard = board.map((row) => [...row]);

    // 조각을 지정된 위치에 배치
    const pieceShape = this.getRotatedPieceShape(piece, pieceRotation);

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (pieceShape[y][x] === 1) {
          const boardX = pieceX + x;
          const boardY = pieceY + y;

          if (boardY >= 0 && boardY < 20 && boardX >= 0 && boardX < 10) {
            newBoard[boardY][boardX] = 1;
          }
        }
      }
    }

    // 라인 클리어 체크 및 처리
    const clearedBoard = this.checkAndClearLines(newBoard);

    return clearedBoard;
  }

  /**
   * 라인 클리어 체크 및 처리
   */
  private checkAndClearLines(board: number[][]): number[][] {
    const newBoard = [...board];
    let linesCleared = 0;

    // 아래쪽부터 라인 체크
    for (let y = 19; y >= 0; y--) {
      if (newBoard[y].every((cell) => cell === 1)) {
        // 라인 제거
        newBoard.splice(y, 1);
        // 빈 라인 추가
        newBoard.unshift(new Array(10).fill(0));
        linesCleared++;
        y++; // 같은 위치 다시 체크
      }
    }

    if (linesCleared > 0) {
      this.logger.log(`${linesCleared}줄 클리어됨`, { linesCleared });
    }

    return newBoard;
  }

  /**
   * 회전된 조각 모양 반환 (새로운 테트리스 로직)
   */
  private getRotatedPieceShape(piece: string, rotation: number): number[][] {
    const tetrominoType = piece as TetrominoType;
    const pieceShapes = this.tetrisLogic.TETROMINO_SHAPES[tetrominoType];

    if (!pieceShapes) {
      // 기본 I 피스 반환
      return [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
    }

    return pieceShapes[rotation % 4] || pieceShapes[0];
  }

  /**
   * 조각 회전 (시계방향 90도)
   */
  private rotateShape(shape: number[][]): number[][] {
    const rotated = [];
    for (let x = 0; x < 4; x++) {
      rotated[x] = [];
      for (let y = 0; y < 4; y++) {
        rotated[x][y] = shape[3 - y][x];
      }
    }
    return rotated;
  }

  /**
   * 레벨 계산
   */
  private calculateLevel(linesCleared: number): number {
    return Math.floor(linesCleared / 10) + 1;
  }

  /**
   * 랜덤 테트리스 조각 생성
   */
  private getRandomPiece(): string {
    const pieces = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    return pieces[Math.floor(Math.random() * pieces.length)];
  }

  /**
   * 빈 보드 생성
   */
  private createEmptyBoard(): number[][] {
    const board = [];
    for (let y = 0; y < 20; y++) {
      board[y] = [];
      for (let x = 0; x < 10; x++) {
        board[y][x] = 0;
      }
    }
    return board;
  }

  /**
   * 조각 모양 가져오기 (새로운 테트리스 로직)
   */
  private getPieceShape(piece: string): number[][] {
    const tetrominoType = piece as TetrominoType;
    const pieceShapes = this.tetrisLogic.TETROMINO_SHAPES[tetrominoType];

    if (!pieceShapes) {
      // 기본 I 피스 반환
      return [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
    }

    return pieceShapes[0];
  }

  /**
   * 플레이어가 룸을 떠날 때 처리
   */
  async leaveGameAuto(roomId: string, playerId: string): Promise<void> {
    try {
      // 1. 플레이어 게임 상태 정리
      await this.cleanupPlayerGameState(playerId);

      // 2. 플레이어 제거
      await this.removePlayerFromRoom(roomId, playerId);

      // 3. 룸의 현재 플레이어 수 확인
      const room = await this.getRoom(roomId);

      if (room && room.currentPlayers <= 0) {
        // 4. 모든 플레이어가 떠났으면 룸 삭제
        await this.deleteRoom(roomId);
        this.logger.log(`빈 룸 삭제: ${roomId}`, { roomId });
      } else {
        // 5. 룸 활동 시간 업데이트
        await this.updateRoomActivity(roomId);
      }

      this.logger.log(`플레이어 ${playerId}이(가) 룸 ${roomId}에서 퇴장`, {
        roomId,
        playerId,
      });
    } catch (error) {
      this.logger.log(`플레이어 퇴장 처리 실패: ${error.message}`, {
        error,
        roomId,
        playerId,
      });
      throw error;
    }
  }

  /**
   * 플레이어 게임 상태 정리
   */
  private async cleanupPlayerGameState(playerId: string): Promise<void> {
    try {
      await this.redisService.del(`player_game:${playerId}`);
      this.logger.log(`플레이어 ${playerId}의 게임 상태 정리 완료`, {
        playerId,
      });
    } catch (error) {
      this.logger.log(`플레이어 게임 상태 정리 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
  }

  /**
   * 사용 가능한 룸 찾기
   */
  private async findAvailableRoom(): Promise<any> {
    try {
      const allRooms = await this.getAllRooms();

      // 1. 게임 중인 방 중에서 플레이어 수가 99명 미만인 룸 찾기 (우선순위 1)
      let availableRoom = allRooms.find(
        (room) =>
          room.status === 'PLAYING' &&
          room.currentPlayers < this.MAX_PLAYERS_PER_ROOM,
      );

      // 2. 게임 중인 방이 없으면, 대기 중이고 플레이어 수가 99명 미만인 룸 찾기 (우선순위 2)
      if (!availableRoom) {
        availableRoom = allRooms.find(
          (room) =>
            room.status === 'WAITING' &&
            room.currentPlayers < this.MAX_PLAYERS_PER_ROOM,
        );
      }

      // 3. 대기 중인 방도 없으면, 어떤 상태든 플레이어 수가 99명 미만인 룸 찾기 (우선순위 3)
      if (!availableRoom) {
        availableRoom = allRooms.find(
          (room) => room.currentPlayers < this.MAX_PLAYERS_PER_ROOM,
        );
      }

      return availableRoom || null;
    } catch (error) {
      this.logger.log(`사용 가능한 룸 찾기 실패: ${error.message}`, { error });
      return null;
    }
  }

  /**
   * 새 룸 생성
   */
  private async createNewRoom(): Promise<any> {
    try {
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // 룸별 고유 시드 생성
      const roomSeed = Date.now() + Math.floor(Math.random() * 1000000);

      const room = {
        id: roomId,
        status: 'WAITING',
        maxPlayers: this.MAX_PLAYERS_PER_ROOM,
        currentPlayers: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
        roomSeed: roomSeed, // 룸별 고유 시드 추가
      };

      // Redis에 룸 정보 저장
      await this.redisService.set(`room:${roomId}`, JSON.stringify(room));

      // 룸 목록에 추가
      await this.redisService.sadd('active_rooms', roomId);

      this.logger.log(`새 룸 생성: ${roomId} (시드: ${roomSeed})`, {
        roomId,
        roomSeed,
      });

      return room;
    } catch (error) {
      this.logger.log(`새 룸 생성 실패: ${error.message}`, { error });
      throw error;
    }
  }

  /**
   * 플레이어를 룸에 참여시킴
   */
  private async joinPlayerToRoom(
    roomId: string,
    joinGameDto: JoinGameDto,
  ): Promise<any> {
    // Redis에 플레이어 생성
    const player = await this.redisService.createPlayer({
      name: joinGameDto.name,
      socketId: joinGameDto.socketId,
      gameId: roomId,
      status: 'ALIVE',
      score: 0,
      linesCleared: 0,
      level: 0,
    });

    // 룸의 플레이어 수 증가
    await this.incrementRoomPlayers(roomId);

    return player;
  }

  /**
   * 플레이어를 룸에서 제거
   */
  private async removePlayerFromRoom(
    roomId: string,
    playerId: string,
  ): Promise<void> {
    // Redis에서 플레이어 삭제
    await this.redisService.deletePlayer(playerId);

    // 룸의 플레이어 수 감소
    await this.decrementRoomPlayers(roomId);
  }

  /**
   * 룸의 플레이어 수 증가
   */
  private async incrementRoomPlayers(roomId: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (room) {
      room.currentPlayers += 1;
      await this.redisService.set(`room:${roomId}`, JSON.stringify(room));
    }
  }

  /**
   * 룸의 플레이어 수 감소
   */
  private async decrementRoomPlayers(roomId: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (room && room.currentPlayers > 0) {
      room.currentPlayers -= 1;
      await this.redisService.set(`room:${roomId}`, JSON.stringify(room));
    }
  }

  /**
   * 게임 자동 시작
   */
  private async autoStartGame(roomId: string): Promise<void> {
    try {
      // 룸 상태를 PLAYING으로 업데이트
      await this.updateRoomStatus(roomId, 'PLAYING');

      // 룸의 모든 플레이어 게임 시작
      const players = await this.getRoomPlayers(roomId);
      for (const player of players) {
        if (player.id) {
          await this.startPlayerGame(player.id, roomId);
        }
      }

      this.logger.log(`게임 자동 시작: ${roomId}`, { roomId });
    } catch (error) {
      this.logger.log(`게임 자동 시작 실패: ${error.message}`, {
        error,
        roomId,
      });
    }
  }

  /**
   * 룸 삭제
   */
  private async deleteRoom(roomId: string): Promise<void> {
    try {
      // Redis에서 룸 정보 삭제
      await this.redisService.del(`room:${roomId}`);

      // 활성 룸 목록에서 제거
      await this.redisService.srem('active_rooms', roomId);

      this.logger.log(`룸 삭제 완료: ${roomId}`, { roomId });
    } catch (error) {
      this.logger.log(`룸 삭제 실패: ${error.message}`, { error, roomId });
    }
  }

  /**
   * 룸 활동 시간 업데이트
   */
  private async updateRoomActivity(roomId: string): Promise<void> {
    try {
      const room = await this.getRoom(roomId);
      if (room) {
        room.lastActivity = new Date();
        await this.redisService.set(`room:${roomId}`, JSON.stringify(room));
      }
    } catch (error) {
      this.logger.log(`룸 활동 시간 업데이트 실패: ${error.message}`, {
        error,
        roomId,
      });
    }
  }

  /**
   * 룸 상태 업데이트
   */
  private async updateRoomStatus(
    roomId: string,
    status: string,
  ): Promise<void> {
    try {
      const room = await this.getRoom(roomId);
      if (room) {
        room.status = status;
        room.lastActivity = new Date();
        await this.redisService.set(`room:${roomId}`, JSON.stringify(room));
      }
    } catch (error) {
      this.logger.log(`룸 상태 업데이트 실패: ${error.message}`, {
        error,
        roomId,
        status,
      });
    }
  }

  /**
   * 특정 룸 정보 가져오기
   */
  async getRoom(roomId: string): Promise<any> {
    try {
      const roomData = await this.redisService.get(`room:${roomId}`);
      if (!roomData) {
        return null;
      }

      const room = JSON.parse(roomData);

      // 기존 룸에 시드가 없으면 추가 (하위 호환성)
      if (!room.roomSeed) {
        room.roomSeed = Date.now() + Math.floor(Math.random() * 1000000);
        await this.redisService.set(`room:${roomId}`, JSON.stringify(room));

        this.logger.log(
          `기존 룸에 시드 추가: ${roomId} (시드: ${room.roomSeed})`,
          {
            roomId,
            roomSeed: room.roomSeed,
          },
        );
      }

      return room;
    } catch (error) {
      this.logger.log(`룸 정보 조회 실패: ${error.message}`, { error, roomId });
      return null;
    }
  }

  /**
   * 모든 룸 가져오기
   */
  async getAllRooms(): Promise<any[]> {
    try {
      const roomIds = await this.redisService.smembers('active_rooms');
      const rooms: any[] = [];

      for (const roomId of roomIds) {
        const room = await this.getRoom(roomId);
        if (room) {
          rooms.push(room);
        }
      }

      return rooms;
    } catch (error) {
      this.logger.log(`모든 룸 조회 실패: ${error.message}`, { error });
      return [];
    }
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
    // await this.prisma.player.update({
    //   where: { id: playerId },
    //   data: { status: PlayerStatus.ELIMINATED },
    // });

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
      // await this.prisma.game.update({
      //   where: { id: player.gameId },
      //   data: {
      //     status: GameStatus.FINISHED,
      //     winnerId: updateData.winnerId,
      //   },
      // });

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

  /**
   * 룸 통계 정보
   */
  async getRoomStats(): Promise<{
    totalRooms: number;
    waitingRooms: number;
    playingRooms: number;
    totalPlayers: number;
    roomsWithSeeds: number;
  }> {
    try {
      const rooms = await this.getAllRooms();

      const stats = {
        totalRooms: rooms.length,
        waitingRooms: rooms.filter((r) => r.status === 'WAITING').length,
        playingRooms: rooms.filter((r) => r.status === 'PLAYING').length,
        totalPlayers: rooms.reduce((sum, room) => sum + room.currentPlayers, 0),
        roomsWithSeeds: rooms.filter((r) => r.roomSeed).length,
      };

      return stats;
    } catch (error) {
      this.logger.log(`룸 통계 조회 실패: ${error.message}`, { error });
      return {
        totalRooms: 0,
        waitingRooms: 0,
        playingRooms: 0,
        totalPlayers: 0,
        roomsWithSeeds: 0,
      };
    }
  }

  /**
   * 룸의 전체 게임 상태 조회
   */
  async getRoomGameState(roomId: string): Promise<any> {
    try {
      const room = await this.getRoom(roomId);
      if (!room) {
        return null;
      }

      const roomPlayers = await this.getRoomPlayers(roomId);

      // 게임 진행 상황 분석
      const activePlayers = roomPlayers.filter(
        (p) => p.gameState && !p.gameState.gameOver,
      );
      const finishedPlayers = roomPlayers.filter(
        (p) => p.gameState && p.gameState.gameOver,
      );

      const gameState = {
        roomId,
        totalPlayers: roomPlayers.length,
        activePlayers: activePlayers.length,
        finishedPlayers: finishedPlayers.length,
        gameStarted: activePlayers.some((p) => p.gameState?.gameStarted),
        gameOver: activePlayers.length === 0 && finishedPlayers.length > 0,
        players: roomPlayers,
        // 추가 상세 정보
        roomStatus:
          activePlayers.length === 0
            ? 'WAITING'
            : activePlayers.some((p) => p.gameState?.gameStarted)
              ? 'PLAYING'
              : 'READY',
        averageScore:
          activePlayers.length > 0
            ? Math.round(
                activePlayers.reduce(
                  (sum, p) => sum + (p.gameState?.score || 0),
                  0,
                ) / activePlayers.length,
              )
            : 0,
        highestScore:
          activePlayers.length > 0
            ? Math.max(...activePlayers.map((p) => p.gameState?.score || 0))
            : 0,
        timestamp: Date.now(),
      };

      this.logger.log(`룸 ${roomId} 게임 상태 조회`, {
        roomId,
        totalPlayers: gameState.totalPlayers,
        activePlayers: gameState.activePlayers,
        gameStarted: gameState.gameStarted,
        gameOver: gameState.gameOver,
      });

      return gameState;
    } catch (error) {
      this.logger.log(`룸 게임 상태 조회 실패: ${error.message}`, {
        error,
        roomId,
      });
      return null;
    }
  }

  /**
   * 룸의 모든 플레이어 정보 가져오기
   */
  async getRoomPlayers(
    roomId: string,
    includeGameState: boolean = true,
  ): Promise<any[]> {
    try {
      const room = await this.getRoom(roomId);
      if (!room) {
        throw new Error(`룸 ${roomId}을 찾을 수 없습니다.`);
      }

      // Redis에서 해당 룸의 모든 플레이어 가져오기
      const allPlayers = await this.redisService.getAllPlayers();
      const roomPlayers = allPlayers.filter(
        (player) => player.gameId === roomId,
      );

      // 게임 상태 정보 포함 여부에 따라 처리
      let playersWithGameState = roomPlayers;

      if (includeGameState) {
        // 각 플레이어의 게임 상태 정보도 포함
        playersWithGameState = await Promise.all(
          roomPlayers.map(async (player) => {
            const gameState = await this.getPlayerGameState(player.id);
            return {
              ...player,
              gameState: gameState
                ? {
                    score: gameState.score,
                    level: gameState.level,
                    linesCleared: gameState.linesCleared,
                    gameOver: gameState.gameOver,
                    gameStarted: gameState.gameStarted,
                  }
                : null,
            };
          }),
        );
      }

      // 로그 레벨을 낮추고 호출 빈도 제한
      if (process.env.NODE_ENV === 'development') {
        this.logger.log(
          `룸 ${roomId}의 플레이어 목록 조회: ${playersWithGameState.length}명`,
          {
            roomId,
            playerCount: playersWithGameState.length,
            includeGameState,
          },
        );
      }

      return playersWithGameState;
    } catch (error) {
      this.logger.log(`룸 플레이어 조회 실패: ${error.message}`, {
        error,
        roomId,
      });
      return [];
    }
  }

  /**
   * 플레이어 상태 변경 시 Redis에 publish
   */
  async publishPlayerStateChanged(roomId: string): Promise<void> {
    try {
      const players = await this.getRoomPlayers(roomId, true);

      await this.redisService.publish('player_state_changed:' + roomId, {
        roomId,
        players,
        timestamp: Date.now(),
      });

      this.logger.log(`플레이어 상태 변경 이벤트 발행: ${roomId}`, {
        roomId,
        playerCount: players.length,
      });
    } catch (error) {
      this.logger.log(`플레이어 상태 변경 이벤트 발행 실패: ${error.message}`, {
        error,
        roomId,
      });
    }
  }

  /**
   * 개별 플레이어 정보 가져오기
   */
  async getPlayerInfo(playerId: string): Promise<any> {
    try {
      const player = await this.redisService.getPlayer(playerId);
      if (!player) {
        throw new Error(`플레이어 ${playerId}을 찾을 수 없습니다.`);
      }

      const gameState = await this.getPlayerGameState(playerId);

      const playerInfo = {
        ...player,
        gameState: gameState
          ? {
              score: gameState.score,
              level: gameState.level,
              linesCleared: gameState.linesCleared,
              gameOver: gameState.gameOver,
              gameStarted: gameState.gameStarted,
              currentPiece: gameState.currentPiece,
              nextPiece: gameState.nextPiece,
              heldPiece: gameState.heldPiece,
              canHold: gameState.canHold,
              board: gameState.board,
              paused: gameState.paused,
            }
          : null,
      };

      this.logger.log(`플레이어 ${playerId} 정보 조회`, {
        playerId,
        playerName: player.name,
      });

      return playerInfo;
    } catch (error) {
      this.logger.log(`플레이어 정보 조회 실패: ${error.message}`, {
        error,
        playerId,
      });
      throw error;
    }
  }

  /**
   * 서버 권위의 게임 오버 처리
   */
  async handleGameOver(playerId: string): Promise<void> {
    try {
      // 게임 오버 처리
      const playerState = await this.getPlayerGameState(playerId);
      if (!playerState) {
        return;
      }

      // 게임 타이머 정지
      this.stopGameTimer(playerId);

      // 최종 점수 저장
      await this.updatePlayerStats(playerId, {
        score: playerState.score,
        linesCleared: playerState.linesCleared,
        level: playerState.level,
      });

      // 룸의 다른 플레이어들에게 게임 오버 알림
      const roomId = playerState.roomId;
      if (roomId) {
        await this.publishGameEvent(roomId, 'playerGameOver', {
          playerId,
          finalScore: playerState.score,
          finalLevel: playerState.level,
          finalLines: playerState.linesCleared,
          reason: '새로운 피스를 스폰할 수 없습니다',
          timestamp: Date.now(),
        });
      }

      // 게임오버 이벤트를 클라이언트에게 별도로 전송
      await this.redisService.publish(`game_state_update:${playerId}`, {
        type: 'gameOver',
        playerId,
        finalScore: playerState.score,
        finalLevel: playerState.level,
        finalLines: playerState.linesCleared,
        reason: '새로운 피스를 스폰할 수 없습니다',
        timestamp: Date.now(),
      });

      // 게임오버 상태를 클라이언트에게 전송
      await this.publishGameStateUpdate(playerId, {
        ...playerState,
        gameOver: true,
        currentPiece: null,
        ghostPiece: null,
        nextPiece: null,
      });

      // 플레이어 상태 변경 이벤트 발행 (룸의 다른 플레이어들에게 알림)
      if (roomId) {
        await this.publishPlayerStateChanged(roomId);
      }

      // 플레이어 상태 정리
      await this.cleanupPlayerGameState(playerId);

      this.logger.logGameFinished(roomId, playerId);
    } catch (error) {
      this.logger.logError(error);
    }
  }

  // 게임 밸런싱: 공격 시스템
  async calculateAttack(
    playerId: string,
    linesCleared: number,
  ): Promise<number> {
    const playerState = await this.getPlayerGameState(playerId);
    if (!playerState) {
      return 0;
    }

    // 공격 계산 (라인 수에 따른 공격력)
    let attackLines = 0;

    switch (linesCleared) {
      case 1: // Single
        attackLines = 0;
        break;
      case 2: // Double
        attackLines = 1;
        break;
      case 3: // Triple
        attackLines = 2;
        break;
      case 4: // Tetris
        attackLines = 4;
        break;
      default:
        attackLines = 0;
    }

    // 레벨에 따른 공격력 증가
    const levelMultiplier = Math.floor(playerState.level / 10) + 1;
    attackLines *= levelMultiplier;

    return attackLines;
  }

  // 게임 밸런싱: 난이도 조절
  async adjustDifficulty(playerId: string): Promise<void> {
    const playerState = await this.getPlayerGameState(playerId);
    if (!playerState) {
      return;
    }

    // 플레이어 성과에 따른 난이도 조절
    const performance = playerState.score / Math.max(playerState.level, 1);

    if (performance > 1000) {
      // 고수 플레이어: 난이도 증가
      await this.updatePlayerGameState(playerId, {
        level: playerState.level + 1,
      });
    } else if (performance < 100 && playerState.level > 1) {
      // 초보 플레이어: 난이도 감소
      await this.updatePlayerGameState(playerId, {
        level: Math.max(1, playerState.level - 1),
      });
    }
  }

  // 게임 밸런싱: 매칭 시스템
  async findBalancedRoom(
    playerId: string,
    playerSkill: number,
  ): Promise<string | null> {
    const allRooms = await this.getAllRooms();

    // 스킬 레벨에 따른 룸 매칭
    const suitableRooms = allRooms.filter((room) => {
      const avgSkill = room.averageSkill || 1000;
      const skillDiff = Math.abs(avgSkill - playerSkill);
      return skillDiff < 500 && room.currentPlayers < room.maxPlayers;
    });

    if (suitableRooms.length > 0) {
      // 가장 적합한 룸 선택
      return suitableRooms.sort((a, b) => {
        const aSkillDiff = Math.abs(a.averageSkill - playerSkill);
        const bSkillDiff = Math.abs(b.averageSkill - playerSkill);
        return aSkillDiff - bSkillDiff;
      })[0].id;
    }

    return null;
  }

  /**
   * 서버 권위적으로 게임 상태 수정 (클라이언트-서버 동기화 문제 해결)
   */
  async fixGameStateSync(playerId: string): Promise<PlayerGameState | null> {
    try {
      const playerState = await this.getPlayerGameState(playerId);
      if (!playerState) {
        return null;
      }

      this.logger.log(`게임 상태 동기화 수정 시작: ${playerId}`, {
        playerId,
        currentPiece: playerState.currentPiece?.type,
        ghostPiece: playerState.ghostPiece?.type,
        score: playerState.score,
        level: playerState.level,
        gameOver: playerState.gameOver,
      });

      const updatedState = { ...playerState };
      let needsUpdate = false;

      // 0. 게임 오버 상태에서 조각이 스폰 위치에 있는 경우 처리
      if (updatedState.gameOver && updatedState.currentPiece) {
        // 게임 오버 상태에서는 현재 조각을 제거
        updatedState.currentPiece = null;
        updatedState.ghostPiece = null;
        updatedState.nextPiece = null;
        needsUpdate = true;

        this.logger.log(`게임 오버 상태에서 조각 제거: ${playerId}`, {
          playerId,
        });
      }

      // 1. 현재 조각과 고스트 조각 타입 불일치 수정
      if (
        updatedState.currentPiece &&
        updatedState.ghostPiece &&
        !updatedState.gameOver
      ) {
        if (updatedState.currentPiece.type !== updatedState.ghostPiece.type) {
          // 고스트 조각을 현재 조각과 동일한 타입으로 수정
          updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
            updatedState.currentPiece,
            updatedState.board,
          );
          needsUpdate = true;

          this.logger.log(`고스트 조각 타입 수정: ${playerId}`, {
            playerId,
            originalGhostType: playerState.ghostPiece?.type,
            newGhostType: updatedState.ghostPiece.type,
            currentPieceType: updatedState.currentPiece.type,
          });
        }
      }

      // 2. 현재 조각이 없는데 고스트 조각이 있는 경우 수정
      if (!updatedState.currentPiece && updatedState.ghostPiece) {
        updatedState.ghostPiece = null;
        needsUpdate = true;

        this.logger.log(`고스트 조각 제거 (현재 조각 없음): ${playerId}`, {
          playerId,
        });
      }

      // 3. 현재 조각이 있는데 고스트 조각이 없는 경우 생성
      if (
        updatedState.currentPiece &&
        !updatedState.ghostPiece &&
        !updatedState.gameOver
      ) {
        updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
          updatedState.currentPiece,
          updatedState.board,
        );
        needsUpdate = true;

        this.logger.log(`고스트 조각 생성: ${playerId}`, {
          playerId,
          currentPieceType: updatedState.currentPiece.type,
          ghostPieceType: updatedState.ghostPiece.type,
        });
      }

      // 4. 보드 상태와 현재 조각 위치 불일치 수정
      if (updatedState.currentPiece && !updatedState.gameOver) {
        const isValidPosition = this.tetrisLogic.isValidPositionForServer(
          updatedState.currentPiece,
          updatedState.board,
        );

        if (!isValidPosition) {
          // 현재 조각을 유효한 위치로 이동
          const validPosition = this.findValidPosition(
            updatedState.currentPiece,
            updatedState.board,
          );

          if (validPosition) {
            updatedState.currentPiece = validPosition;
            updatedState.ghostPiece = this.tetrisLogic.getGhostPiece(
              validPosition,
              updatedState.board,
            );
            needsUpdate = true;

            this.logger.log(`현재 조각 위치 수정: ${playerId}`, {
              playerId,
              originalPosition: playerState.currentPiece?.position,
              newPosition: validPosition.position,
            });
          } else {
            // 유효한 위치를 찾을 수 없으면 조각 제거 (게임 오버 상태로)
            updatedState.currentPiece = null;
            updatedState.ghostPiece = null;
            updatedState.gameOver = true;
            needsUpdate = true;

            this.logger.log(
              `유효한 위치를 찾을 수 없어 게임 오버로 설정: ${playerId}`,
              {
                playerId,
              },
            );
          }
        }
      }

      // 5. 다음 조각이 없으면 생성
      if (!updatedState.nextPiece && !updatedState.gameOver) {
        updatedState.nextPiece = this.tetrisLogic.getNextTetrominoFromBag();
        needsUpdate = true;

        this.logger.log(`다음 조각 생성: ${playerId}`, {
          playerId,
          nextPiece: updatedState.nextPiece,
        });
      }

      // 6. 7-bag 시스템 상태 복구
      if (
        !updatedState.tetrominoBag ||
        updatedState.tetrominoBag.length === 0 ||
        updatedState.bagIndex >= updatedState.tetrominoBag.length
      ) {
        // 가방 번호 증가
        updatedState.bagNumber = (updatedState.bagNumber || 0) + 1;

        // 시드에 가방 번호를 추가하여 각 가방마다 다른 순서 생성
        const bagSeed = updatedState.gameSeed + updatedState.bagNumber;

        // 시드 기반으로 새로운 가방 생성
        updatedState.tetrominoBag = this.generateNewBagWithSeed(bagSeed);
        updatedState.bagIndex = 0;
        needsUpdate = true;

        this.logger.log(`7-bag 시스템 복구: ${playerId}`, {
          playerId,
          bagIndex: updatedState.bagIndex,
          bagLength: updatedState.tetrominoBag.length,
          bagNumber: updatedState.bagNumber,
          bagSeed,
        });
      }

      // 7. 게임 오버 상태 재확인
      if (updatedState.currentPiece) {
        const isGameOver = this.tetrisLogic.isGameOverForServer(
          updatedState.board,
        );
        if (isGameOver !== updatedState.gameOver) {
          updatedState.gameOver = isGameOver;
          needsUpdate = true;

          this.logger.log(`게임 오버 상태 수정: ${playerId}`, {
            playerId,
            gameOver: updatedState.gameOver,
          });
        }
      }

      // 8. 게임 오버 상태에서 조각 정리
      if (updatedState.gameOver && updatedState.currentPiece) {
        updatedState.currentPiece = null;
        updatedState.ghostPiece = null;
        updatedState.nextPiece = null;
        needsUpdate = true;

        this.logger.log(`게임 오버 상태에서 조각 정리: ${playerId}`, {
          playerId,
        });
      }

      // 상태 업데이트가 필요한 경우에만 저장
      if (needsUpdate) {
        updatedState.lastActivity = new Date();
        await this.updatePlayerGameState(playerId, updatedState);
        await this.publishGameStateUpdate(playerId, updatedState);

        this.logger.log(`게임 상태 동기화 수정 완료: ${playerId}`, {
          playerId,
          currentPiece: updatedState.currentPiece?.type,
          ghostPiece: updatedState.ghostPiece?.type,
          nextPiece: updatedState.nextPiece,
          gameOver: updatedState.gameOver,
        });
      }

      return updatedState;
    } catch (error) {
      this.logger.log(`게임 상태 동기화 수정 실패: ${error.message}`, {
        error,
        playerId,
      });
      return null;
    }
  }

  /**
   * 게임 오버 상태 강제 수정
   */
  async forceGameOverState(playerId: string): Promise<PlayerGameState | null> {
    try {
      const playerState = await this.getPlayerGameState(playerId);
      if (!playerState) {
        return null;
      }

      this.logger.log(`게임 오버 상태 강제 수정: ${playerId}`, {
        playerId,
        currentGameOver: playerState.gameOver,
        hasCurrentPiece: !!playerState.currentPiece,
      });

      const updatedState = {
        ...playerState,
        gameOver: true,
        currentPiece: null,
        ghostPiece: null,
        nextPiece: null,
        lastActivity: new Date(),
      };

      await this.updatePlayerGameState(playerId, updatedState);
      await this.publishGameStateUpdate(playerId, updatedState);

      this.logger.log(`게임 오버 상태 강제 수정 완료: ${playerId}`, {
        playerId,
        gameOver: updatedState.gameOver,
      });

      return updatedState;
    } catch (error) {
      this.logger.log(`게임 오버 상태 강제 수정 실패: ${error.message}`, {
        error,
        playerId,
      });
      return null;
    }
  }

  /**
   * 유효한 위치 찾기
   */
  private findValidPosition(piece: any, board: number[][]): any | null {
    // 스폰 위치부터 시작하여 유효한 위치 찾기
    const spawnPositions = [
      { x: 3, y: 0 }, // 기본 스폰 위치
      { x: 2, y: 0 }, // 왼쪽으로 1칸
      { x: 4, y: 0 }, // 오른쪽으로 1칸
      { x: 3, y: 1 }, // 아래로 1칸
      { x: 2, y: 1 }, // 왼쪽으로 1칸, 아래로 1칸
      { x: 4, y: 1 }, // 오른쪽으로 1칸, 아래로 1칸
    ];

    for (const pos of spawnPositions) {
      const testPiece = {
        ...piece,
        position: pos,
      };

      if (this.tetrisLogic.isValidPositionForServer(testPiece, board)) {
        return testPiece;
      }
    }

    return null;
  }

  // 레벨에 따른 드롭 간격 계산
  private calculateDropInterval(level: number): number {
    // 표준 테트리스 속도 공식: (0.8 - ((level - 1) * 0.007))^(level - 1) * 1000
    // 최소 50ms, 최대 1000ms
    if (level <= 0) return 1000;
    if (level >= 29) return 50;

    const baseInterval = Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
    return Math.max(50, Math.min(1000, baseInterval));
  }

  // 레벨에 따른 타이머 재시작 (최적화됨)
  private restartGameTimerWithLevel(playerId: string, level: number): void {
    this.stopGameTimer(playerId);

    const dropInterval = this.calculateDropInterval(level);

    const timer = setInterval(async () => {
      try {
        const playerState = await this.getPlayerGameState(playerId);
        if (!playerState || playerState.gameOver) {
          this.stopGameTimer(playerId);
          return;
        }

        // 자동으로 블록 떨어뜨리기
        await this.autoDropPiece(playerId);
      } catch (error) {
        this.logger.logError(error);
        this.stopGameTimer(playerId);
      }
    }, dropInterval);

    this.gameTimers.set(playerId, timer);

    // 개발 환경에서만 로그 출력
    if (process.env.NODE_ENV === 'development') {
      console.log(
        `Timer restarted for player ${playerId} with level ${level}, interval: ${dropInterval}ms`,
      );
    }
  }

  // 서비스 정리 메서드 (애플리케이션 종료 시 호출)
  async cleanup(): Promise<void> {
    try {
      // 모든 타이머 정리
      this.cleanupTimers();

      // 캐시 정리
      this.gameStateCache.clear();

      this.logger.log('GameService 정리 완료');
    } catch (error) {
      this.logger.logError(error);
    }
  }

  // 룸 기반 게임 시작 (새로운 플로우용)
  async startRoomGame(roomId: string): Promise<void> {
    try {
      const room = await this.getRoom(roomId);
      if (!room) {
        throw new Error('룸을 찾을 수 없습니다.');
      }

      // 룸의 모든 플레이어 가져오기
      const players = await this.getRoomPlayers(roomId, true);
      if (players.length < 1) {
        throw new Error('게임을 시작할 플레이어가 없습니다.');
      }

      // 룸 상태를 PLAYING으로 업데이트
      await this.updateRoomStatus(roomId, 'PLAYING');

      // 각 플레이어의 게임 상태 초기화 및 시작
      for (const player of players) {
        this.logger.log(`플레이어 게임 시작: ${player.id}`, {
          playerId: player.id,
          playerName: player.name,
        });
        await this.startPlayerGame(player.id, roomId);
      }

      this.logger.log(`룸 게임 시작: ${roomId}`, {
        roomId,
        playerCount: players.length,
      });
    } catch (error) {
      this.logger.log(`룸 게임 시작 실패: ${error.message}`, { error, roomId });
      throw error;
    }
  }
}

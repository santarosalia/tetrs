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
}

@Injectable()
export class GameService {
  private readonly MAX_PLAYERS_PER_ROOM = 99;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly logger: LoggerService,
    private readonly tetrisMapService: TetrisMapService,
    private readonly tetrisLogic: TetrisLogicService,
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

      // 4. 개인 게임 상태 초기화
      await this.initializePlayerGameState(player.id, availableRoom.id);

      // 5. 룸 상태 업데이트
      await this.updateRoomActivity(availableRoom.id);

      // 6. 개인 게임 자동 시작
      await this.startPlayerGame(player.id, availableRoom.id);

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
   * 플레이어 개인 게임 상태 초기화
   */
  private async initializePlayerGameState(
    playerId: string,
    roomId: string,
  ): Promise<void> {
    // 7-bag 시스템 초기화
    this.tetrisLogic.initializeTetrominoBag();

    const gameState: PlayerGameState = {
      playerId,
      roomId,
      gameStarted: false,
      score: 0,
      level: 1,
      linesCleared: 0,
      currentPiece: null,
      nextPiece: this.tetrisLogic.getNextTetrominoFromBag(),
      heldPiece: null,
      canHold: true,
      ghostPiece: null,
      board: this.tetrisLogic.createEmptyBoard(),
      gameOver: false,
      paused: false,
      isGameStarted: false,
      startTime: new Date(),
      lastActivity: new Date(),
      tetrominoBag: this.tetrisLogic['tetrominoBag'],
      bagIndex: this.tetrisLogic['bagIndex'],
    };

    await this.redisService.set(
      `player_game:${playerId}`,
      JSON.stringify(gameState),
    );
  }

  /**
   * 플레이어 개인 게임 시작
   */
  private async startPlayerGame(
    playerId: string,
    roomId: string,
  ): Promise<void> {
    try {
      const gameState = await this.getPlayerGameState(playerId);
      if (!gameState) {
        throw new Error('플레이어 게임 상태를 찾을 수 없습니다');
      }

      gameState.gameStarted = true;
      gameState.isGameStarted = true;
      gameState.startTime = new Date();
      gameState.lastActivity = new Date();

      // 첫 번째 피스 생성
      gameState.currentPiece = this.tetrisLogic.createTetromino(
        gameState.nextPiece,
      );
      gameState.nextPiece = this.tetrisLogic.getNextTetrominoFromBag();
      gameState.ghostPiece = this.tetrisLogic.getGhostPiece(
        gameState.currentPiece,
        gameState.board,
      );

      await this.redisService.set(
        `player_game:${playerId}`,
        JSON.stringify(gameState),
      );

      this.logger.log(`플레이어 ${playerId}의 개인 게임 시작`, {
        playerId,
        roomId,
      });
    } catch (error) {
      this.logger.log(`플레이어 게임 시작 실패: ${error.message}`, {
        error,
        playerId,
        roomId,
      });
    }
  }

  /**
   * 플레이어 게임 상태 가져오기
   */
  async getPlayerGameState(playerId: string): Promise<PlayerGameState | null> {
    try {
      const gameStateData = await this.redisService.get(
        `player_game:${playerId}`,
      );
      return gameStateData ? JSON.parse(gameStateData) : null;
    } catch (error) {
      this.logger.log(`플레이어 게임 상태 조회 실패: ${error.message}`, {
        error,
        playerId,
      });
      return null;
    }
  }

  /**
   * 플레이어 게임 상태 업데이트
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

      await this.redisService.set(
        `player_game:${playerId}`,
        JSON.stringify(updatedState),
      );
    } catch (error) {
      this.logger.log(`플레이어 게임 상태 업데이트 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
  }

  /**
   * 플레이어 입력 처리 (고급 테트리스 로직)
   */
  async handlePlayerInput(
    playerId: string,
    input: {
      action: string;
      currentPiece?: TetrisBlock;
      board?: number[][];
      score?: number;
      level?: number;
      linesCleared?: number;
    },
  ): Promise<PlayerGameState | null> {
    try {
      const gameState = await this.getPlayerGameState(playerId);
      if (!gameState || !gameState.gameStarted) {
        throw new Error('게임이 시작되지 않았습니다');
      }

      // 클라이언트에서 전송한 데이터로 게임 상태 업데이트
      const updates: Partial<PlayerGameState> = {
        lastActivity: new Date(),
      };

      // 클라이언트에서 전송한 게임 상태 데이터가 있으면 우선 적용
      if (input.board) {
        updates.board = input.board;
      }
      if (input.currentPiece) {
        updates.currentPiece = input.currentPiece;
      }
      if (input.score !== undefined) {
        updates.score = input.score;
      }
      if (input.level !== undefined) {
        updates.level = input.level;
      }
      if (input.linesCleared !== undefined) {
        updates.linesCleared = input.linesCleared;
      }

      if (input.action === 'move_left') {
        const movedPiece = this.tetrisLogic.moveTetromino(
          gameState.currentPiece!,
          gameState.board,
          -1,
          0,
        );
        if (movedPiece) {
          updates.currentPiece = movedPiece;
          updates.ghostPiece = this.tetrisLogic.getGhostPiece(
            movedPiece,
            gameState.board,
          );
        }
      } else if (input.action === 'move_right') {
        const movedPiece = this.tetrisLogic.moveTetromino(
          gameState.currentPiece!,
          gameState.board,
          1,
          0,
        );
        if (movedPiece) {
          updates.currentPiece = movedPiece;
          updates.ghostPiece = this.tetrisLogic.getGhostPiece(
            movedPiece,
            gameState.board,
          );
        }
      } else if (input.action === 'move_down') {
        const movedPiece = this.tetrisLogic.moveTetromino(
          gameState.currentPiece!,
          gameState.board,
          0,
          1,
        );
        if (movedPiece) {
          updates.currentPiece = movedPiece;
          updates.ghostPiece = this.tetrisLogic.getGhostPiece(
            movedPiece,
            gameState.board,
          );
          updates.score = gameState.score + 1; // 소프트 드롭 점수
        } else {
          // 피스가 바닥에 닿았을 때
          const { newBoard, linesCleared, score } =
            this.tetrisLogic.clearLinesAndCalculateScore(
              this.tetrisLogic.placeTetromino(
                gameState.currentPiece!,
                gameState.board,
              ),
              gameState.level,
            );

          updates.board = newBoard;
          updates.linesCleared = gameState.linesCleared + linesCleared;
          updates.score = gameState.score + score;
          updates.level = this.tetrisLogic.calculateLevel(updates.linesCleared);

          // 새로운 피스 생성
          updates.currentPiece = this.tetrisLogic.createTetromino(
            gameState.nextPiece,
          );
          updates.nextPiece = this.tetrisLogic.getNextTetrominoFromBag();
          updates.canHold = true;

          // 게임 오버 체크
          if (this.tetrisLogic.isGameOver(updates.board)) {
            updates.gameOver = true;
            this.logger.log(`게임 오버: ${playerId}`, {
              playerId,
              finalScore: updates.score,
              finalLevel: updates.level,
              finalLines: updates.linesCleared,
            });

            // 게임 오버 처리
            await this.handleGameOver(playerId);
          }
        }
      } else if (input.action === 'rotate') {
        const rotatedPiece = this.tetrisLogic.rotateTetrominoWithWallKick(
          gameState.currentPiece!,
          gameState.board,
        );
        if (rotatedPiece) {
          updates.currentPiece = rotatedPiece;
          updates.ghostPiece = this.tetrisLogic.getGhostPiece(
            rotatedPiece,
            gameState.board,
          );
        }
      } else if (input.action === 'hard_drop') {
        const { droppedPiece, dropDistance } = this.tetrisLogic.hardDrop(
          gameState.currentPiece!,
          gameState.board,
        );

        const { newBoard, linesCleared, score } =
          this.tetrisLogic.clearLinesAndCalculateScore(
            this.tetrisLogic.placeTetromino(droppedPiece, gameState.board),
            gameState.level,
          );

        const hardDropBonus = this.tetrisLogic.calculateHardDropBonus(
          gameState.level,
          dropDistance,
        );

        updates.board = newBoard;
        updates.linesCleared = gameState.linesCleared + linesCleared;
        updates.score = gameState.score + score + hardDropBonus;
        updates.level = this.tetrisLogic.calculateLevel(updates.linesCleared);

        // 새로운 피스 생성
        updates.currentPiece = this.tetrisLogic.createTetromino(
          gameState.nextPiece,
        );
        updates.nextPiece = this.tetrisLogic.getNextTetrominoFromBag();
        updates.canHold = true;

        // 게임 오버 체크
        if (this.tetrisLogic.isGameOver(updates.board)) {
          updates.gameOver = true;
          this.logger.log(`게임 오버 (하드 드롭): ${playerId}`, {
            playerId,
            finalScore: updates.score,
            finalLevel: updates.level,
            finalLines: updates.linesCleared,
          });

          // 게임 오버 처리
          await this.handleGameOver(playerId);
        }
      } else if (input.action === 'hold') {
        if (gameState.canHold) {
          const tempHeld = gameState.heldPiece;
          updates.heldPiece = gameState.currentPiece!.type;
          updates.currentPiece = tempHeld
            ? this.tetrisLogic.createTetromino(tempHeld)
            : this.tetrisLogic.createTetromino(gameState.nextPiece);
          updates.nextPiece = tempHeld
            ? gameState.nextPiece
            : this.tetrisLogic.getNextTetrominoFromBag();
          updates.canHold = false;
          updates.ghostPiece = this.tetrisLogic.getGhostPiece(
            updates.currentPiece!,
            updates.board || gameState.board,
          );
        }
      }

      // 게임 상태 업데이트
      await this.updatePlayerGameState(playerId, updates);

      // 업데이트된 게임 상태 반환
      const updatedState = await this.getPlayerGameState(playerId);

      // 게임 상태 변경 이벤트 발행
      await this.publishGameStateUpdate(playerId, updatedState);

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

  /**
   * 게임 상태 업데이트 이벤트 발행
   */
  private async publishGameStateUpdate(
    playerId: string,
    gameState: PlayerGameState,
  ): Promise<void> {
    try {
      await this.redisService.publish(`game_state_update:${playerId}`, {
        type: 'game_state_update',
        playerId,
        gameState,
        timestamp: Date.now(),
      });

      this.logger.log(`게임 상태 업데이트 이벤트 발행: ${playerId}`, {
        playerId,
        score: gameState.score,
      });
    } catch (error) {
      this.logger.log(`게임 상태 업데이트 이벤트 발행 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
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

      const room = {
        id: roomId,
        status: 'WAITING',
        maxPlayers: this.MAX_PLAYERS_PER_ROOM,
        currentPlayers: 0,
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      // Redis에 룸 정보 저장
      await this.redisService.set(`room:${roomId}`, JSON.stringify(room));

      // 룸 목록에 추가
      await this.redisService.sadd('active_rooms', roomId);

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
      const room = await this.getRoom(roomId);
      if (!room || room.status !== 'WAITING') {
        return;
      }

      // 룸 상태를 PLAYING으로 업데이트
      await this.updateRoomStatus(roomId, 'PLAYING');

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
      return roomData ? JSON.parse(roomData) : null;
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

  /**
   * 룸 통계 정보
   */
  async getRoomStats(): Promise<{
    totalRooms: number;
    waitingRooms: number;
    playingRooms: number;
    totalPlayers: number;
  }> {
    try {
      const rooms = await this.getAllRooms();

      const stats = {
        totalRooms: rooms.length,
        waitingRooms: rooms.filter((r) => r.status === 'WAITING').length,
        playingRooms: rooms.filter((r) => r.status === 'PLAYING').length,
        totalPlayers: rooms.reduce((sum, room) => sum + room.currentPlayers, 0),
      };

      return stats;
    } catch (error) {
      this.logger.log(`룸 통계 조회 실패: ${error.message}`, { error });
      return {
        totalRooms: 0,
        waitingRooms: 0,
        playingRooms: 0,
        totalPlayers: 0,
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
      const gameState = await this.getPlayerGameState(playerId);
      if (!gameState) return;

      // 게임 오버 상태로 업데이트
      await this.updatePlayerGameState(playerId, {
        gameOver: true,
        lastActivity: new Date(),
      });

      // 게임 오버 이벤트 발행
      await this.publishGameEvent(gameState.roomId, 'GAME_OVER', {
        playerId,
        finalScore: gameState.score,
        finalLevel: gameState.level,
        finalLines: gameState.linesCleared,
        timestamp: new Date().toISOString(),
      });

      // 플레이어 게임 오버 이벤트 발행
      await this.publishGameEvent(gameState.roomId, 'PLAYER_GAME_OVER', {
        playerId,
        finalScore: gameState.score,
        finalLevel: gameState.level,
        finalLines: gameState.linesCleared,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`게임 오버 처리 완료: ${playerId}`, {
        playerId,
        finalScore: gameState.score,
        finalLevel: gameState.level,
        finalLines: gameState.linesCleared,
      });
    } catch (error) {
      this.logger.log(`게임 오버 처리 실패: ${error.message}`, {
        error,
        playerId,
      });
    }
  }
}

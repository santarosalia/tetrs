import { Injectable, Logger } from '@nestjs/common';
import { LogContext } from '../interfaces/log-context.interface';

@Injectable()
export class LoggerService {
  private readonly logger = new Logger(LoggerService.name);

  log(message: string, context?: LogContext) {
    this.logger.log(this.formatMessage(message, context));
  }

  error(message: string, trace?: string, context?: LogContext) {
    this.logger.error(this.formatMessage(message, context), trace);
  }

  warn(message: string, context?: LogContext) {
    this.logger.warn(this.formatMessage(message, context));
  }

  debug(message: string, context?: LogContext) {
    this.logger.debug(this.formatMessage(message, context));
  }

  verbose(message: string, context?: LogContext) {
    this.logger.verbose(this.formatMessage(message, context));
  }

  // 게임 관련 로그 메서드들
  logGameCreated(gameId: string, maxPlayers: number, context?: LogContext) {
    this.log(`Game created: ${gameId} (maxPlayers: ${maxPlayers})`, {
      ...context,
      gameId,
      action: 'GAME_CREATED',
    });
  }

  logGameJoined(
    gameId: string,
    playerId: string,
    playerName: string,
    context?: LogContext,
  ) {
    this.log(`Player joined game: ${playerName} (${playerId}) -> ${gameId}`, {
      ...context,
      gameId,
      playerId,
      action: 'GAME_JOINED',
    });
  }

  logGameStarted(gameId: string, playerCount: number, context?: LogContext) {
    this.log(`Game started: ${gameId} (players: ${playerCount})`, {
      ...context,
      gameId,
      action: 'GAME_STARTED',
    });
  }

  logGameFinished(gameId: string, winnerId?: string, context?: LogContext) {
    this.log(
      `Game finished: ${gameId} ${winnerId ? `(winner: ${winnerId})` : '(no winner)'}`,
      {
        ...context,
        gameId,
        action: 'GAME_FINISHED',
      },
    );
  }

  logPlayerEliminated(
    gameId: string,
    playerId: string,
    playerName: string,
    context?: LogContext,
  ) {
    this.log(`Player eliminated: ${playerName} (${playerId}) from ${gameId}`, {
      ...context,
      gameId,
      playerId,
      action: 'PLAYER_ELIMINATED',
    });
  }

  logPlayerLeft(
    gameId: string,
    playerId: string,
    playerName: string,
    context?: LogContext,
  ) {
    this.log(`Player left: ${playerName} (${playerId}) from ${gameId}`, {
      ...context,
      gameId,
      playerId,
      action: 'PLAYER_LEFT',
    });
  }

  logStatsUpdated(
    playerId: string,
    gameId: string,
    stats: any,
    context?: LogContext,
  ) {
    this.log(`Stats updated: ${playerId} in ${gameId}`, {
      ...context,
      gameId,
      playerId,
      action: 'STATS_UPDATED',
      stats,
    });
  }

  logWebSocketConnection(clientId: string, context?: LogContext) {
    this.log(`WebSocket connected: ${clientId}`, {
      ...context,
      action: 'WS_CONNECTED',
    });
  }

  logWebSocketDisconnection(clientId: string, context?: LogContext) {
    this.log(`WebSocket disconnected: ${clientId}`, {
      ...context,
      action: 'WS_DISCONNECTED',
    });
  }

  logRedisOperation(operation: string, key: string, context?: LogContext) {
    this.log(`Redis operation: ${operation} on ${key}`, {
      ...context,
      action: 'REDIS_OPERATION',
      redisKey: key,
    });
  }

  logDatabaseOperation(operation: string, table: string, context?: LogContext) {
    this.log(`Database operation: ${operation} on ${table}`, {
      ...context,
      action: 'DB_OPERATION',
      table,
    });
  }

  logError(error: Error, context?: LogContext) {
    this.error(`Error occurred: ${error.message}`, error.stack, context);
  }

  // 치팅 방지 및 입력 검증 로그 메서드들
  logInvalidInput(
    playerId: string,
    action: string,
    reason: string,
    context?: LogContext,
  ) {
    this.warn(
      `Invalid input detected: ${playerId} attempted ${action} - ${reason}`,
      {
        ...context,
        playerId,
        action,
        reason,
      },
    );
  }

  logCheatAttempt(playerId: string, cheatType: string, context?: LogContext) {
    this.error(
      `Cheat attempt detected: ${playerId} - ${cheatType}`,
      undefined,
      {
        ...context,
        playerId,
        cheatType,
      },
    );
  }

  logPlayerInput(
    playerId: string,
    action: string,
    result: string,
    context?: LogContext,
  ) {
    this.log(`Player input processed: ${playerId} - ${action} -> ${result}`, {
      ...context,
      playerId,
      action,
      result,
    });
  }

  logStateSync(playerId: string, syncType: string, context?: LogContext) {
    this.log(`State synchronization: ${playerId} - ${syncType}`, {
      ...context,
      playerId,
      syncType,
      action: 'STATE_SYNC',
    });
  }

  logGameLogic(
    playerId: string,
    operation: string,
    details: any,
    context?: LogContext,
  ) {
    this.log(`Game logic operation: ${playerId} - ${operation}`, {
      ...context,
      playerId,
      operation,
      details,
      action: 'GAME_LOGIC',
    });
  }

  /**
   * 테트리스 로직 디버깅 로그
   */
  logTetrisLogic(playerId: string, action: string) {
    this.logger.log(`[TETRIS_LOGIC] ${playerId} - ${action}`);
  }

  /**
   * 조각 이동 디버깅 로그
   */
  logPieceMovement(playerId: string, action: string) {
    this.logger.log(`[PIECE_MOVEMENT] ${playerId} - ${action}`);
  }

  /**
   * 라인 클리어 디버깅 로그
   */
  logLineClear(
    playerId: string,
    data: {
      linesCleared: number;
      oldScore: number;
      newScore: number;
      oldLevel: number;
      newLevel: number;
      clearedLines?: number[];
    },
  ) {
    this.logger.log(`[LINE_CLEAR] ${playerId}`, {
      playerId,
      linesCleared: data.linesCleared,
      oldScore: data.oldScore,
      newScore: data.newScore,
      scoreIncrease: data.newScore - data.oldScore,
      oldLevel: data.oldLevel,
      newLevel: data.newLevel,
      clearedLines: data.clearedLines,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 게임 오버 디버깅 로그
   */
  logGameOver(
    playerId: string,
    data: {
      finalScore: number;
      finalLevel: number;
      finalLines: number;
      reason: string;
      boardState?: number[][];
    },
  ) {
    this.logger.log(`[GAME_OVER] ${playerId}`, {
      playerId,
      finalScore: data.finalScore,
      finalLevel: data.finalLevel,
      finalLines: data.finalLines,
      reason: data.reason,
      boardHeight: data.boardState?.length || 0,
      boardWidth: data.boardState?.[0]?.length || 0,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 7-bag 시스템 디버깅 로그
   */
  logTetrominoBag(
    playerId: string,
    action: string,
    data: {
      bag: string[];
      bagIndex: number;
      nextPiece?: string;
      newBag?: string[];
      bagLength?: number;
      willRegenerate?: boolean;
    },
  ) {
    this.logger.log(`[TETROMINO_BAG] ${playerId} - ${action}`, {
      playerId,
      action,
      bag: data.bag,
      bagIndex: data.bagIndex,
      nextPiece: data.nextPiece,
      newBag: data.newBag,
      timestamp: new Date().toISOString(),
    });
  }

  private formatMessage(message: string, context?: LogContext): string {
    if (!context) return message;

    const contextStr = Object.entries(context)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    return contextStr ? `${message} | ${contextStr}` : message;
  }
}

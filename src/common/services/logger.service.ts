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
    this.error(`Error occurred: ${error.message}`, error.stack, {
      ...context,
      action: 'ERROR',
      errorName: error.name,
    });
  }

  private formatMessage(message: string, context?: LogContext): string {
    if (!context) return message;

    const contextStr = Object.entries(context)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    return contextStr ? `${message} | ${contextStr}` : message;
  }
}

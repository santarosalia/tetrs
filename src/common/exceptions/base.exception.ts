import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorResponse } from '../interfaces/shared.interface';

export abstract class BaseGameException extends HttpException {
  constructor(
    message: string,
    status: HttpStatus,
    public readonly code: string,
    public readonly details?: any,
  ) {
    super(
      {
        code,
        message,
        details,
      } as ErrorResponse,
      status,
    );
  }
}

export class ValidationException extends BaseGameException {
  constructor(message: string, details?: any) {
    super(message, HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', details);
  }
}

export class GameNotFoundException extends BaseGameException {
  constructor(gameId: string) {
    super(
      `Game with ID ${gameId} not found`,
      HttpStatus.NOT_FOUND,
      'GAME_NOT_FOUND',
      { gameId },
    );
  }
}

export class GameNotAcceptingPlayersException extends BaseGameException {
  constructor(gameId: string) {
    super(
      `Game ${gameId} is not accepting players`,
      HttpStatus.BAD_REQUEST,
      'GAME_NOT_ACCEPTING_PLAYERS',
      { gameId },
    );
  }
}

export class GameFullException extends BaseGameException {
  constructor(gameId: string) {
    super(`Game ${gameId} is full`, HttpStatus.CONFLICT, 'GAME_FULL', {
      gameId,
    });
  }
}

export class GameCannotStartException extends BaseGameException {
  constructor(reason: string) {
    super(
      `Game cannot be started: ${reason}`,
      HttpStatus.BAD_REQUEST,
      'GAME_CANNOT_START',
      { reason },
    );
  }
}

export class PlayerNotFoundException extends BaseGameException {
  constructor(playerId: string) {
    super(
      `Player with ID ${playerId} not found`,
      HttpStatus.NOT_FOUND,
      'PLAYER_NOT_FOUND',
      { playerId },
    );
  }
}

export class PlayerAlreadyInGameException extends BaseGameException {
  constructor(playerId: string) {
    super(
      `Player ${playerId} is already in a game`,
      HttpStatus.CONFLICT,
      'PLAYER_ALREADY_IN_GAME',
      { playerId },
    );
  }
}

export class InvalidGameStateException extends BaseGameException {
  constructor(currentState: string, expectedState: string) {
    super(
      `Invalid game state. Expected: ${expectedState}, Got: ${currentState}`,
      HttpStatus.BAD_REQUEST,
      'INVALID_GAME_STATE',
      { currentState, expectedState },
    );
  }
}

export class NetworkException extends BaseGameException {
  constructor(message: string, details?: any) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR, 'NETWORK_ERROR', details);
  }
}

export class TetrisLogicException extends BaseGameException {
  constructor(message: string, details?: any) {
    super(message, HttpStatus.BAD_REQUEST, 'TETRIS_LOGIC_ERROR', details);
  }
}

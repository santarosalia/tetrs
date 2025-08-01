import { HttpException, HttpStatus } from '@nestjs/common';

export class GameNotFoundException extends HttpException {
  constructor(gameId: string) {
    super(`Game with ID ${gameId} not found`, HttpStatus.NOT_FOUND);
  }
}

export class GameNotAcceptingPlayersException extends HttpException {
  constructor(gameId: string) {
    super(`Game ${gameId} is not accepting players`, HttpStatus.BAD_REQUEST);
  }
}

export class GameFullException extends HttpException {
  constructor(gameId: string) {
    super(`Game ${gameId} is full`, HttpStatus.CONFLICT);
  }
}

export class GameCannotStartException extends HttpException {
  constructor(reason: string) {
    super(`Game cannot be started: ${reason}`, HttpStatus.BAD_REQUEST);
  }
}

export class PlayerNotFoundException extends HttpException {
  constructor(playerId: string) {
    super(`Player with ID ${playerId} not found`, HttpStatus.NOT_FOUND);
  }
}

export class PlayerAlreadyInGameException extends HttpException {
  constructor(playerId: string) {
    super(`Player ${playerId} is already in a game`, HttpStatus.CONFLICT);
  }
}

export class InvalidGameStateException extends HttpException {
  constructor(currentState: string, expectedState: string) {
    super(
      `Invalid game state. Expected: ${expectedState}, Got: ${currentState}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

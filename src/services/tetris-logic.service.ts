import { Injectable } from '@nestjs/common';
import { TetrisCoreService } from '../common/services/tetris-core.service';
import { TetrisBlock } from '../common/interfaces/tetris-map.interface';
import { TetrominoType } from '../common/interfaces/shared.interface';
import { TetrisLogicException } from '../common/exceptions/base.exception';

@Injectable()
export class TetrisLogicService extends TetrisCoreService {
  // 서버 전용 메서드들

  createTetrisBlock(type: TetrominoType): TetrisBlock {
    const tetromino = this.createTetromino(type);
    return {
      ...tetromino,
      falling: true,
      lockDelay: 0,
      dropTime: 0,
    };
  }

  // 서버 전용 회전 로직 (추가 상태 포함)
  rotateTetrisBlockWithWallKick(
    tetrisBlock: TetrisBlock,
    board: number[][],
  ): TetrisBlock | null {
    const rotatedTetromino = this.rotateTetrominoWithWallKick(
      tetrisBlock,
      board,
    );

    if (!rotatedTetromino) {
      return null;
    }

    return {
      ...rotatedTetromino,
      falling: tetrisBlock.falling,
      lockDelay: tetrisBlock.lockDelay,
      dropTime: tetrisBlock.dropTime,
    };
  }

  // 서버 전용 이동 로직
  moveTetrisBlock(
    tetrisBlock: TetrisBlock,
    board: number[][],
    offsetX: number,
    offsetY: number,
  ): TetrisBlock | null {
    const movedTetromino = this.moveTetromino(
      tetrisBlock,
      board,
      offsetX,
      offsetY,
    );

    if (!movedTetromino) {
      return null;
    }

    return {
      ...movedTetromino,
      falling: tetrisBlock.falling,
      lockDelay: tetrisBlock.lockDelay,
      dropTime: tetrisBlock.dropTime,
    };
  }

  // 서버 전용 하드 드롭 로직
  hardDropTetrisBlock(
    currentPiece: TetrisBlock,
    board: number[][],
  ): { droppedPiece: TetrisBlock; dropDistance: number } {
    const { droppedPiece, dropDistance } = this.hardDrop(currentPiece, board);

    return {
      droppedPiece: {
        ...droppedPiece,
        falling: false,
        lockDelay: 0,
        dropTime: 0,
      },
      dropDistance,
    };
  }

  // 서버 전용 라인 클리어 및 점수 계산
  clearLinesAndCalculateScoreForServer(
    board: number[][],
    level: number,
  ): { newBoard: number[][]; linesCleared: number; score: number } {
    try {
      return this.clearLinesAndCalculateScore(board, level);
    } catch (error) {
      throw new TetrisLogicException(
        'Failed to clear lines and calculate score',
        {
          board,
          level,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // 서버 전용 게임 오버 체크
  isGameOverForServer(board: number[][]): boolean {
    try {
      return this.isGameOver(board);
    } catch (error) {
      throw new TetrisLogicException('Failed to check game over', {
        board,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 서버 전용 피스 배치
  placeTetrisBlock(tetrisBlock: TetrisBlock, board: number[][]): number[][] {
    try {
      return this.placeTetromino(tetrisBlock, board);
    } catch (error) {
      throw new TetrisLogicException('Failed to place tetris block', {
        tetrisBlock,
        board,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

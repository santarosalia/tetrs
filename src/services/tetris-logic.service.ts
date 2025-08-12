import { Injectable } from '@nestjs/common';
import { TetrisCoreService } from '../common/services/tetris-core.service';
import { TetrisBlock } from '../common/interfaces/tetris-map.interface';
import { TetrisLogicException } from '../common/exceptions/base.exception';

@Injectable()
export class TetrisLogicService extends TetrisCoreService {
  // 서버 전용 메서드들

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

  // 하드 드롭 로직
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

  // 피스 배치
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

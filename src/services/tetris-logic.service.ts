import { Injectable } from '@nestjs/common';
import {
  TetrisBlock,
  TetrominoType,
} from '../common/interfaces/tetris-map.interface';
import {
  TETROMINO_SHAPES,
  TETROMINO_SPAWN_POSITIONS,
  BOARD_WIDTH,
  BOARD_HEIGHT,
} from '../common/constants/tetrominos';

@Injectable()
export class TetrisLogicService {
  // 7-bag 시스템을 위한 전역 변수
  private tetrominoBag: TetrominoType[] = [];
  private bagIndex = 0;

  // 외부에서 접근 가능하도록 public으로 설정
  public readonly TETROMINO_SHAPES = TETROMINO_SHAPES;

  // 7-bag 시스템 초기화
  initializeTetrominoBag(): void {
    const types: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    this.tetrominoBag = [...types];
    // 가방을 랜덤하게 섞기
    for (let i = this.tetrominoBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tetrominoBag[i], this.tetrominoBag[j]] = [
        this.tetrominoBag[j],
        this.tetrominoBag[i],
      ];
    }
    this.bagIndex = 0;
  }

  // 7-bag 시스템에서 다음 테트로미노 가져오기
  getNextTetrominoFromBag(): TetrominoType {
    // 가방이 비어있거나 모든 테트로미노를 사용했으면 새로운 가방 생성
    if (this.bagIndex >= this.tetrominoBag.length) {
      const types: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
      this.tetrominoBag = [...types];
      // 새로운 가방을 랜덤하게 섞기
      for (let i = this.tetrominoBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.tetrominoBag[i], this.tetrominoBag[j]] = [
          this.tetrominoBag[j],
          this.tetrominoBag[i],
        ];
      }
      this.bagIndex = 0;
    }

    // 현재 인덱스의 테트로미노를 가져오고 인덱스 증가
    const tetromino = this.tetrominoBag[this.bagIndex];
    this.bagIndex++;

    return tetromino;
  }

  createEmptyBoard(): number[][] {
    return Array(BOARD_HEIGHT)
      .fill(null)
      .map(() => Array(BOARD_WIDTH).fill(0));
  }

  createTetromino(type: TetrominoType): TetrisBlock {
    const spawnPos = TETROMINO_SPAWN_POSITIONS[type];
    return {
      type,
      position: { x: spawnPos.x, y: spawnPos.y },
      rotation: 0,
      shape: TETROMINO_SHAPES[type][0],
    };
  }

  getRandomTetrominoType(): TetrominoType {
    return this.getNextTetrominoFromBag();
  }

  rotateTetromino(tetromino: TetrisBlock): TetrisBlock {
    const newRotation = (tetromino.rotation + 1) % 4;
    return {
      ...tetromino,
      rotation: newRotation,
      shape: TETROMINO_SHAPES[tetromino.type][newRotation],
    };
  }

  rotateTetrominoWithWallKick(
    tetromino: TetrisBlock,
    board: number[][],
  ): TetrisBlock | null {
    const rotatedPiece = this.rotateTetromino(tetromino);

    // 기본 회전이 가능한지 확인
    if (this.isValidPosition(rotatedPiece, board)) {
      return rotatedPiece;
    }

    // 벽킥 시도 (좌우 이동)
    const wallKickOffsets = [
      { x: -1, y: 0 }, // 왼쪽으로 1칸
      { x: 1, y: 0 }, // 오른쪽으로 1칸
      { x: -2, y: 0 }, // 왼쪽으로 2칸
      { x: 2, y: 0 }, // 오른쪽으로 2칸
      { x: -1, y: -1 }, // 왼쪽으로 1칸, 위로 1칸
      { x: 1, y: -1 }, // 오른쪽으로 1칸, 위로 1칸
      { x: 0, y: -1 }, // 위로 1칸
      { x: -1, y: 1 }, // 왼쪽으로 1칸, 아래로 1칸
      { x: 1, y: 1 }, // 오른쪽으로 1칸, 아래로 1칸
    ];

    for (const offset of wallKickOffsets) {
      const kickedPiece = {
        ...rotatedPiece,
        position: {
          x: rotatedPiece.position.x + offset.x,
          y: rotatedPiece.position.y + offset.y,
        },
      };

      if (this.isValidPosition(kickedPiece, board)) {
        return kickedPiece;
      }
    }

    // 벽킥이 실패하면 null 반환
    return null;
  }

  isValidPosition(
    tetromino: TetrisBlock,
    board: number[][],
    offsetX: number = 0,
    offsetY: number = 0,
  ): boolean {
    const { shape, position } = tetromino;
    const newX = position.x + offsetX;
    const newY = position.y + offsetY;

    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x]) {
          const boardX = newX + x;
          const boardY = newY + y;

          if (
            boardX < 0 ||
            boardX >= BOARD_WIDTH ||
            boardY >= BOARD_HEIGHT ||
            (boardY >= 0 && board[boardY][boardX])
          ) {
            return false;
          }
        }
      }
    }
    return true;
  }

  placeTetromino(tetromino: TetrisBlock, board: number[][]): number[][] {
    const newBoard = board.map((row) => [...row]);
    const { shape, position } = tetromino;

    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (shape[y][x]) {
          const boardX = position.x + x;
          const boardY = position.y + y;
          if (boardY >= 0) {
            newBoard[boardY][boardX] = 1;
          }
        }
      }
    }

    return newBoard;
  }

  clearLines(board: number[][]): {
    newBoard: number[][];
    linesCleared: number;
  } {
    const newBoard = board.filter((row) => row.some((cell) => cell === 0));
    const linesCleared = board.length - newBoard.length;

    // Add empty lines at the top
    while (newBoard.length < BOARD_HEIGHT) {
      newBoard.unshift(Array(BOARD_WIDTH).fill(0));
    }

    return { newBoard, linesCleared };
  }

  moveTetromino(
    tetromino: TetrisBlock,
    board: number[][],
    offsetX: number,
    offsetY: number,
  ): TetrisBlock | null {
    if (this.isValidPosition(tetromino, board, offsetX, offsetY)) {
      return {
        ...tetromino,
        position: {
          x: tetromino.position.x + offsetX,
          y: tetromino.position.y + offsetY,
        },
      };
    }
    return null;
  }

  dropTetromino(tetromino: TetrisBlock, board: number[][]): TetrisBlock {
    let droppedTetromino = tetromino;
    while (this.isValidPosition(droppedTetromino, board, 0, 1)) {
      droppedTetromino = {
        ...droppedTetromino,
        position: {
          x: droppedTetromino.position.x,
          y: droppedTetromino.position.y + 1,
        },
      };
    }
    return droppedTetromino;
  }

  calculateScore(linesCleared: number, level: number): number {
    const lineScores = [0, 100, 300, 500, 800];
    const baseScore = lineScores[linesCleared];

    // 레벨을 2단위로 나누어 점수 배율 계산
    // 레벨 0-1: 1배, 레벨 2-3: 1.5배, 레벨 4-5: 2배, 레벨 6-7: 2.5배...
    const levelGroup = Math.floor(level / 2);
    const levelMultiplier = 1 + levelGroup * 0.5;

    return Math.floor(baseScore * levelMultiplier);
  }

  calculateHardDropBonus(level: number, dropDistance: number): number {
    // 하드 드롭 거리에 따른 보너스 점수 (레벨을 2단위로 나누어 계산)
    const baseBonus = dropDistance * 2;
    const levelGroup = Math.floor(level / 2);
    const levelMultiplier = 1 + levelGroup * 0.3;

    return Math.floor(baseBonus * levelMultiplier);
  }

  calculateLevel(lines: number): number {
    return Math.floor(lines / 10);
  }

  isGameOver(board: number[][]): boolean {
    return board[0].some((cell) => cell === 1);
  }

  getGhostPiece(tetromino: TetrisBlock, board: number[][]): TetrisBlock {
    // 현재 피스의 떨어질 위치를 계산
    const ghostPosition = { ...tetromino.position };

    // 아래로 이동할 수 있는 최대 거리를 찾음
    while (
      this.isValidPosition(
        tetromino,
        board,
        0,
        ghostPosition.y - tetromino.position.y + 1,
      )
    ) {
      ghostPosition.y++;
    }

    return {
      ...tetromino,
      position: ghostPosition,
    };
  }

  // 레벨에 따른 드롭 간격 계산
  calculateDropInterval(level: number, distanceToBottom: number = 0): number {
    // 표준 테트리스 속도 공식: (0.8 - ((level - 1) * 0.007))^(level - 1) * 1000
    // 최소 50ms, 최대 1000ms
    if (level <= 0) return 1000;
    if (level >= 29) return 50;

    const baseInterval = Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
    let interval = Math.max(50, Math.min(1000, baseInterval));

    // 바닥까지의 거리가 0이면 인터벌을 늘림 (더 천천히 떨어지도록)
    if (distanceToBottom === 0) {
      interval = Math.min(1000); // 1초로 고정
    }

    return interval;
  }

  // 바닥까지의 거리 계산
  calculateDistanceToBottom(piece: TetrisBlock, board: number[][]): number {
    if (!piece) return 0;

    let distance = 0;

    // 아래로 이동할 수 있는 최대 거리를 찾음
    while (this.isValidPosition(piece, board, 0, distance + 1)) {
      distance++;
    }

    return distance;
  }

  // 라인 클리어 및 점수 계산
  clearLinesAndCalculateScore(
    board: number[][],
    level: number,
  ): { newBoard: number[][]; linesCleared: number; score: number } {
    const { newBoard, linesCleared } = this.clearLines(board);
    const score = this.calculateScore(linesCleared, level);

    return { newBoard, linesCleared, score };
  }

  // 하드 드롭
  hardDrop(
    currentPiece: TetrisBlock,
    board: number[][],
  ): { droppedPiece: TetrisBlock; dropDistance: number } {
    const originalY = currentPiece.position.y;
    const droppedPiece = this.dropTetromino(currentPiece, board);
    const dropDistance = droppedPiece.position.y - originalY;

    return { droppedPiece, dropDistance };
  }
}

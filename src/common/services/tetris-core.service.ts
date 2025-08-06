import { Injectable } from '@nestjs/common';
import {
  TetrominoType,
  Tetromino,
  Position,
} from '../interfaces/shared.interface';
import {
  TETROMINO_SHAPES,
  TETROMINO_SPAWN_POSITIONS,
  SRS_WALL_KICK_DATA,
  BOARD_WIDTH,
  BOARD_HEIGHT,
} from '../constants/tetrominos';

@Injectable()
export class TetrisCoreService {
  // 테트리스 표준 7-bag 시스템을 위한 전역 변수
  private tetrominoBag: TetrominoType[] = [];
  private bagIndex = 0;
  private bagNumber = 1; // 가방 번호 추가

  // 외부에서 접근 가능하도록 public으로 설정
  public readonly TETROMINO_SHAPES = TETROMINO_SHAPES;

  // 테트리스 표준 7-bag 시스템 초기화
  initializeTetrominoBag(): void {
    const types: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    this.tetrominoBag = [...types];
    // 가방을 랜덤하게 섞기 (Fisher-Yates 셔플)
    for (let i = this.tetrominoBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tetrominoBag[i], this.tetrominoBag[j]] = [
        this.tetrominoBag[j],
        this.tetrominoBag[i],
      ];
    }
    this.bagIndex = 0;
    this.bagNumber = 1;
  }

  // 시드 기반 테트리스 표준 7-bag 시스템 초기화
  initializeTetrominoBagWithSeed(seed: number): void {
    const types: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    this.tetrominoBag = [...types];

    // 시드 기반 셔플 (Fisher-Yates)
    const seededRandom = this.createSeededRandom(seed);
    for (let i = this.tetrominoBag.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [this.tetrominoBag[i], this.tetrominoBag[j]] = [
        this.tetrominoBag[j],
        this.tetrominoBag[i],
      ];
    }
    this.bagIndex = 0;
    this.bagNumber = 1;
  }

  // 시드 기반 랜덤 생성기 (개선된 버전)
  private createSeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      // 더 나은 랜덤 생성 알고리즘 사용
      state = (state * 1664525 + 1013904223) % 0x100000000;
      return (state & 0x7fffffff) / 0x7fffffff;
    };
  }

  // 시드 기반 가방 재생성
  private regenerateBagWithSeed(seed: number): void {
    const types: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    this.tetrominoBag = [...types];

    // 시드 기반 셔플 (Fisher-Yates)
    const seededRandom = this.createSeededRandom(seed);
    for (let i = this.tetrominoBag.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom() * (i + 1));
      [this.tetrominoBag[i], this.tetrominoBag[j]] = [
        this.tetrominoBag[j],
        this.tetrominoBag[i],
      ];
    }
    this.bagIndex = 0;
  }

  // 테트리스 표준 7-bag 시스템에서 다음 테트로미노 가져오기
  getNextTetrominoFromBag(): TetrominoType {
    // 가방이 비어있거나 모든 테트로미노를 사용했으면 새로운 가방 생성
    if (this.bagIndex >= this.tetrominoBag.length) {
      this.initializeTetrominoBag(); // 기존 초기화 메서드 재사용
      this.bagNumber++;
    }

    // 현재 인덱스의 테트로미노를 가져오고 인덱스 증가
    const tetromino = this.tetrominoBag[this.bagIndex];
    this.bagIndex++;

    return tetromino;
  }

  // 시드 기반 테트리스 표준 7-bag 시스템에서 다음 테트로미노 가져오기
  getNextTetrominoFromBagWithSeed(seed: number): TetrominoType {
    // 가방이 비어있거나 모든 테트로미노를 사용했으면 시드 기반으로 새로운 가방 생성
    if (this.bagIndex >= this.tetrominoBag.length) {
      // 가방 번호 계산 (몇 번째 가방인지)
      this.bagNumber++;

      // 시드에 가방 번호를 추가하여 각 가방마다 다른 순서 생성
      const bagSeed = seed + this.bagNumber;

      this.regenerateBagWithSeed(bagSeed);
    }

    // 현재 인덱스의 테트로미노를 가져오고 인덱스 증가
    const tetromino = this.tetrominoBag[this.bagIndex];
    this.bagIndex++;

    return tetromino;
  }

  // 테트리스 표준: 다음 피스들을 미리 생성하여 큐에 저장
  generateNextPieces(count: number = 6): TetrominoType[] {
    const pieces: TetrominoType[] = [];
    for (let i = 0; i < count; i++) {
      pieces.push(this.getNextTetrominoFromBag());
    }
    return pieces;
  }

  // 시드 기반 다음 피스들 생성
  generateNextPiecesWithSeed(seed: number, count: number = 6): TetrominoType[] {
    const pieces: TetrominoType[] = [];
    for (let i = 0; i < count; i++) {
      pieces.push(this.getNextTetrominoFromBagWithSeed(seed));
    }
    return pieces;
  }

  createEmptyBoard(): number[][] {
    return Array(BOARD_HEIGHT)
      .fill(null)
      .map(() => Array(BOARD_WIDTH).fill(0));
  }

  // 테트리스 표준: 테트로미노 생성 (스폰 위치에서 시작)
  createTetromino(type: TetrominoType): Tetromino {
    const spawnPos = TETROMINO_SPAWN_POSITIONS[type];
    return {
      type,
      position: { x: spawnPos.x, y: spawnPos.y },
      rotation: 0,
      shape: TETROMINO_SHAPES[type][0],
    };
  }

  // 테트리스 표준: 랜덤 테트로미노 타입 가져오기 (7-bag 시스템 사용)
  getRandomTetrominoType(): TetrominoType {
    return this.getNextTetrominoFromBag();
  }

  rotateTetromino(tetromino: Tetromino): Tetromino {
    const newRotation = (tetromino.rotation + 1) % 4;
    return {
      ...tetromino,
      rotation: newRotation,
      shape: TETROMINO_SHAPES[tetromino.type][newRotation],
    };
  }

  // SRS (Super Rotation System) 벽킥 구현
  rotateTetrominoWithWallKick(
    tetromino: Tetromino,
    board: number[][],
  ): Tetromino | null {
    const rotatedPiece = this.rotateTetromino(tetromino);

    // 기본 회전이 가능한지 확인
    if (this.isValidPosition(rotatedPiece, board)) {
      return rotatedPiece;
    }

    // SRS 벽킥 데이터 가져오기
    const wallKickData = SRS_WALL_KICK_DATA[tetromino.type];
    if (!wallKickData || wallKickData.length === 0) {
      // O 피스는 회전하지 않으므로 null 반환
      return null;
    }

    // 현재 회전에서 다음 회전으로의 벽킥 테스트
    const currentRotation = tetromino.rotation;
    const nextRotation = rotatedPiece.rotation;
    const kickIndex =
      currentRotation * 2 + (nextRotation > currentRotation ? 0 : 1);

    if (kickIndex < wallKickData.length) {
      const kicks = wallKickData[kickIndex];

      for (const [offsetX, offsetY] of kicks) {
        const kickedPiece = {
          ...rotatedPiece,
          position: {
            x: rotatedPiece.position.x + offsetX,
            y: rotatedPiece.position.y + offsetY,
          },
        };

        if (this.isValidPosition(kickedPiece, board)) {
          return kickedPiece;
        }
      }
    }

    // 벽킥이 실패하면 null 반환
    return null;
  }

  isValidPosition(
    tetromino: Tetromino,
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

  placeTetromino(tetromino: Tetromino, board: number[][]): number[][] {
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
    tetromino: Tetromino,
    board: number[][],
    offsetX: number,
    offsetY: number,
  ): Tetromino | null {
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

  dropTetromino(tetromino: Tetromino, board: number[][]): Tetromino {
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

  // 테트리스 국룽 점수 시스템
  calculateScore(linesCleared: number, level: number): number {
    const lineScores = [0, 100, 300, 500, 800]; // Single, Double, Triple, Tetris
    const baseScore = lineScores[linesCleared];

    // 레벨에 따른 점수 배율 (레벨 + 1)
    return baseScore * (level + 1);
  }

  // 테트리스 국룽 하드 드롭 보너스
  calculateHardDropBonus(level: number, dropDistance: number): number {
    // 하드 드롭 거리에 따른 보너스 점수 (거리 * 2)
    return dropDistance * 2;
  }

  // 테트리스 국룽 레벨 시스템
  calculateLevel(lines: number): number {
    return Math.floor(lines / 10);
  }

  // 표준 테트리스 게임오버 체크: 새로운 피스가 스폰될 수 없으면 게임오버
  isGameOver(board: number[][]): boolean {
    // 모든 테트로미노 타입을 확인
    const tetrominoTypes: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

    for (const type of tetrominoTypes) {
      const testPiece = this.createTetromino(type);
      if (this.isValidPosition(testPiece, board)) {
        // 하나라도 스폰될 수 있으면 게임 오버가 아님
        return false;
      }
    }

    // 모든 피스가 스폰될 수 없으면 게임 오버
    return true;
  }

  getGhostPiece(tetromino: Tetromino, board: number[][]): Tetromino {
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

  // 테트리스 국룽 드롭 간격 계산
  calculateDropInterval(level: number, distanceToBottom: number = 0): number {
    // 표준 테트리스 속도 공식: (0.8 - ((level - 1) * 0.007))^(level - 1) * 1000
    // 최소 50ms, 최대 1000ms
    if (level <= 0) return 1000;
    if (level >= 29) return 50;

    const baseInterval = Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
    let interval = Math.max(50, Math.min(1000, baseInterval));

    // 바닥까지의 거리가 0이면 인터벌을 늘림 (더 천천히 떨어지도록)
    if (distanceToBottom === 0) {
      interval = Math.min(1000, interval * 2); // 2배로 늘림
    }

    return interval;
  }

  // 바닥까지의 거리 계산
  calculateDistanceToBottom(piece: Tetromino, board: number[][]): number {
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
    currentPiece: Tetromino,
    board: number[][],
  ): { droppedPiece: Tetromino; dropDistance: number } {
    const originalY = currentPiece.position.y;
    const droppedPiece = this.dropTetromino(currentPiece, board);
    const dropDistance = droppedPiece.position.y - originalY;

    return { droppedPiece, dropDistance };
  }
}

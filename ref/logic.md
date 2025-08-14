기본 원칙

서버 권위(Server Authoritative)

최종 게임 상태는 서버가 결정.

클라이언트는 입력만 보내고, 서버가 검증/반영 후 다시 브로드캐스트.

해킹/치트 방지 + 동기화 문제 최소화.

랜덤 블록 순서 동기화

게임 시작 시 서버가 **랜덤 시드(seed)**를 전송.

클라이언트는 동일한 RNG로 블록 순서 생성 → 매번 블록 모양 전체를 보낼 필요 없음.

서버는 필요 시 특정 시점의 "블록 큐"를 재전송하여 desync 방지.

데이터 흐름 예시

1. 클라이언트 → 서버

입력 이벤트만 전송 (시간 or 틱 단위)

{
"type": "input",
"time": 2312, // 클라이언트 틱 또는 서버 타임스탬프
"action": "move_left" // move_left, move_right, rotate, soft_drop, hard_drop
}

장점: 대역폭 절약, 재생산 가능

서버에서 해당 입력을 재현하여 게임 상태를 업데이트 후, 다른 클라이언트에 전달

2. 서버 → 클라이언트
   (1) 시작 시
   {
   "type": "start",
   "seed": 12345678,
   "tick_rate": 60
   }

(2) 입력 브로드캐스트
{
"type": "remote_input",
"player_id": "p2",
"time": 2312,
"action": "rotate"
}

(3) 주기적 스냅샷(Desync 방지)
{
"type": "state",
"time": 5000,
"board": [[0,0,1,1,...], ...], // 압축 가능 (RLE 등)
"current_piece": "T",
"next_queue": ["L", "O", "Z"]
}

스냅샷은 1~2초 간격으로만 보내면 충분 (나머지는 입력 재현으로 동기화)

최소 데이터 전략

액션 단위 전송 (move, rotate, drop)
→ 1~2바이트면 가능

서버 틱 기반 동기화
→ "action at tick #1234" 식으로 재생산

블록 모양 전송 생략
→ RNG 시드 공유

보드 상태 압축
→ RLE(Run Length Encoding)로 200칸 보드를 10~20바이트로 가능

간헐적 스냅샷
→ 유실 복구용

간단한 데이터 사이즈 예시

입력 이벤트:
2 bytes (tick) + 1 byte (action) + 1 byte (player) = 4 bytes

초당 5번 입력 → 20 bytes/s → 1분에 1.2KB

보드 스냅샷: 압축 후 약 30~50 bytes, 2초마다 전송해도 부담 없음

구조 요약

시작: 서버 → (시드, tick_rate, player list)

진행: 클 → 서 (입력), 서 → 클 (다른 플레이어 입력)

보정: 서버 → 클 (주기적 스냅샷)

// ==============================
// server.js (Node.js)
// ==============================
// 설치: npm init -y && npm i ws
// 실행: node server.js

```js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

// ---------- 유틸: 시드 기반 RNG + 7-백 생성 ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
function shuffledBag(rng) {
  const bag = PIECES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// ---------- 테트리스 간단 로직(충분히 미니멀) ----------
const W = 10,
  H = 20;

function emptyBoard() {
  return Array.from({ length: H }, () => Array(W).fill(0));
}
const SHAPES = {
  I: [[1, 1, 1, 1]],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [1, 1, 1],
    [0, 1, 0],
  ],
  L: [
    [1, 0],
    [1, 0],
    [1, 1],
  ],
  J: [
    [0, 1],
    [0, 1],
    [1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
  ],
};
function rotate(shape) {
  const h = shape.length,
    w = shape[0].length;
  const r = Array.from({ length: w }, () => Array(h).fill(0));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) r[x][h - 1 - y] = shape[y][x];
  return r;
}
function collide(board, piece) {
  const { shape, x, y } = piece;
  for (let py = 0; py < shape.length; py++) {
    for (let px = 0; px < shape[0].length; px++) {
      if (!shape[py][px]) continue;
      const gx = x + px,
        gy = y + py;
      if (gx < 0 || gx >= W || gy >= H) return true;
      if (gy >= 0 && board[gy][gx]) return true;
    }
  }
  return false;
}
function lockPiece(board, piece) {
  const { shape, x, y } = piece;
  for (let py = 0; py < shape.length; py++)
    for (let px = 0; px < shape[0].length; px++)
      if (shape[py][px]) {
        const gy = y + py,
          gx = x + px;
        if (gy >= 0 && gy < H && gx >= 0 && gx < W) board[gy][gx] = 1;
      }
  // 라인 클리어
  let cleared = 0;
  for (let r = H - 1; r >= 0; ) {
    if (board[r].every((v) => v)) {
      board.splice(r, 1);
      board.unshift(Array(W).fill(0));
      cleared++;
    } else r--;
  }
  return cleared;
}
function spawnNext(state) {
  if (state.queue.length === 0) {
    state.queue = shuffledBag(state.rng);
  }
  const t = state.queue.shift();
  const shape = SHAPES[t].map((row) => row.slice());
  return { type: t, shape, x: Math.floor(W / 2) - 1, y: -2, rot: 0 };
}

// ---------- 권위 상태 ----------
const TICK_RATE = 60; // 권장 60
const SNAP_INTERVAL = 120; // 2초마다 스냅(60틱 * 2)

const rooms = new Map(); // roomId -> { seed, rng, tick, players: Map, boardPerPlayer }

function createRoom(roomId) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);
  const room = {
    seed,
    rng,
    tick: 0,
    players: new Map(), // id -> { ws, inputs:[], piece, board, queue:[], alive:true }
  };
  rooms.set(roomId, room);
  return room;
}

function ensureRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

function addPlayer(room, id, ws) {
  const rng = mulberry32(room.seed); // 각 클라와 동일한 시퀀스 위해 seed 공유(권위는 동일 시드)
  const state = {
    ws,
    inputs: [],
    rng,
    queue: [],
    board: emptyBoard(),
    piece: null,
    alive: true,
  };
  state.piece = spawnNext(state);
  room.players.set(id, state);
}

function stepRoom(room) {
  room.tick++;
  for (const [id, pl] of room.players) {
    if (!pl.alive) continue;

    // 입력 처리 (현재 틱 이하만 적용)
    while (pl.inputs.length && pl.inputs[0].tick <= room.tick) {
      const ev = pl.inputs.shift();
      applyInput(pl, ev.act);
    }

    // 중력
    pl.piece.y++;
    if (collide(pl.board, pl.piece)) {
      pl.piece.y--;
      lockPiece(pl.board, pl.piece);
      pl.piece = spawnNext(pl);
      if (collide(pl.board, pl.piece)) {
        pl.alive = false; // 게임오버
      }
    }
  }

  // 주기적 스냅샷(간단 버전: 자신의 것만 반환)
  if (room.tick % SNAP_INTERVAL === 0) {
    for (const [id, pl] of room.players) {
      safeSend(pl.ws, { t: 'snap', tick: room.tick, self: packState(pl) });
    }
  }
}

function applyInput(pl, act) {
  if (!pl.alive) return;
  if (act === 'L') {
    pl.piece.x--;
    if (collide(pl.board, pl.piece)) pl.piece.x++;
  } else if (act === 'R') {
    pl.piece.x++;
    if (collide(pl.board, pl.piece)) pl.piece.x--;
  } else if (act === 'D') {
    pl.piece.y++;
    if (collide(pl.board, pl.piece)) pl.piece.y--;
  } else if (act === 'HD') {
    while (!collide(pl.board, pl.piece)) pl.piece.y++;
    pl.piece.y--;
    lockPiece(pl.board, pl.piece);
    pl.piece = spawnNext(pl);
  } else if (act === 'ROT') {
    const old = pl.piece.shape;
    pl.piece.shape = rotate(pl.piece.shape);
    if (collide(pl.board, pl.piece)) pl.piece.shape = old;
  }
}

function packState(pl) {
  return {
    piece: {
      t: pl.piece.type,
      x: pl.piece.x,
      y: pl.piece.y,
      rot: pl.piece.rot || 0,
    },
    board: pl.board, // 데모를 위해 압축 생략. 실제는 RLE 권장
    alive: pl.alive,
  };
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {}
}

// ---------- 틱 루프 ----------
setInterval(() => {
  for (const room of rooms.values()) stepRoom(room);
}, 1000 / TICK_RATE);

// ---------- 연결 처리 ----------
let nextId = 1;
wss.on('connection', (ws) => {
  const id = `p${nextId++}`;
  const room = ensureRoom('default');
  addPlayer(room, id, ws);

  // 시작 정보 전달 (시드, 틱, 레이트)
  safeSend(ws, {
    t: 'start',
    seed: room.seed,
    tick: room.tick,
    rate: TICK_RATE,
    id,
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    const pl = room.players.get(id);
    if (!pl) return;

    if (msg.t === 'i') {
      // 입력 수신 {t:'i', tick, act}
      // 권위: 자신의 큐에 저장해서 해당 틱에 적용
      if (typeof msg.tick === 'number' && typeof msg.act === 'string') {
        pl.inputs.push({ tick: msg.tick, act: msg.act });
        pl.inputs.sort((a, b) => a.tick - b.tick);
        // 다른 클라이언트에게도 입력 브로드캐스트(입력 재현)
        for (const [oid, other] of room.players) {
          if (other.ws !== ws)
            safeSend(other.ws, {
              t: 'ri',
              from: id,
              tick: msg.tick,
              act: msg.act,
            });
        }
      }
    }
  });

  ws.on('close', () => {
    room.players.delete(id);
  });
});

console.log('WebSocket Tetris server on ws://localhost:8080');
```

// ==============================
// client.html (정적 파일)
// ==============================

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Minimal Tetris - Input Replay</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
      }
      canvas {
        border: 1px solid #ccc;
        image-rendering: pixelated;
      }
      .hud {
        margin: 8px 0;
      }
      button {
        margin-right: 6px;
      }
    </style>
  </head>
  <body>
    <h3>Minimal Tetris (Input Replay)</h3>
    <div class="hud">
      <span id="status">connecting...</span>
    </div>
    <canvas id="cv" width="200" height="400"></canvas>
    <script>
      const W = 10,
        H = 20,
        CELL = 20;
      const SHAPES = {
        I: [[1, 1, 1, 1]],
        O: [
          [1, 1],
          [1, 1],
        ],
        T: [
          [1, 1, 1],
          [0, 1, 0],
        ],
        L: [
          [1, 0],
          [1, 0],
          [1, 1],
        ],
        J: [
          [0, 1],
          [0, 1],
          [1, 1],
        ],
        S: [
          [0, 1, 1],
          [1, 1, 0],
        ],
        Z: [
          [1, 1, 0],
          [0, 1, 1],
        ],
      };
      function rotate(s) {
        const h = s.length,
          w = s[0].length;
        const r = Array.from({ length: w }, () => Array(h).fill(0));
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) r[x][h - 1 - y] = s[y][x];
        return r;
      }
      function emptyBoard() {
        return Array.from({ length: H }, () => Array(W).fill(0));
      }
      function mulberry32(a) {
        return function () {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      const PIECES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
      function shuffledBag(rng) {
        const bag = PIECES.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        return bag;
      }

      const ws = new WebSocket('ws://localhost:8080');
      const statusEl = document.getElementById('status');
      const cv = document.getElementById('cv');
      const ctx = cv.getContext('2d');

      let id = null,
        seed = 0,
        rate = 60,
        serverTick = 0;
      let rng = null,
        queue = [];
      let board = emptyBoard();
      let piece = null;
      let alive = true;

      // 로컬 틱(서버에 맞춰 보정)
      let localTick = 0;
      let tickMs = 1000 / 60;
      let lastTs = performance.now();

      function spawnNext() {
        if (queue.length === 0) queue = shuffledBag(rng);
        const t = queue.shift();
        const shape = SHAPES[t].map((r) => r.slice());
        return { type: t, shape, x: Math.floor(W / 2) - 1, y: -2, rot: 0 };
      }
      function collide(b, p) {
        const { shape, x, y } = p;
        for (let py = 0; py < shape.length; py++) {
          for (let px = 0; px < shape[0].length; px++) {
            if (!shape[py][px]) continue;
            const gx = x + px,
              gy = y + py;
            if (gx < 0 || gx >= W || gy >= H) return true;
            if (gy >= 0 && b[gy][gx]) return true;
          }
        }
        return false;
      }
      function lockPiece(b, p) {
        const { shape, x, y } = p;
        for (let py = 0; py < shape.length; py++)
          for (let px = 0; px < shape[0].length; px++)
            if (shape[py][px]) {
              const gy = y + py,
                gx = x + px;
              if (gy >= 0 && gy < H && gx >= 0 && gx < W) b[gy][gx] = 1;
            }
        let r = H - 1;
        while (r >= 0) {
          if (b[r].every((v) => v)) {
            b.splice(r, 1);
            b.unshift(Array(W).fill(0));
          } else r--;
        }
      }

      function draw() {
        ctx.clearRect(0, 0, cv.width, cv.height); // 보드
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            if (board[y][x]) {
              ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
            }
          }
        if (piece) {
          const s = piece.shape;
          for (let py = 0; py < s.length; py++)
            for (let px = 0; px < s[0].length; px++) {
              if (s[py][px])
                ctx.fillRect(
                  (piece.x + px) * CELL,
                  (piece.y + py) * CELL,
                  CELL - 1,
                  CELL - 1,
                );
            }
        }
      }

      function sendInput(act) {
        ws.send(JSON.stringify({ t: 'i', tick: localTick + 1, act })); // 다음 틱에 적용되도록 살짝 미래틱
        // 로컬에서도 즉시 입력 적용(낙관적 렌더링)
        applyInputLocal(act);
      }

      function applyInputLocal(act) {
        if (!alive || !piece) return;
        if (act === 'L') {
          piece.x--;
          if (collide(board, piece)) piece.x++;
        } else if (act === 'R') {
          piece.x++;
          if (collide(board, piece)) piece.x--;
        } else if (act === 'D') {
          piece.y++;
          if (collide(board, piece)) piece.y--;
        } else if (act === 'HD') {
          while (!collide(board, piece)) piece.y++;
          piece.y--;
          lockPiece(board, piece);
          piece = spawnNext();
          if (collide(board, piece)) alive = false;
        } else if (act === 'ROT') {
          const old = piece.shape;
          piece.shape = rotate(piece.shape);
          if (collide(board, piece)) piece.shape = old;
        }
      }

      // 키 입력
      window.addEventListener('keydown', (e) => {
        if (e.repeat) return; // 단순화
        if (e.key === 'ArrowLeft') sendInput('L');
        else if (e.key === 'ArrowRight') sendInput('R');
        else if (e.key === 'ArrowUp') sendInput('ROT');
        else if (e.key === 'ArrowDown') sendInput('D');
        else if (e.key === ' ') {
          e.preventDefault();
          sendInput('HD');
        }
      });

      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'start') {
          id = m.id;
          seed = m.seed;
          rate = m.rate;
          serverTick = m.tick;
          rng = mulberry32(seed);
          queue = [];
          board = emptyBoard();
          piece = spawnNext();
          alive = true;
          tickMs = 1000 / rate;
          localTick = serverTick;
          statusEl.textContent = `connected: ${id}, seed=${seed}`;
        } else if (m.t === 'ri') {
          // 다른 플레이어 입력. 데모는 1인용 시각화라 무시해도 됨. 멀티라면 별도 상태에 동일 적용.
          // 이 예제에선 콘솔만.
          console.log('remote input', m);
        } else if (m.t === 'snap') {
          // 권위 스냅으로 보정
          if (m.self) {
            // 간단히 완전 덮어쓰기(현실에선 가벼운 보간/보정 권장)
            alive = m.self.alive;
            // 보드/피스 보정
            board = m.self.board;
            // 서버는 rot만 보내지만 데모 단순화를 위해 현재 회전 그대로 둠
            // 실제 구현에서는 rot값을 이용해 shape를 재구성해야 정확
          }
          serverTick = m.tick;
          // 로컬 틱 드리프트 보정(서버틱과 차이가 크면 동기화)
          if (Math.abs(localTick - serverTick) > 3) localTick = serverTick;
        }
      };

      ws.onopen = () => (statusEl.textContent = 'handshaking...');
      ws.onclose = () => (statusEl.textContent = 'disconnected');

      // 로컬 게임 루프(서버 틱에 맞춰 동일 로직 실행)
      function loop(now) {
        const dt = now - lastTs;
        if (dt >= tickMs) {
          lastTs = now;
          localTick++;
          // 중력
          if (alive && piece) {
            piece.y++;
            if (collide(board, piece)) {
              piece.y--;
              lockPiece(board, piece);
              piece = spawnNext();
              if (collide(board, piece)) alive = false;
            }
          }
          draw();
          statusEl.textContent = `id=${id} tick L/S: ${localTick}/${serverTick}`;
        }
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    </script>
  </body>
</html>
```

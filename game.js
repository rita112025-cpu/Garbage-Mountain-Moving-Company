'use strict';

(() => {
  // ---------- Constants ----------
  const TILE = 32;
  const COLS = 30;
  const ROWS = 20;
  const ROUND_SECONDS = 60;
  const MAX_CHAIN = 5;
  const HOOK_RANGE = 60;
  const TRAILER_RADIUS = 12;
  const FIRST_LINK = 28;
  const LINK_SPACING = 30;
  const FOLLOW_RATE = 10;
  const HOOK_GRACE = 0.5;
  const REHOOK_COOLDOWN = 1;
  const EXTEND_STEP = 4;
  const EXTEND_CLEARANCE = 15; // larger than the biggest cargo radius (sofa, 14)
  const NEED_DEEPER = '整串都要進站，再往內開一點';
  const HISTORY_STEP = 2;
  const BASE_SPEED = 230;
  const BASE_ACCEL = 420;
  const BASE_TURN = 3.4;
  const PIVOT_GRIP = 0.4; // share of the empty trailer's full turn rate available while pinned against a wall
  const PIVOT_WEIGHT_K = 0.01; // how much each unit of cargo weight slows that pivot
  const BEST_KEY = 'gmmc.bestScore';
  const DT = 1 / 60;

  // '#' = garbage wall, '.' = road, 'R' = recycling station
  const MAP = [
    '##############################',
    '#...........#................#',
    '#.RRRRR.....#................#',
    '#.RRRRR..........########....#',
    '#.RRRRR..........########....#',
    '#.RRRRR..........########....#',
    '#................########....#',
    '#...........#................#',
    '#####....####................#',
    '#####....####..########..#####',
    '#..............########......#',
    '#..............########......#',
    '#....######....########..##..#',
    '#....######...............#..#',
    '#....######...............#..#',
    '#....######....#####..###....#',
    '#..............#####.........#',
    '#..............#####.........#',
    '#..............#####.........#',
    '##############################',
  ];

  const KINDS = {
    box:    { name: '紙箱', weight: 1, value: 10, w: 22, h: 22, r: 10 },
    sofa:   { name: '沙發', weight: 3, value: 30, w: 36, h: 20, r: 14 },
    fridge: { name: '冰箱', weight: 5, value: 60, w: 24, h: 28, r: 13 },
  };

  // [kind, col, row] — fridges sit near the narrow alleys on purpose.
  const LAYOUT = [
    ['box', 9, 1], ['box', 3, 13], ['box', 12, 17], ['box', 18, 2], ['box', 21, 17],
    ['sofa', 2, 17], ['sofa', 26, 2], ['sofa', 13, 13], ['sofa', 27, 17],
    ['fridge', 27, 12], ['fridge', 28, 14], ['fridge', 21, 14], ['fridge', 20, 16], ['fridge', 14, 10],
  ];

  const START = { x: 9.5 * TILE, y: 4.5 * TILE, angle: 0 };

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const ui = {
    time: document.getElementById('hud-time'),
    score: document.getElementById('hud-score'),
    chain: document.getElementById('hud-chain'),
    weight: document.getElementById('hud-weight'),
    titleScreen: document.getElementById('screen-title'),
    overScreen: document.getElementById('screen-over'),
    titleBest: document.getElementById('title-best'),
    overScore: document.getElementById('over-score'),
    overCount: document.getElementById('over-count'),
    overBest: document.getElementById('over-best'),
    overRecord: document.getElementById('over-record'),
    btnStart: document.getElementById('btn-start'),
    btnRestart: document.getElementById('btn-restart'),
  };

  // ---------- Storage ----------
  function loadBest() {
    try {
      const v = Number(localStorage.getItem(BEST_KEY));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  }

  function saveBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch {
      // Storage unavailable (private mode / file:// restrictions): best score lives for this tab only.
    }
  }

  // ---------- Map helpers ----------
  function tileAt(col, row) {
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return '#';
    return MAP[row][col];
  }

  function isWall(col, row) {
    return tileAt(col, row) === '#';
  }

  function circleHitsWall(x, y, r) {
    const c0 = Math.floor((x - r) / TILE);
    const c1 = Math.floor((x + r) / TILE);
    const r0 = Math.floor((y - r) / TILE);
    const r1 = Math.floor((y + r) / TILE);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (!isWall(col, row)) continue;
        const nx = Math.max(col * TILE, Math.min(x, (col + 1) * TILE));
        const ny = Math.max(row * TILE, Math.min(y, (row + 1) * TILE));
        if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  function inRecycle(x, y) {
    return tileAt(Math.floor(x / TILE), Math.floor(y / TILE)) === 'R';
  }

  // ---------- Game state ----------
  const keys = new Set();
  const game = {
    mode: 'title', // 'title' | 'playing' | 'over'
    timeLeft: ROUND_SECONDS,
    score: 0,
    delivered: 0,
    best: loadBest(),
    trailer: null,
    items: [],
    chain: [],
    history: [],
    flash: 0,
    flashText: '',
  };

  function makeItems() {
    return LAYOUT.map(([kind, col, row], id) => ({
      id,
      kind,
      ...KINDS[kind],
      x: (col + 0.5) * TILE,
      y: (row + 0.5) * TILE,
      angle: 0,
      state: 'loose', // 'loose' | 'hooked' | 'delivered'
      grace: 0,
      cooldown: 0,
      hookOdometer: 0,
    }));
  }

  function reset() {
    game.timeLeft = ROUND_SECONDS;
    game.score = 0;
    game.delivered = 0;
    game.trailer = { ...START, speed: 0, bumped: 0, wallStuck: false };
    game.items = makeItems();
    game.chain = [];
    game.history = [{ x: START.x, y: START.y }];
    game.odometer = 0;
    game.flash = 0;
    game.flashText = '';
    keys.clear();
  }

  function startRound() {
    reset();
    game.mode = 'playing';
    ui.titleScreen.classList.add('hidden');
    ui.overScreen.classList.add('hidden');
    canvas.focus?.();
  }

  function endRound() {
    game.mode = 'over';
    const isRecord = game.score > game.best;
    if (isRecord) {
      game.best = game.score;
      saveBest(game.best);
    }
    ui.overScore.textContent = String(game.score);
    ui.overCount.textContent = String(game.delivered);
    ui.overBest.textContent = String(game.best);
    ui.overRecord.classList.toggle('hidden', !isRecord);
    ui.overScreen.classList.remove('hidden');
    ui.btnRestart.focus();
  }

  function chainWeight() {
    return game.chain.reduce((sum, item) => sum + item.weight, 0);
  }

  // ---------- Hook / detach / deliver ----------
  function nearestHookable() {
    const t = game.trailer;
    let best = null;
    let bestDist = HOOK_RANGE;
    for (const item of game.items) {
      if (item.state !== 'loose' || item.cooldown > 0) continue;
      const d = Math.hypot(item.x - t.x, item.y - t.y);
      if (d <= bestDist) {
        best = item;
        bestDist = d;
      }
    }
    return best;
  }

  function tryHook() {
    if (game.mode !== 'playing') return false;
    if (game.chain.length >= MAX_CHAIN) {
      game.flash = 1;
      game.flashText = `最多只能拖 ${MAX_CHAIN} 件！`;
      return false;
    }
    const item = nearestHookable();
    if (!item) return false;
    item.state = 'hooked';
    item.grace = HOOK_GRACE;
    item.hookOdometer = game.odometer;
    game.chain.push(item);
    return true;
  }

  function detachFrom(index) {
    const dropped = game.chain.splice(index);
    for (const item of dropped) {
      item.state = 'loose';
      item.grace = 0;
      item.cooldown = REHOOK_COOLDOWN;
    }
    game.flash = 1;
    game.flashText = `掉了 ${dropped.length} 件貨！`;
    return dropped.length;
  }

  // Keeps a hint on screen without restarting the fade every frame.
  function hint(text) {
    if (game.flashText !== text || game.flash < 0.3) {
      game.flashText = text;
      game.flash = 0.6;
    }
  }

  function deliver() {
    if (game.chain.length === 0) return;
    const points = game.chain.reduce((sum, item) => sum + item.value, 0);
    for (const item of game.chain) item.state = 'delivered';
    game.score += points;
    game.delivered += game.chain.length;
    game.flash = 1;
    game.flashText = `交付 ${game.chain.length} 件 +${points}`;
    game.chain = [];
  }

  // ---------- Simulation ----------
  function updateTrailer(dt) {
    const t = game.trailer;
    const w = chainWeight();
    const maxForward = BASE_SPEED / (1 + 0.06 * w);
    const maxReverse = maxForward * 0.45;
    const accel = BASE_ACCEL / (1 + 0.08 * w);
    const turnRate = BASE_TURN / (1 + 0.05 * w);

    const up = keys.has('up');
    const down = keys.has('down');
    if (up && !down) {
      t.speed += accel * dt;
    } else if (down && !up) {
      t.speed -= (t.speed > 0 ? accel * 1.6 : accel) * dt;
    } else {
      const drag = 300 * dt;
      t.speed = Math.abs(t.speed) <= drag ? 0 : t.speed - Math.sign(t.speed) * drag;
    }
    t.speed = Math.max(-maxReverse, Math.min(maxForward, t.speed));

    const steer = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    let rate = turnRate * Math.min(1, Math.abs(t.speed) / 60);
    let dir = Math.sign(t.speed);
    // Pinned against a wall: allow a slow pivot so the player can turn away. Cargo still slows it,
    // but less than it slows driving turns, so a full load is not stuck for several seconds.
    const pivotRate = (BASE_TURN * PIVOT_GRIP) / (1 + PIVOT_WEIGHT_K * w);
    if (t.wallStuck && rate < pivotRate) {
      rate = pivotRate;
      dir = down && !up ? -1 : 1;
    }
    t.angle += steer * rate * dir * dt;

    const dx = Math.cos(t.angle) * t.speed * dt;
    const dy = Math.sin(t.angle) * t.speed * dt;
    let hit = false;
    const ox = t.x;
    const oy = t.y;
    if (!circleHitsWall(t.x + dx, t.y, TRAILER_RADIUS)) t.x += dx; else hit = true;
    if (!circleHitsWall(t.x, t.y + dy, TRAILER_RADIUS)) t.y += dy; else hit = true;
    if (t.speed > 0) game.odometer += Math.hypot(t.x - ox, t.y - oy);
    if (hit) {
      t.speed = 0;
      t.bumped = 0.25;
      t.wallStuck = true;
    } else if (Math.hypot(t.x - ox, t.y - oy) > 0.5) {
      t.wallStuck = false;
    }
    t.bumped = Math.max(0, t.bumped - dt);

    if (t.speed > 0) {
      const head = game.history[game.history.length - 1];
      if (Math.hypot(t.x - head.x, t.y - head.y) >= HISTORY_STEP) {
        game.history.push({ x: t.x, y: t.y });
        const keep = Math.ceil((FIRST_LINK + LINK_SPACING * MAX_CHAIN) / HISTORY_STEP) + 40;
        if (game.history.length > keep) game.history.splice(0, game.history.length - keep);
      }
    } else if (t.speed < 0) {
      // Reversing rewinds the trail so cargo is pushed back along it instead of piling onto the trailer.
      const h = game.history;
      while (h.length > 1) {
        const a = h[h.length - 1];
        const b = h[h.length - 2];
        if (Math.hypot(t.x - b.x, t.y - b.y) >= Math.hypot(t.x - a.x, t.y - a.y)) break;
        h.pop();
      }
      // Whole trail consumed: restart it at the trailer so pathPoints extends straight out behind it.
      if (h.length === 1) h[0] = { x: t.x, y: t.y };
    }
  }

  // Points at increasing path distance behind the trailer, walking back through its trail.
  function pathPoints(distances) {
    const t = game.trailer;
    const out = [];
    let prev = { x: t.x, y: t.y };
    // Direction pointing back along the trail; starts as "behind the trailer".
    let dir = { x: -Math.cos(t.angle), y: -Math.sin(t.angle) };
    let travelled = 0;
    let idx = game.history.length - 1;
    for (const target of distances) {
      while (idx >= 0) {
        const p = game.history[idx];
        const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
        if (travelled + seg >= target && seg > 0) {
          const f = (target - travelled) / seg;
          out.push({ x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f });
          break;
        }
        if (seg > 0) dir = { x: (p.x - prev.x) / seg, y: (p.y - prev.y) / seg };
        travelled += seg;
        prev = p;
        idx--;
      }
      if (idx < 0) {
        // Trail used up (e.g. after a long reverse): extend it straight out so cargo spreads instead of stacking.
        // Walk out in small steps and stop short of walls, so a parked trailer never drags cargo into one.
        let x = prev.x;
        let y = prev.y;
        let rest = target - travelled;
        while (rest > 0) {
          const s = Math.min(EXTEND_STEP, rest);
          const nx = x + dir.x * s;
          const ny = y + dir.y * s;
          if (circleHitsWall(nx, ny, EXTEND_CLEARANCE)) break;
          x = nx;
          y = ny;
          rest -= s;
        }
        out.push({ x, y });
      }
    }
    return out;
  }

  function updateChain(dt) {
    if (game.chain.length === 0) return;
    const distances = game.chain.map((_, i) => FIRST_LINK + LINK_SPACING * i);
    const targets = pathPoints(distances);
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    let lead = game.trailer;

    for (let i = 0; i < game.chain.length; i++) {
      const item = game.chain[i];
      const prevX = item.x;
      const prevY = item.y;
      item.x += (targets[i].x - item.x) * k;
      item.y += (targets[i].y - item.y) * k;
      // Being pushed (e.g. while reversing): never let cargo overlap the trailer itself.
      // Push along the trail (towards the item's own target), never forwards past the trailer.
      const t = game.trailer;
      const gap = Math.hypot(item.x - t.x, item.y - t.y);
      const minGap = TRAILER_RADIUS + item.r;
      const bx = targets[i].x - t.x;
      const by = targets[i].y - t.y;
      const back = Math.hypot(bx, by);
      // Never push past the target itself: near walls the target is clamped short of them.
      const pushTo = Math.min(minGap, back);
      if (gap < pushTo && back > 0.001) {
        item.x = t.x + (bx / back) * pushTo;
        item.y = t.y + (by / back) * pushTo;
      }
      const ax = lead.x - item.x;
      const ay = lead.y - item.y;
      if (ax * ax + ay * ay > 1) item.angle = Math.atan2(ay, ax);
      item.grace = Math.max(0, item.grace - dt);
      // Until the trailer has driven far enough after hooking, this item still trails over ground laid
      // before it was hooked (e.g. the trailer's parking spot against a wall), which may not fit its width.
      const settled = game.odometer - item.hookOdometer >= distances[i] + item.r;

      if (item.grace === 0 && settled && circleHitsWall(item.x, item.y, item.r)) {
        item.x = prevX;
        item.y = prevY;
        detachFrom(i);
        return;
      }
      lead = item;
    }
  }

  function step(dt) {
    if (game.mode !== 'playing') return;
    game.timeLeft = Math.max(0, game.timeLeft - dt);
    updateTrailer(dt);
    updateChain(dt);
    for (const item of game.items) item.cooldown = Math.max(0, item.cooldown - dt);
    if (game.chain.length > 0) {
      if (game.chain.every((item) => inRecycle(item.x, item.y))) {
        deliver();
      } else if (inRecycle(game.trailer.x, game.trailer.y)) {
        hint(NEED_DEEPER);
      }
    }
    game.flash = Math.max(0, game.flash - dt * 0.8);
    if (game.timeLeft <= 0) endRound();
  }

  // ---------- Rendering ----------
  function drawMap() {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = col * TILE;
        const y = row * TILE;
        const tile = MAP[row][col];
        if (tile === '#') {
          ctx.fillStyle = '#5b4a35';
          ctx.fillRect(x, y, TILE, TILE);
          const seed = (col * 7 + row * 13) % 5;
          ctx.fillStyle = ['#6e5a3f', '#4f6b3a', '#7a6a52', '#665141', '#58613f'][seed];
          ctx.beginPath();
          ctx.arc(x + 8 + seed * 3, y + 10 + (seed % 3) * 4, 7, 0, Math.PI * 2);
          ctx.arc(x + 22 - seed, y + 22 - seed, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(x, y + TILE - 4, TILE, 4);
        } else {
          ctx.fillStyle = tile === 'R' ? '#2f6b3a' : '#3d3a35';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
          if ((col + row) % 2 === 0) ctx.fillRect(x, y, TILE, TILE);
        }
      }
    }

    // Recycling station label
    ctx.save();
    ctx.strokeStyle = '#8ee88a';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(2 * TILE + 2, 2 * TILE + 2, 5 * TILE - 4, 4 * TILE - 4);
    ctx.setLineDash([]);
    ctx.fillStyle = '#c9f5c5';
    ctx.font = 'bold 18px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('♻ 回收站', 4.5 * TILE, 4.1 * TILE);
    ctx.restore();
  }

  function drawItem(item, highlight) {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.angle);
    const { w, h } = item;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w, h);

    if (item.kind === 'box') {
      ctx.fillStyle = '#c48a4a';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#e8c48a';
      ctx.fillRect(-w / 2, -2, w, 4);
      ctx.strokeStyle = '#8a5a2b';
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    } else if (item.kind === 'sofa') {
      ctx.fillStyle = '#b8443a';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#d9675b';
      ctx.fillRect(-w / 2 + 4, -h / 2 + 5, w / 2 - 5, h - 9);
      ctx.fillRect(1, -h / 2 + 5, w / 2 - 5, h - 9);
      ctx.fillStyle = '#8f2f27';
      ctx.fillRect(-w / 2, -h / 2, w, 4);
    } else {
      ctx.fillStyle = '#dfe8ee';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#8aa0ad';
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2 + 10);
      ctx.lineTo(w / 2, -h / 2 + 10);
      ctx.stroke();
      ctx.fillStyle = '#6f8592';
      ctx.fillRect(w / 2 - 6, -h / 2 + 3, 2, 5);
      ctx.fillRect(w / 2 - 6, -h / 2 + 13, 2, 9);
    }
    ctx.restore();

    if (highlight) {
      ctx.strokeStyle = '#f2a93b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawRopes() {
    if (game.chain.length === 0) return;
    ctx.strokeStyle = '#d8c9a8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const t = game.trailer;
    ctx.moveTo(t.x - Math.cos(t.angle) * 16, t.y - Math.sin(t.angle) * 16);
    for (const item of game.chain) ctx.lineTo(item.x, item.y);
    ctx.stroke();
  }

  function drawTrailer() {
    const t = game.trailer;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-15, -9, 36, 22);
    ctx.fillStyle = '#222';
    ctx.fillRect(-12, -12, 8, 4);
    ctx.fillRect(-12, 8, 8, 4);
    ctx.fillRect(8, -12, 8, 4);
    ctx.fillRect(8, 8, 8, 4);
    ctx.fillStyle = t.bumped > 0 ? '#ff6a4a' : '#f2a93b';
    ctx.fillRect(-18, -10, 24, 20);
    ctx.fillStyle = '#e0e0d8';
    ctx.fillRect(6, -10, 12, 20);
    ctx.fillStyle = '#5fa8d3';
    ctx.fillRect(12, -8, 5, 16);
    ctx.fillStyle = '#7a5a1a';
    ctx.fillRect(-21, -2, 4, 4);
    ctx.restore();
  }

  function drawFlash() {
    if (game.flash <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, game.flash * 1.5);
    ctx.fillStyle = '#fff6dd';
    ctx.font = 'bold 26px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(game.flashText, canvas.width / 2, 48);
    ctx.restore();
  }

  function render() {
    drawMap();
    const target = game.mode === 'playing' && game.chain.length < MAX_CHAIN ? nearestHookable() : null;
    for (const item of game.items) {
      if (item.state === 'loose') drawItem(item, item === target);
    }
    drawRopes();
    for (let i = game.chain.length - 1; i >= 0; i--) drawItem(game.chain[i], false);
    drawTrailer();
    drawFlash();

    ui.time.textContent = game.timeLeft.toFixed(1);
    ui.score.textContent = String(game.score);
    ui.chain.textContent = `${game.chain.length} / ${MAX_CHAIN}`;
    ui.weight.textContent = String(chainWeight());
  }

  // ---------- Input ----------
  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };

  window.addEventListener('keydown', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) {
      keys.add(dir);
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat && game.mode === 'playing') tryHook();
    } else if (e.code === 'Enter' && game.mode !== 'playing') {
      e.preventDefault();
      startRound();
    }
  });

  window.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) keys.delete(dir);
  });

  window.addEventListener('blur', () => keys.clear());
  ui.btnStart.addEventListener('click', startRound);
  ui.btnRestart.addEventListener('click', startRound);

  // ---------- Loop ----------
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= DT) {
      step(DT);
      acc -= DT;
    }
    render();
    requestAnimationFrame(frame);
  }

  reset();
  ui.titleBest.textContent = String(game.best);
  requestAnimationFrame(frame);

  // Debug/test hook: lets automated checks drive the simulation deterministically.
  window.__gmmc = { game, keys, step, tryHook, startRound, reset, MAP, TILE, constants: { MAX_CHAIN, ROUND_SECONDS, BEST_KEY } };
})();

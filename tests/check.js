'use strict';
// Headless behaviour checks for game.js. Run: node tests/check.js
// Each scenario loads game.js into a fresh vm context with a minimal DOM stand-in.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');

function makeElement() {
  const classes = new Set();
  const listeners = {};
  return {
    textContent: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn()); },
    focus() {},
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    width: 960,
    height: 640,
  };
}

function load(storageSeed = {}) {
  const elements = {};
  const store = { ...storageSeed };
  const windowListeners = {};
  const sandbox = {
    document: { getElementById: (id) => (elements[id] ||= makeElement()) },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    Math, Number, String, Set, Object, Array, JSON, Proxy,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => { (windowListeners[type] ||= []).push(fn); };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  const api = sandbox.__gmmc;
  const g = api.game;
  const TILE = api.TILE;

  const press = (code) => (windowListeners.keydown || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} }));

  function run(sec, dirs, until) {
    api.keys.clear();
    dirs.forEach((d) => api.keys.add(d));
    for (let i = 0; i < Math.round(sec * 60); i++) {
      api.step(1 / 60);
      if (until && until()) break;
    }
    api.keys.clear();
  }

  function fresh(col, row, angle = 0) {
    api.startRound();
    const x = col * TILE;
    const y = row * TILE;
    Object.assign(g.trailer, { x, y, angle, speed: 0 });
    g.history = [{ x, y }];
  }

  function attach(kinds) {
    for (const k of kinds) {
      const it = g.items.find((i) => i.kind === k && i.state === 'loose');
      it.x = g.trailer.x;
      it.y = g.trailer.y;
      it.state = 'hooked';
      it.grace = 0.5;
      it.hookOdometer = g.odometer;
      g.chain.push(it);
    }
  }

  return { api, g, TILE, elements, store, press, run, fresh, attach };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, `${name}: ${err.message}`]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

check('勾住範圍內最近的家具（空白鍵）', () => {
  const t = load();
  t.fresh(9.5, 2.5);
  t.press('Space');
  assert(t.g.chain.length === 1 && t.g.chain[0].id === 0, `chain=${t.g.chain.map((i) => i.id)}`);
});

check('太遠不勾', () => {
  const t = load();
  t.fresh(9.5, 4.5);
  assert(t.api.tryHook() === false && t.g.chain.length === 0, 'hooked an out-of-range item');
});

check('最多 5 件，第 6 件被拒並提示', () => {
  const t = load();
  t.fresh(9.5, 4.5);
  t.g.items.slice(0, 6).forEach((it, i) => { it.x = t.g.trailer.x + i * 5; it.y = t.g.trailer.y + 10; });
  let n = 0;
  for (let i = 0; i < 6; i++) if (t.api.tryHook()) n++;
  assert(n === 5 && t.g.chain.length === 5, `hooked ${n}`);
  assert(t.g.flashText.includes('5'), `flash=${t.g.flashText}`);
});

check('載重越重越慢、越難轉', () => {
  const a = load();
  a.fresh(14, 1.5 + 0.5);
  a.run(1.5, ['up']);
  const b = load();
  b.fresh(14, 2);
  b.attach(['fridge', 'fridge', 'fridge', 'fridge', 'fridge']);
  b.g.chain.forEach((i) => { i.grace = 99; });
  b.run(1.5, ['up']);
  assert(b.g.trailer.speed < a.g.trailer.speed * 0.5, `empty=${a.g.trailer.speed} loaded=${b.g.trailer.speed}`);

  const turn = (t) => {
    t.fresh(20, 7.5);
    t.api.keys.add('up');
    t.api.keys.add('right');
    for (let i = 0; i < 20; i++) { t.g.trailer.speed = 80; t.api.step(1 / 60); }
    return t.g.trailer.angle;
  };
  const c = load();
  const d = load();
  const empty = turn(c);
  d.fresh(20, 7.5);
  d.attach(['fridge', 'fridge', 'fridge']);
  d.g.chain.forEach((i) => { i.grace = 99; });
  const loaded = (() => {
    d.api.keys.add('up');
    d.api.keys.add('right');
    for (let i = 0; i < 20; i++) { d.g.trailer.speed = 80; d.api.step(1 / 60); }
    return d.g.trailer.angle;
  })();
  assert(loaded < empty, `turn empty=${empty} loaded=${loaded}`);
});

check('拖車撞牆停下', () => {
  const t = load();
  t.fresh(9.5, 4.5, -Math.PI / 2);
  t.run(1.5, ['up']);
  assert(t.g.trailer.speed === 0 && t.g.trailer.y >= t.TILE + 12 - 0.01, `speed=${t.g.trailer.speed} y=${t.g.trailer.y}`);
});

check('第 2 件撞牆 → 第 2、3 件脫落，1 秒冷卻後可重勾', () => {
  const t = load();
  t.fresh(14, 1 + 13 / 32);
  t.attach(['box', 'sofa', 'box']);
  const ids = t.g.chain.map((i) => i.id);
  t.run(1.5, ['up'], () => t.g.chain.length < 3);
  assert(t.g.chain.length === 1 && t.g.chain[0].id === ids[0], `chain=${t.g.chain.map((i) => i.id)}`);
  const dropped = t.g.items[ids[1]];
  assert(dropped.state === 'loose' && t.g.items[ids[2]].state === 'loose', 'not dropped');
  // Teleport next to the dropped item only for the instant of the hook attempt (no simulation step in between).
  const tryHookAt = () => {
    const home = { x: t.g.trailer.x, y: t.g.trailer.y };
    Object.assign(t.g.trailer, { x: dropped.x, y: dropped.y + 4 });
    const ok = t.api.tryHook();
    Object.assign(t.g.trailer, home);
    return ok;
  };
  t.g.trailer.speed = 0;
  assert(tryHookAt() === false, 're-hooked during cooldown');
  t.run(1.1, []);
  assert(tryHookAt() === true && t.g.chain.length === 2, 're-hook after cooldown failed');
  assert(t.g.chain[1].id === ids[1] || t.g.chain[1].id === ids[2], `re-hooked wrong item ${t.g.chain[1].id}`);
});

check('穿過窄巷並轉出巷口不誤脫落', () => {
  for (const kinds of [['box', 'sofa'], ['sofa', 'fridge']]) {
    const t = load();
    t.fresh(14, 6.5, Math.PI / 2);
    t.attach(kinds);
    t.run(1.0, ['up']);
    t.run(0.9, ['up', 'right']);
    t.run(0.5, ['up']);
    const row = Math.floor(t.g.trailer.y / t.TILE);
    assert(row >= 10, `trailer never left the alley (row ${row})`);
    assert(t.g.chain.length === kinds.length, `${kinds} dropped to ${t.g.chain.length}`);
  }
});

check('整串進站交付：分數為各件總和、件數正確', () => {
  const t = load();
  t.fresh(9.5, 3.5, Math.PI);
  t.attach(['box', 'sofa', 'fridge']);
  t.run(4, ['up'], () => t.g.chain.length === 0);
  assert(t.g.score === 100 && t.g.delivered === 3, `score=${t.g.score} delivered=${t.g.delivered}`);
});

check('5 件長串直線開進站也能整串交付', () => {
  const t = load();
  t.fresh(11, 3.5, Math.PI);
  t.attach(['sofa', 'sofa', 'sofa', 'sofa', 'box']);
  t.run(6, ['up'], () => t.g.chain.length === 0);
  assert(t.g.delivered === 5 && t.g.score === 130, `delivered=${t.g.delivered} score=${t.g.score} chain=${t.g.chain.length}`);
});

check('拖車進站但貨在站外 → 不交付並提示往內開', () => {
  const t = load();
  t.fresh(4.5, 3.5, 0);
  t.attach(['box', 'sofa']);
  t.g.chain.forEach((it, i) => { it.x = (8 + i) * t.TILE; it.y = 3.5 * t.TILE; it.grace = 99; });
  t.api.step(1 / 600);
  assert(t.g.score === 0 && t.g.chain.length === 2, `score=${t.g.score}`);
  assert(t.g.flashText.includes('往內'), `flash=${t.g.flashText}`);
});

check('倒車 1 秒後家具不與拖車重疊', () => {
  const t = load();
  t.fresh(16, 2);
  t.attach(['box', 'box', 'box']);
  t.run(1.5, ['up']);
  t.run(1.0, ['down']);
  assert(t.g.chain.length === 3, `dropped while reversing (${t.g.chain.length})`);
  for (const it of t.g.chain) {
    const d = Math.hypot(it.x - t.g.trailer.x, it.y - t.g.trailer.y);
    assert(d >= it.r + 12, `${it.kind}#${it.id} at ${d.toFixed(1)}px`);
  }
});

check('倒車超過軌跡長度後家具彼此不堆疊', () => {
  const t = load();
  t.fresh(22, 2, Math.PI);
  t.attach(['box', 'sofa', 'fridge']);
  t.run(25 / 60, ['up']);
  t.run(2, ['down']);
  assert(t.g.chain.length === 3, `chain shrank to ${t.g.chain.length}`);
  const tr = t.g.trailer;
  for (const it of t.g.chain) {
    const ahead = (it.x - tr.x) * Math.cos(tr.angle) + (it.y - tr.y) * Math.sin(tr.angle);
    assert(ahead < 0, `${it.kind} ended up in front of the trailer (${ahead.toFixed(1)}px)`);
  }
  for (let i = 1; i < t.g.chain.length; i++) {
    const a = t.g.chain[i - 1];
    const b = t.g.chain[i];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    assert(d >= (a.r + b.r) * 0.8, `${a.kind}-${b.kind} gap ${d.toFixed(1)} < ${((a.r + b.r) * 0.8).toFixed(1)}`);
  }
});

check('勾住正前方的貨後往前開，貨會跑到車後而不是被推著走', () => {
  const t = load();
  t.fresh(16, 2);
  const it = t.g.items.find((i) => i.kind === 'box' && i.state === 'loose');
  it.x = t.g.trailer.x + 30;
  it.y = t.g.trailer.y;
  assert(t.api.tryHook() && t.g.chain[0] === it, 'hook failed');
  t.run(1.5, ['up']);
  assert(it.state === 'hooked' && it.x < t.g.trailer.x - 20, `box x=${it.x.toFixed(0)} trailer x=${t.g.trailer.x.toFixed(0)}`);
});

check('車尾貼牆時勾貨，停著不動不會把貨拉進牆', () => {
  const t = load();
  t.fresh(1.5 + 4 / 32, 10.5, 0);
  const it = t.g.items.find((i) => i.kind === 'box' && i.state === 'loose');
  it.x = t.g.trailer.x + 30;
  it.y = t.g.trailer.y;
  assert(t.api.tryHook(), 'hook failed');
  t.run(90 / 60, []);
  assert(t.g.chain.length === 1 && it.state === 'hooked', `chain=${t.g.chain.length} state=${it.state}`);
  t.run(1.5, ['up']);
  assert(t.g.chain.length === 1 && it.x < t.g.trailer.x - 20, `after driving off: chain=${t.g.chain.length} box x=${it.x.toFixed(0)} trailer x=${t.g.trailer.x.toFixed(0)}`);
});

// Repro from manual play: rear against the west wall at (1,17), hook the sofa at (2,17), wait, drive off.
check('車尾貼牆勾沙發後開走，沙發不會因停車點貼牆而脫落', () => {
  const t = load();
  t.fresh(44 / 32, 560 / 32, -342 * Math.PI / 180);
  const sofa = t.g.items.find((i) => i.kind === 'sofa' && i.x === 2.5 * t.TILE && i.y === 17.5 * t.TILE);
  assert(t.api.tryHook() && t.g.chain[0] === sofa, 'did not hook the sofa');
  t.run(1.5, []);
  t.run(50 / 60, ['up']);
  assert(t.g.chain.length === 1 && sofa.state === 'hooked', `chain=${t.g.chain.length} flash=${t.g.flashText}`);
  t.run(1.5, ['up']);
  assert(sofa.state === 'hooked', 'dropped later while driving away');
});

check('斜頂牆且一直按住前進時，可靠轉向脫困（空車與滿載）', () => {
  const escape = (load5) => {
    const t = load();
    t.fresh(8, 16.5, 60 * Math.PI / 180);
    if (load5) {
      t.attach(['fridge', 'fridge', 'fridge', 'fridge', 'fridge']);
      t.g.chain.forEach((i) => { i.grace = 99; }); // isolate the trailer's escape from cargo drops
    }
    t.run(2, ['up']);
    const pinned = { x: t.g.trailer.x, y: t.g.trailer.y };
    assert(t.g.trailer.speed === 0 && pinned.y > 19 * t.TILE - 13, `not pinned (y=${pinned.y.toFixed(1)})`);
    // Keep holding forward the whole time; steer away from the bottom wall.
    t.api.keys.clear();
    t.api.keys.add('up');
    t.api.keys.add('left');
    let frames = 0;
    while (frames < 240 && pinned.y - t.g.trailer.y < 24) { t.api.step(1 / 60); frames++; }
    t.api.keys.clear();
    assert(pinned.y - t.g.trailer.y >= 24, `${load5 ? 'loaded' : 'empty'} trailer still pinned after ${frames} frames`);
    return frames;
  };
  const empty = escape(false);
  const loaded = escape(true);
  assert(loaded > empty, `cargo weight should slow the pivot (empty ${empty}f, loaded ${loaded}f)`);
});

// Same corner, start angle and load as the manual browser runs: start position, Up+Right for 14 frames,
// hold Up until pinned, then add Left. Empty ≈0.32 s; full load (5 fridges, weight 25) ≈2 s.
check('原地轉速：空車維持約 0.32 秒、滿載約 2 秒脫困；放開前進也能轉', () => {
  const scenario = (loaded, releaseUp) => {
    const t = load();
    t.api.startRound();
    if (loaded) {
      t.g.items.filter((i) => i.kind === 'fridge').forEach((it, i) => { it.x = t.g.trailer.x - 20 - i * 4; it.y = t.g.trailer.y; });
      for (let i = 0; i < 5; i++) t.api.tryHook();
      assert(t.g.chain.length === 5, 'setup: not fully loaded');
    }
    t.api.keys.add('up');
    t.api.keys.add('right');
    for (let i = 0; i < 14; i++) t.api.step(1 / 60);
    t.api.keys.delete('right');
    let f = 0;
    while (f < 300 && !(t.g.trailer.wallStuck && t.g.trailer.speed === 0 && f > 20)) { t.api.step(1 / 60); f++; }
    assert(t.g.trailer.wallStuck, 'setup: never pinned');
    const pin = { x: t.g.trailer.x, y: t.g.trailer.y, a: t.g.trailer.angle };
    for (let i = 0; i < 30; i++) t.api.step(1 / 60);
    if (releaseUp) t.api.keys.delete('up');
    t.api.keys.add('left');
    if (releaseUp) {
      const ref = { x: t.g.trailer.x, y: t.g.trailer.y, a: t.g.trailer.angle };
      for (let i = 0; i < 30; i++) t.api.step(1 / 60);
      return { turned: ref.a - t.g.trailer.angle, moved: Math.hypot(t.g.trailer.x - ref.x, t.g.trailer.y - ref.y) };
    }
    let n = 0;
    while (n < 400 && Math.hypot(t.g.trailer.x - pin.x, t.g.trailer.y - pin.y) <= 24) { t.api.step(1 / 60); n++; }
    return { frames: n };
  };
  const empty = scenario(false, false).frames;
  const full = scenario(true, false).frames;
  assert(empty >= 16 && empty <= 22, `empty took ${empty} frames (expected ~19 ≈ 0.32 s)`);
  assert(full >= 105 && full <= 140, `full load took ${full} frames (expected ~125 ≈ 2 s)`);

  // Up released while pinned: arrows alone still pivot in place, at the weight-scaled pivot rate.
  const e = scenario(false, true);
  const l = scenario(true, true);
  assert(e.moved < 1 && l.moved < 1, `moved while pivoting without throttle (${e.moved}, ${l.moved})`);
  assert(Math.abs(e.turned - 1.36 * 0.5) < 0.05, `empty pivot turned ${e.turned.toFixed(3)} rad in 0.5 s`);
  assert(Math.abs(l.turned - (1.36 / 1.25) * 0.5) < 0.05, `full pivot turned ${l.turned.toFixed(3)} rad in 0.5 s`);
});

check('沒頂牆時靜止不會原地轉向', () => {
  const t = load();
  t.fresh(9.5, 4.5, 0);
  t.api.keys.add('left');
  for (let i = 0; i < 60; i++) t.api.step(1 / 60);
  assert(t.g.trailer.angle === 0, `angle=${t.g.trailer.angle}`);
});

check('倒數結束：進結算、鎖輸入、最高分只在更高時覆寫', () => {
  const t = load({ 'gmmc.bestScore': '500' });
  t.api.startRound();
  t.g.score = 120;
  t.g.timeLeft = 0.05;
  t.run(0.2, []);
  assert(t.g.mode === 'over', `mode=${t.g.mode}`);
  assert(t.store['gmmc.bestScore'] === '500', `overwritten with ${t.store['gmmc.bestScore']}`);
  assert(!t.elements['screen-over'].classList.contains('hidden'), 'result screen hidden');

  const x = t.g.trailer.x;
  t.api.keys.add('up');
  t.api.step(1 / 60);
  assert(t.g.trailer.x === x && t.api.tryHook() === false, 'input not locked');

  t.api.startRound();
  t.g.score = 777;
  t.g.timeLeft = 0.05;
  t.run(0.2, []);
  assert(t.store['gmmc.bestScore'] === '777', `best=${t.store['gmmc.bestScore']}`);
  assert(t.elements['over-best'].textContent === '777', 'result screen best not updated');
});

check('再玩一次：所有狀態回初始', () => {
  const t = load();
  t.api.startRound();
  t.fresh(9.5, 2.5);
  t.api.tryHook();
  t.g.score = 50;
  t.g.timeLeft = 0.01;
  t.run(0.1, []);
  t.api.keys.add('left');
  t.elements['btn-restart'].click();
  assert(t.g.mode === 'playing' && t.g.timeLeft === 60 && t.g.score === 0 && t.g.delivered === 0, 'counters not reset');
  assert(t.g.chain.length === 0 && t.api.keys.size === 0, 'chain or keys left over');
  assert(t.g.items.length === 14 && t.g.items.every((i) => i.state === 'loose' && i.cooldown === 0), 'items not reset');
  assert(t.g.trailer.x === 9.5 * t.TILE && t.g.trailer.y === 4.5 * t.TILE, 'trailer not at start');
});

for (const [ok, msg] of results) process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${msg}\n`);
const failed = results.filter(([ok]) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exitCode = failed ? 1 : 0;

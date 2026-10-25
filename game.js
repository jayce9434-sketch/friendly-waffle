(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  const ui = {
    ballCount: document.getElementById("ballCount"),
    spawnRate: document.getElementById("spawnRate"),
    collisionCount: document.getElementById("collisionCount"),
    collisionRate: document.getElementById("collisionRate"),
    pauseBtn: document.getElementById("pauseBtn"),
    resetBtn: document.getElementById("resetBtn"),
    soundBtn: document.getElementById("soundBtn"),
  };

  // --- Tunables ---
  const START_BALLS = 2;
  const START_RADIUS = 27;
  const MIN_RADIUS = 2.2;          // hard size floor
  const SHRINK_PER_BALL = 0.0085;  // controls how fast all balls shrink
  const BASE_SPEED = 245;
  const MAX_SPEED = 520;
  const RING_RADIUS = 390;
  const RING_LINE = 10;
  const SPAWN_NUDGE = 5;
  const MAX_SUBSTEPS = 3;

  const COLORS = [
    "#ff5d73", "#5db8ff", "#ffd45d", "#7cff8c",
    "#b987ff", "#ff8fe6", "#66f5df", "#ff9c5d"
  ];

  let balls = [];
  let nextBallId = 1;
  let collisionCount = 0;
  let recentSpawns = [];
  let recentCollisions = [];
  let activePairs = new Set();
  let paused = false;
  let soundOn = true;
  let lastTime = performance.now();
  let audioCtx = null;
  let lastSoundAt = 0;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function currentRadius() {
    // Smooth shrink curve. Starts near START_RADIUS and asymptotically reaches MIN_RADIUS.
    const n = Math.max(0, balls.length - START_BALLS);
    return Math.max(MIN_RADIUS, START_RADIUS / (1 + n * SHRINK_PER_BALL));
  }

  function updateAllRadii() {
    const r = currentRadius();
    for (const b of balls) b.r = r;
  }

  function makeBall(x, y, speed = BASE_SPEED, angle = Math.random() * Math.PI * 2) {
    const s = Math.min(MAX_SPEED, speed);
    return {
      id: nextBallId++,
      x, y,
      vx: Math.cos(angle) * s,
      vy: Math.sin(angle) * s,
      r: currentRadius(),
      color: COLORS[(nextBallId - 2) % COLORS.length]
    };
  }

  function reset() {
    balls = [];
    activePairs.clear();
    recentSpawns = [];
    recentCollisions = [];
    collisionCount = 0;
    nextBallId = 1;

    const offset = 110;
    balls.push(makeBall(-offset, 0, BASE_SPEED, 0.55));
    balls.push(makeBall(offset, 0, BASE_SPEED, Math.PI + 0.55));

    updateAllRadii();
    updateUI(performance.now());
  }

  function pairKey(a, b) {
    return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  }

  function playSpawnSound(ballCount) {
    if (!soundOn) return;

    const now = performance.now();
    // Prevent hundreds of overlapping oscillators from murdering audio performance.
    if (now - lastSoundAt < 14) return;
    lastSoundAt = now;

    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return;
      }
    }

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    const pitchDrop = Math.min(220, Math.log2(Math.max(2, ballCount)) * 20);
    osc.type = "sine";
    osc.frequency.setValueAtTime(420 - pitchDrop + Math.random() * 60, t);
    osc.frequency.exponentialRampToValueAtTime(155 + Math.random() * 45, t + 0.055);

    gain.gain.setValueAtTime(0.025, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.075);
  }

  function spawnFromCollision(a, b, now) {
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;

    const side = Math.random() < 0.5 ? -1 : 1;
    const px = -ny * side;
    const py = nx * side;

    const inheritedVX = (a.vx + b.vx) * 0.5;
    const inheritedVY = (a.vy + b.vy) * 0.5;
    const inheritedSpeed = Math.max(
      BASE_SPEED * 0.82,
      Math.min(MAX_SPEED, Math.hypot(inheritedVX, inheritedVY) * 0.85 + 55)
    );

    const angle = Math.atan2(py, px) + rand(-0.5, 0.5);
    const newBall = makeBall(
      mx + px * SPAWN_NUDGE,
      my + py * SPAWN_NUDGE,
      inheritedSpeed,
      angle
    );

    balls.push(newBall);
    updateAllRadii();

    recentSpawns.push(now);
    playSpawnSound(balls.length);
  }

  function resolveBallCollision(a, b) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distSq = dx * dx + dy * dy;
    const minDist = a.r + b.r;

    if (distSq === 0) {
      dx = 0.0001;
      dy = 0;
      distSq = dx * dx;
    }

    if (distSq >= minDist * minDist) return false;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;

    // Positional correction to stop balls from remaining embedded.
    const overlap = minDist - dist;
    const push = overlap * 0.5 + 0.02;
    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;

    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const velAlongNormal = rvx * nx + rvy * ny;

    if (velAlongNormal < 0) {
      // Equal mass, almost-elastic impulse.
      const restitution = 0.985;
      const impulse = -(1 + restitution) * velAlongNormal * 0.5;

      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;

      capSpeed(a);
      capSpeed(b);
    }

    return true;
  }

  function capSpeed(b) {
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    } else if (speed < 60) {
      const k = 60 / Math.max(speed, 0.0001);
      b.vx *= k;
      b.vy *= k;
    }
  }

  function resolveWall(b) {
    const maxCenterDist = RING_RADIUS - RING_LINE * 0.5 - b.r;
    const d = Math.hypot(b.x, b.y);

    if (d <= maxCenterDist || d === 0) return;

    const nx = b.x / d;
    const ny = b.y / d;

    b.x = nx * maxCenterDist;
    b.y = ny * maxCenterDist;

    const velNormal = b.vx * nx + b.vy * ny;
    if (velNormal > 0) {
      b.vx -= 2 * velNormal * nx;
      b.vy -= 2 * velNormal * ny;
      b.vx *= 0.997;
      b.vy *= 0.997;
    }

    capSpeed(b);
  }

  function physicsStep(dt, now) {
    for (const b of balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      resolveWall(b);
    }

    // Spatial hash keeps collision checks much faster than naïve O(n²) at higher counts.
    const r = currentRadius();
    const cellSize = Math.max(8, r * 2.15);
    const grid = new Map();

    function cellKey(cx, cy) {
      return `${cx},${cy}`;
    }

    for (const b of balls) {
      const cx = Math.floor((b.x + RING_RADIUS) / cellSize);
      const cy = Math.floor((b.y + RING_RADIUS) / cellSize);
      const key = cellKey(cx, cy);
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, bucket = []);
      bucket.push(b);
    }

    const touchingThisStep = new Set();

    for (const [key, bucket] of grid) {
      const [cx, cy] = key.split(",").map(Number);

      for (const a of bucket) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const other = grid.get(cellKey(cx + ox, cy + oy));
            if (!other) continue;

            for (const b of other) {
              if (a.id >= b.id) continue;

              const keyAB = pairKey(a, b);
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const sumR = a.r + b.r;

              if (dx * dx + dy * dy <= sumR * sumR) {
                touchingThisStep.add(keyAB);
                const isNewContact = !activePairs.has(keyAB);

                if (resolveBallCollision(a, b) && isNewContact) {
                  collisionCount++;
                  recentCollisions.push(now);
                  spawnFromCollision(a, b, now);
                }
              }
            }
          }
        }
      }
    }

    activePairs = touchingThisStep;
  }

  function updateUI(now) {
    const cutoff = now - 1000;

    while (recentSpawns.length && recentSpawns[0] < cutoff) recentSpawns.shift();
    while (recentCollisions.length && recentCollisions[0] < cutoff) recentCollisions.shift();

    ui.ballCount.textContent = balls.length.toLocaleString();
    ui.spawnRate.textContent = recentSpawns.length.toFixed(1);
    ui.collisionCount.textContent = collisionCount.toLocaleString();
    ui.collisionRate.textContent = recentCollisions.length.toFixed(1);
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const scale = w / 900;

    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);

    // soft interior glow
    const glow = ctx.createRadialGradient(0, 0, 40, 0, 0, RING_RADIUS + 35);
    glow.addColorStop(0, "rgba(255,255,255,0.025)");
    glow.addColorStop(0.78, "rgba(255,255,255,0.01)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, RING_RADIUS + 28, 0, Math.PI * 2);
    ctx.fill();

    // ring
    ctx.lineWidth = RING_LINE;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.shadowColor = "rgba(255,255,255,.26)";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // balls
    for (const b of balls) {
      const grad = ctx.createRadialGradient(
        b.x - b.r * 0.36, b.y - b.r * 0.42, b.r * 0.12,
        b.x, b.y, b.r
      );
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.18, b.color);
      grad.addColorStop(1, b.color);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(300, Math.floor(Math.min(rect.width, rect.height) * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  function frame(now) {
    resizeCanvas();

    const rawDt = Math.min(0.035, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;

    if (!paused) {
      // More substeps when dt is larger to reduce tunneling.
      const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(rawDt / 0.012)));
      const dt = rawDt / substeps;

      for (let i = 0; i < substeps; i++) {
        physicsStep(dt, now);
      }
    }

    updateUI(now);
    draw();
    requestAnimationFrame(frame);
  }

  ui.pauseBtn.addEventListener("click", () => {
    paused = !paused;
    ui.pauseBtn.textContent = paused ? "RESUME" : "PAUSE";
  });

  ui.resetBtn.addEventListener("click", () => {
    reset();
    paused = false;
    ui.pauseBtn.textContent = "PAUSE";
  });

  ui.soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    ui.soundBtn.textContent = `SOUND: ${soundOn ? "ON" : "OFF"}`;
    ui.soundBtn.setAttribute("aria-pressed", String(soundOn));
    if (soundOn && audioCtx?.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  });

  // Wake audio on first intentional interaction.
  window.addEventListener("pointerdown", () => {
    if (!soundOn) return;
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
  }, { once: true });

  // Prevent iOS double-tap zoom behavior on the game surface.
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  reset();
  requestAnimationFrame(frame);
})();

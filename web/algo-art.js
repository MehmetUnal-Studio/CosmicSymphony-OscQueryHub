/*!
 * algo-art.js — ambient generative background (flow-field + mouse attractor)
 * Drop-in, dependency-free.
 *
 * Usage:
 *   <script src="algo-art.js" defer></script>
 *   <script src="algo-art.js"
 *     data-particles="70" data-opacity="0.55" data-hue="170"
 *     data-attract="0.35" data-fade="0.08" defer></script>
 *
 * API:
 *   window.AlgoArt.start() / .stop() / .update({particles, opacity, hue, ...})
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    particles: 70,
    opacity: 0.55,
    hue: 170,
    hueSpread: 30,
    attract: 0.35,
    fade: 0.08,
    mix: 'screen',
    zIndex: 0,
    bg: 'rgba(3,3,10,0.08)',
    radiusHalo: 140,
    smoothing: 0.06,
    fieldScale: 0.0018,    // flow-field grain
    fieldDriftSpeed: 0.0006,
    speedCap: 1.6,
    respectReducedMotion: true
  };

  function readDataAttrs(script) {
    if (!script) return {};
    var d = script.dataset, out = {};
    ['particles', 'opacity', 'hue', 'hueSpread', 'attract',
     'fade', 'zIndex', 'radiusHalo', 'smoothing', 'speedCap']
      .forEach(function (k) { if (d[k] != null) out[k] = parseFloat(d[k]); });
    if (d.mix) out.mix = d.mix;
    if (d.bg)  out.bg  = d.bg;
    return out;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function AlgoArt(userOpts) {
    var opts = Object.assign({}, DEFAULTS, userOpts || {});
    var cvs, ctx, raf = 0, running = false;
    var W = 0, H = 0, dpr = 1;
    var mouse = { x: 0, y: 0, tx: 0, ty: 0, active: false };
    var particles = [];
    var hidden = false;

    function isReducedMotion() {
      return opts.respectReducedMotion &&
        typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function ensureCanvas() {
      cvs = document.getElementById('algo-art-bg');
      if (!cvs) {
        cvs = document.createElement('canvas');
        cvs.id = 'algo-art-bg';
        cvs.setAttribute('aria-hidden', 'true');
        document.body.prepend(cvs);
      }
      Object.assign(cvs.style, {
        position: 'fixed', inset: '0',
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: String(opts.zIndex),
        opacity: String(opts.opacity),
        mixBlendMode: opts.mix
      });
      ctx = cvs.getContext('2d', { alpha: true });

      // Lift static body children above the canvas.
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el === cvs) return;
        var pos = getComputedStyle(el).position;
        if (pos === 'static') {
          el.style.position = 'relative';
          if (!el.style.zIndex) el.style.zIndex = '1';
        }
      });
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      cvs.width  = Math.floor(W * dpr);
      cvs.height = Math.floor(H * dpr);
      cvs.style.width  = W + 'px';
      cvs.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Repaint background once after resize so we don't see torn frames.
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, W, H);
    }

    function spawnParticles() {
      var isMobile = W < 768;
      var n = Math.round(opts.particles * (isMobile ? 0.55 : 1));
      particles.length = 0;
      for (var i = 0; i < n; i++) {
        particles.push({
          x: Math.random() * W,
          y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          h: opts.hue + (Math.random() * opts.hueSpread - opts.hueSpread / 2),
          life: Math.random() * 200 + 80
        });
      }
    }

    // Cheap pseudo-noise (no perlin lib needed). Smooth in space + time.
    function field(x, y, t) {
      var s = opts.fieldScale;
      // Layered sines → smooth, divergence-free-ish flow.
      var a = Math.sin((x + t * 60) * s) + Math.cos((y - t * 50) * s * 1.3);
      var b = Math.cos((x - t * 40) * s * 0.7) + Math.sin((y + t * 30) * s * 1.1);
      // Map to angle in [0, 2π).
      return (a * 0.5 + b * 0.3) * Math.PI;
    }

    function step(now) {
      if (!running) return;
      raf = requestAnimationFrame(step);
      if (hidden) return;

      var t = now * opts.fieldDriftSpeed;

      // Trail fade — paint a translucent rect over the whole canvas.
      ctx.fillStyle = opts.bg.replace(/[\d.]+\)$/, opts.fade + ')');
      ctx.fillRect(0, 0, W, H);

      // Smooth mouse follow.
      mouse.x += (mouse.tx - mouse.x) * opts.smoothing;
      mouse.y += (mouse.ty - mouse.y) * opts.smoothing;

      // Optional radial halo around cursor.
      if (mouse.active && opts.radiusHalo > 0) {
        var grad = ctx.createRadialGradient(
          mouse.x, mouse.y, 0,
          mouse.x, mouse.y, opts.radiusHalo
        );
        grad.addColorStop(0, 'hsla(' + opts.hue + ',80%,55%,0.10)');
        grad.addColorStop(1, 'hsla(' + opts.hue + ',80%,55%,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(
          mouse.x - opts.radiusHalo, mouse.y - opts.radiusHalo,
          opts.radiusHalo * 2, opts.radiusHalo * 2
        );
      }

      var attract = opts.attract;
      var cap = opts.speedCap;

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];

        // Flow-field steering.
        var ang = field(p.x, p.y, t);
        p.vx += Math.cos(ang) * 0.04;
        p.vy += Math.sin(ang) * 0.04;

        // Mouse attractor (smooth, distance-weighted).
        if (mouse.active && attract > 0) {
          var dx = mouse.x - p.x, dy = mouse.y - p.y;
          var d2 = dx * dx + dy * dy;
          if (d2 > 1 && d2 < 90000) {            // 300px range
            var d = Math.sqrt(d2);
            var f = attract * (1 - d / 300) * 0.05;
            p.vx += (dx / d) * f;
            p.vy += (dy / d) * f;
          }
        }

        // Friction + cap.
        p.vx *= 0.96; p.vy *= 0.96;
        var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (sp > cap) { p.vx = p.vx / sp * cap; p.vy = p.vy / sp * cap; }

        var nx = p.x + p.vx;
        var ny = p.y + p.vy;

        // Draw segment so we get a soft trail when fade < 1.
        ctx.strokeStyle = 'hsla(' + p.h + ',75%,60%,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();

        p.x = nx; p.y = ny;

        // Wrap to opposite edge → continuous field.
        if (p.x < -10) p.x = W + 10;
        else if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10;
        else if (p.y > H + 10) p.y = -10;

        // Re-spawn occasionally to refresh the field.
        if (--p.life <= 0) {
          p.x = Math.random() * W;
          p.y = Math.random() * H;
          p.vx = (Math.random() - 0.5) * 0.4;
          p.vy = (Math.random() - 0.5) * 0.4;
          p.life = Math.random() * 200 + 80;
        }
      }
    }

    function onMouseMove(e) {
      mouse.tx = e.clientX;
      mouse.ty = e.clientY;
      if (!mouse.active) {
        mouse.x = mouse.tx; mouse.y = mouse.ty;
        mouse.active = true;
      }
    }
    function onMouseLeave() { mouse.active = false; }
    function onVisibility() { hidden = document.hidden; }
    function onResize() { resize(); spawnParticles(); }

    function start() {
      if (running) return;
      if (isReducedMotion()) return;            // honor reduced motion
      ensureCanvas();
      resize();
      spawnParticles();
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      window.addEventListener('mouseleave', onMouseLeave);
      window.addEventListener('resize', onResize, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);
      running = true;
      raf = requestAnimationFrame(step);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (cvs && cvs.parentNode) cvs.parentNode.removeChild(cvs);
      cvs = null; ctx = null;
    }

    function update(patch) {
      if (!patch) return;
      Object.assign(opts, patch);
      if (cvs) {
        cvs.style.opacity = String(opts.opacity);
        cvs.style.zIndex  = String(opts.zIndex);
        cvs.style.mixBlendMode = opts.mix;
      }
      if (running && (patch.particles != null)) spawnParticles();
    }

    return { start: start, stop: stop, update: update,
             get options() { return Object.assign({}, opts); } };
  }

  // Auto-init from the script tag's dataset.
  function autoInit() {
    var script = document.currentScript ||
                 document.querySelector('script[src*="algo-art"]');
    var fromAttrs = readDataAttrs(script);
    var inst = AlgoArt(fromAttrs);
    root.AlgoArt = inst;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inst.start);
    } else {
      inst.start();
    }
  }

  autoInit();
})(window);

(() => {
    'use strict';

    /* ======================================================================
       Purple rain, drawn on a canvas behind the to-do card.
       - 3 depth layers (far / mid / near): speed, length and brightness differ
       - Wind that slowly gusts, so the slant drifts
       - Drops land on the top edge of the card and on the ground, and splash
       - A rare, soft lightning glow
       - The rain never stops: with "reduce motion" on it just slows and calms
       - Adapts to the device: fewer drops on small or slow screens, and it
         thins itself out automatically if the frame rate drops
       - The cloud button in the card switches it on and off (remembered)
       Everything is tuned from CONFIG.
       ====================================================================== */

    const CONFIG = {
        density: 5500,          // px² of screen per drop (lower = heavier rain)
        minDrops: 30,
        maxDrops: 420,
        windBase: 0.16,         // average slant (0 = straight down)
        windGust: 0.07,         // how far the wind drifts either side of that
        splashes: true,         // drops splash on the card's top edge and the ground
        lightning: true,        // soft glow now and then
        lightningEvery: [9000, 22000], // ms between flashes (min, max)
        flashStrength: 0.16,    // brightest point of a flash (0 to 1)
        calmSpeed: 0.5,         // speed multiplier when the device asks for reduced motion
        storageKey: 'haru-rain',
    };

    const LAYERS = [
        // far: deep purple, faint
        { share: 0.50, speed: [7, 10],  len: [8, 14],  width: 0.8, color: 'rgba(147,51,234,0.40)',  glow: 0,  splash: 0 },
        // mid: vivid violet
        { share: 0.32, speed: [11, 15], len: [14, 22], width: 1.1, color: 'rgba(168,85,247,0.62)',  glow: 6,  splash: 0.45 },
        // near: bright lilac with a purple glow
        { share: 0.18, speed: [16, 22], len: [22, 34], width: 1.5, color: 'rgba(216,180,254,0.90)', glow: 12, splash: 1 },
    ].map((layer) => ({ ...layer, drops: [] }));

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const card = document.querySelector('.todo-app');
    const toggle = document.querySelector('#rain-toggle');

    const canvas = document.createElement('canvas');
    canvas.className = 'rain';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // very old browser: skip the rain, the app still works

    const sparks = [];          // splash particles
    const MAX_SPARKS = 140;
    const deviceFactor = (navigator.hardwareConcurrency || 8) <= 4 ? 0.7 : 1; // lighter on weak devices

    let w = 0, h = 0;
    let wind = CONFIG.windBase;
    let raf = null, last = 0;
    let nextFlash = 0, flashStart = -1;
    let quality = 1;            // drops itself if the device can't keep up
    let perfFrames = 0, perfSum = 0, warmup = 0;
    let enabled = true;

    const rand = (min, max) => min + Math.random() * (max - min);
    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

    /* ---------- Drops ---------- */

    /** (Re)initialise a drop. `scatter` spreads them over the whole screen. */
    function spawn(layer, scatter, d = {}) {
        d.speed = rand(...layer.speed);
        d.len = rand(...layer.len);
        d.x = rand(-h * 0.3, w);   // start left of the screen too, as wind pushes drops right
        d.y = scatter ? rand(-h * 0.1, h) : -rand(d.len, h * 0.15);
        return d;
    }

    /** Add or trim drops to match the screen size, without resetting the rest. */
    function syncCount() {
        const total = clamp(
            Math.round(((w * h) / CONFIG.density) * quality * deviceFactor),
            CONFIG.minDrops,
            CONFIG.maxDrops
        );
        for (const layer of LAYERS) {
            const target = Math.round(total * layer.share);
            while (layer.drops.length < target) layer.drops.push(spawn(layer, true));
            layer.drops.length = Math.min(layer.drops.length, target);
        }
    }

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 600 ? 1.5 : 2);
        w = window.innerWidth;
        h = window.innerHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round';
        syncCount();
    }

    /* ---------- Splashes ---------- */

    function splash(x, y, count, power) {
        for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
            const angle = -Math.PI / 2 + rand(-0.95, 0.95);
            const speed = rand(0.8, 2.4) * power;
            sparks.push({
                x, y,
                vx: Math.cos(angle) * speed + wind,
                vy: Math.sin(angle) * speed,
                age: 0,
                life: rand(14, 26),
                r: rand(0.6, 1.4),
            });
        }
    }

    function drawSparks(dt) {
        ctx.fillStyle = 'rgb(216,180,254)';
        for (let i = sparks.length - 1; i >= 0; i--) {
            const s = sparks[i];
            s.vy += 0.14 * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.age += dt;
            if (s.age >= s.life) {
                sparks[i] = sparks[sparks.length - 1];
                sparks.pop();
                continue;
            }
            ctx.globalAlpha = 0.6 * (1 - s.age / s.life);
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    /* ---------- Lightning ---------- */

    function drawFlash(t) {
        if (!CONFIG.lightning || motion.matches) return;
        if (t >= nextFlash) {
            flashStart = t;
            nextFlash = t + rand(...CONFIG.lightningEvery);
        }
        if (flashStart < 0) return;

        const age = t - flashStart;
        if (age > 1400) {
            flashStart = -1;
            return;
        }
        // quick rise, slow fade, only one flash at a time
        const alpha = CONFIG.flashStrength * Math.min(1, age / 50) * Math.exp(-age / 300);
        ctx.fillStyle = `rgba(168,85,247,${alpha.toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
    }

    /* ---------- Performance guard ---------- */

    /** If frames keep taking too long, quietly thin the rain out. */
    function watchPerformance(rawDt) {
        if (warmup < 45) { warmup++; return; }
        perfSum += rawDt;
        if (++perfFrames < 90) return;

        const average = perfSum / perfFrames; // 1 = a perfect 60fps frame
        perfFrames = 0;
        perfSum = 0;
        if (average > 1.7 && quality > 0.35) {
            quality *= 0.75;
            syncCount();
        }
    }

    /* ---------- Frame loop ---------- */

    function frame(t) {
        const rawDt = Math.min((t - last) / 16.667 || 1, 4);
        const dt = Math.min(rawDt, 3) * (motion.matches ? CONFIG.calmSpeed : 1); // 1 = one 60fps frame
        last = t;
        watchPerformance(rawDt);

        wind = CONFIG.windBase
            + Math.sin(t * 0.00031) * CONFIG.windGust
            + Math.sin(t * 0.0009 + 2) * CONFIG.windGust * 0.5;

        ctx.clearRect(0, 0, w, h);
        drawFlash(t);

        // The card's top edge acts as a ledge that catches rain
        const box = card ? card.getBoundingClientRect() : null;
        const ledge = CONFIG.splashes && box && box.width > 0 && box.top > 0 && box.top < h;
        const ledgeTop = ledge ? box.top : 0;
        const ledgeLeft = ledge ? box.left + 10 : 0;
        const ledgeRight = ledge ? box.right - 10 : 0;
        const norm = Math.hypot(wind, 1);

        for (const layer of LAYERS) {
            ctx.lineWidth = layer.width;
            ctx.strokeStyle = layer.color;
            ctx.shadowColor = 'rgba(168,85,247,0.95)';
            ctx.shadowBlur = layer.glow;
            ctx.beginPath();

            for (const d of layer.drops) {
                const prevY = d.y;
                d.x += wind * d.speed * dt;
                d.y += d.speed * dt;

                if (ledge && prevY < ledgeTop && d.y >= ledgeTop && d.x > ledgeLeft && d.x < ledgeRight) {
                    if (Math.random() < layer.splash) splash(d.x, ledgeTop, 3, 0.7);
                    spawn(layer, false, d);
                    continue;
                }
                if (d.y > h) {
                    if (CONFIG.splashes && Math.random() < layer.splash) splash(d.x, h - 2, 3, 1);
                    spawn(layer, false, d);
                    continue;
                }
                if (d.x > w + 40) {
                    spawn(layer, false, d);
                    continue;
                }

                const k = d.len / norm;
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x - wind * k, d.y - k);
            }
            ctx.stroke();
        }

        ctx.shadowBlur = 0;
        drawSparks(dt);
        raf = requestAnimationFrame(frame);
    }

    /* ---------- Start / stop + the on/off button ---------- */

    function start() {
        canvas.style.display = '';
        if (raf !== null) return;
        last = performance.now();
        nextFlash = last + rand(5000, 12000);
        warmup = 0;
        raf = requestAnimationFrame(frame);
    }

    function stop() {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = null;
        canvas.style.display = 'none';
    }

    function setEnabled(on, remember = true) {
        enabled = on;
        on ? start() : stop();
        if (toggle) {
            toggle.setAttribute('aria-pressed', String(on));
            toggle.setAttribute('aria-label', on ? 'Turn rain off' : 'Turn rain on');
        }
        if (remember) {
            try { localStorage.setItem(CONFIG.storageKey, on ? 'on' : 'off'); } catch { /* ignore */ }
        }
    }

    let saved = 'on';
    try { saved = localStorage.getItem(CONFIG.storageKey) || 'on'; } catch { /* ignore */ }

    resize();
    window.addEventListener('resize', resize);
    toggle?.addEventListener('click', () => setEnabled(!enabled));
    setEnabled(saved !== 'off', false);
})();
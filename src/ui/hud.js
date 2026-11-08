export function createHUD({ onEnter, onNext, onEnterStop, onDirectory, onProgramme }) {
  const loader = document.getElementById('loader');
  const startScreen = document.getElementById('start-screen');
  const enterBtn = document.getElementById('enter-btn');
  const caption = document.getElementById('caption');
  const hints = document.querySelector('.hints');
  const dpad = document.getElementById('dpad');
  const body = document.body;

  const actNo = document.querySelector('.act-no');
  const actName = document.querySelector('.act-name');
  const stopNo = document.querySelector('.stop-no');
  const stopLabel = document.querySelector('.stop-text b');
  const stopEn = document.querySelector('.stop-text em');
  const railItems = [...document.querySelectorAll('.rail-item')];
  const nextBtn = document.getElementById('next-stop');
  const nextLabel = document.getElementById('next-label');
  const nextKicker = document.querySelector('.next-kicker');
  const enterStop = document.getElementById('enter-stop');
  const enterLabel = document.getElementById('enter-stop-label');
  const programmeBtn = document.getElementById('programme-btn');
  const guideBtn = document.getElementById('guide-btn');

  let started = false;
  let captionTimer = 0;
  let moveHandler = null;
  let activityShown = false;
  let nextId = null;
  let currentZone = null;
  let enterId = null;
  const swapTimers = new WeakMap();

  function enter() {
    if (started) return;
    started = true;
    onEnter?.();
  }

  enterBtn.addEventListener('click', enter);

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (nextId) onNext?.(nextId);
    });
  }

  if (enterStop) {
    enterStop.addEventListener('click', () => {
      if (enterId && enterStop.classList.contains('is-on')) onEnterStop?.(enterId);
    });
  }

  if (programmeBtn) {
    programmeBtn.addEventListener('click', () => (onProgramme || onDirectory)?.());
  }

  if (guideBtn) {
    guideBtn.addEventListener('click', () => onDirectory?.());
  }

  function ready() {
    body.dataset.phase = 'entrance';
    loader.setAttribute('aria-hidden', 'true');
    // 重新触发开场文字的入场动画
    if (startScreen) {
      const animated = startScreen.querySelectorAll(
        '.start-overline, .start-title, .start-rule, .start-sub, .enter-btn, .start-hint'
      );
      animated.forEach((el) => {
        el.style.animation = 'none';
      });
      void startScreen.offsetWidth;
      animated.forEach((el) => {
        el.style.animation = '';
      });
    }
  }

  function setPhase(phase) {
    body.dataset.phase = phase;
  }

  function swapText(el, text) {
    if (!el || el.textContent === text) return;
    el.classList.add('is-swap');
    window.clearTimeout(swapTimers.get(el));
    swapTimers.set(
      el,
      window.setTimeout(() => {
        el.textContent = text;
        el.classList.remove('is-swap');
        swapTimers.delete(el);
      }, 200)
    );
  }

  function setZone(zone, announce = true) {
    if (!zone || currentZone === zone.id) return;
    currentZone = zone.id;

    if (actNo) swapText(actNo, zone.act);
    if (actName) swapText(actName, zone.label);
    if (stopNo) swapText(stopNo, zone.no);
    if (stopLabel) swapText(stopLabel, zone.label);
    if (stopEn) swapText(stopEn, zone.en);

    railItems.forEach((item) => {
      item.classList.toggle('is-active', item.dataset.stop === zone.id);
      item.classList.toggle('is-upcoming', Boolean(zone.next) && item.dataset.stop === zone.next);
    });

    if (announce) showCaption(`${zone.label} · ${zone.caption}`, 5200);
  }

  function setNext(target, visible) {
    if (!nextBtn) return;
    if (!target) {
      nextBtn.classList.remove('is-on');
      nextBtn.setAttribute('aria-hidden', 'true');
      return;
    }
    if (nextId !== target.id) {
      nextId = target.id;
      if (nextLabel) nextLabel.textContent = target.label;
      if (nextKicker && target.kicker) nextKicker.textContent = target.kicker;
      nextBtn.setAttribute('aria-label', `${target.kicker || '前往'}${target.label}`);
    }
    nextBtn.classList.toggle('is-on', visible);
    nextBtn.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function setEnterPrompt(target, visible) {
    if (!enterStop) return;
    if (!target) {
      enterStop.classList.remove('is-on');
      enterStop.setAttribute('aria-hidden', 'true');
      return;
    }
    if (target.id !== enterId) {
      enterId = target.id;
      if (enterLabel) enterLabel.textContent = target.label;
      enterStop.dataset.kind = target.label === '站点导览' ? 'guide' : 'note';
      enterStop.setAttribute('aria-label', `打开${target.label}`);
    }
    enterStop.classList.toggle('is-on', visible);
    enterStop.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function showCaption(text, duration = 4600) {
    if (!caption) return;
    window.clearTimeout(captionTimer);
    caption.textContent = text;
    // 先收起再出现，形成呼吸式过渡
    caption.classList.remove('is-on');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => caption.classList.add('is-on'));
    });
    captionTimer = window.setTimeout(() => caption.classList.remove('is-on'), duration);
  }

  function noteActivity() {
    if (activityShown || !hints) return;
    activityShown = true;
    hints.classList.add('is-dim');
  }

  // 进入漫游几秒后由 main 触发：操作提示自行淡出
  function dimHints() {
    if (!hints) return;
    hints.classList.add('is-dim');
    activityShown = true;
  }

  function bindDpad(handler) {
    moveHandler = handler;
    if (!dpad) return;
    dpad.querySelectorAll('.pad').forEach((btn) => {
      const dir = btn.dataset.move;
      const set = (active) => {
        btn.classList.toggle('is-active', active);
        moveHandler?.(dir, active);
        if (active) noteActivity();
      };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        set(true);
      });
      const off = (e) => {
        e.preventDefault();
        set(false);
      };
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.code)) {
      noteActivity();
    }
  });

  return { ready, setPhase, setZone, setNext, setEnterPrompt, showCaption, bindDpad, noteActivity, dimHints, enter };
}

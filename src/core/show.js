/* ============================================================
   演出态调度：开场三遍铃 + 主光递减 + 脚光/台口渐起 + 开幕。
   只改灯的光强与幕布变换，不新增灯位，不动材质基线。
   日常态 ↔ 演出态可来回切换；退出时灯回到日常值。
   ============================================================ */
import { tween, easeInOutSine, easeOutCubic } from './anim.js';

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createShow({ world, audio }) {
  // 降低动态效果时，整段序列压到 55% 时长，幕布弹簧也更快
  const speed = () => (reducedMotion() ? 0.55 : 1);

  let mode = 'daily'; // daily | preshow | show
  let house = 1;
  let stage = 1;
  let curtainOpen = true;
  const timers = [];

  const apply = () => world.auditorium.setShow({ house, stage });
  apply();

  function clearTimers() {
    while (timers.length) clearTimeout(timers.pop());
  }

  function fadeLevels(from, to, duration) {
    const h0 = from.house, h1 = to.house;
    const s0 = from.stage, s1 = to.stage;
    tween({
      duration,
      ease: easeInOutSine,
      onUpdate: (v) => {
        house = h0 + (h1 - h0) * v;
        stage = s0 + (s1 - s0) * v;
        apply();
      }
    });
  }

  // 开场前的三遍铃：主光在铃声里慢慢收，脚光与台口渐起；铃落开幕
  function startPreshow() {
    if (mode !== 'daily') return false;
    mode = 'preshow';
    const k = speed();
    clearTimers();

    setCurtain(false);
    audio?.fabric(2.4 * k);

    fadeLevels({ house, stage }, { house: 0.34, stage: 1.12 }, 7.6 * k);

    timers.push(setTimeout(() => audio?.bell(1), 30));
    timers.push(setTimeout(() => audio?.bell(0.86), 2700 * k));
    timers.push(setTimeout(() => audio?.bell(0.72), 5350 * k));
    timers.push(setTimeout(() => {
      mode = 'show';
      setCurtain(true);
      audio?.fabric(5.0 * k);
    }, 7600 * k));
    return true;
  }

  // 退出演出：灯回到日常，幕布保持当前状态
  function endShow() {
    if (mode === 'daily') return false;
    mode = 'daily';
    clearTimers();
    fadeLevels({ house, stage }, { house: 1, stage: 1 }, 1.5 * speed());
    return true;
  }

  function toggle() {
    return mode === 'daily' ? startPreshow() : endShow();
  }

  function setCurtain(open) {
    curtainOpen = !!open;
    world.auditorium.setCurtain(curtainOpen);
  }

  function toggleCurtain() {
    setCurtain(!curtainOpen);
    audio?.fabric(4.0 * speed());
    return curtainOpen;
  }

  return {
    startPreshow,
    endShow,
    toggle,
    toggleCurtain,
    isShow: () => mode === 'show',
    getMode: () => mode,
    getCurtainOpen: () => curtainOpen
  };
}

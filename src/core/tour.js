import * as THREE from 'three';
import { tween, easeInOutCubic, easeInOutSine, updateTweens } from './anim.js';
import {
  NAV,
  STOP_BY_ID,
  PORTRAIT_POSE,
  routeBetween,
  constrainWalk,
  LEVEL_GROUND,
  LEVEL_UPPER
} from './stops.js';

/* ==================================================================
   转场路径的净距约束
   障碍模型直接复用 stops.js 的可行走区：区域之外就是墙体、门套、
   台座、座椅排、走桥两侧与楼梯栏板。沿候选路径等弧长采样，把越界
   的点拉回可行走区并留出侧向余量；门洞附近收敛到洞口中线；竖向
   贴着地面标高走，避免穿楼板。速度按净距做时间重映射：窄处减速，
   宽处回升，两端仍由原有的 easeInOutCubic 收住，不会急停。
   ================================================================== */
const EYE = 1.64;
const SAFE_MARGIN = 0.3;
const PATH_SAMPLES = 180;
const LEVEL_SPLIT_Y = 3.4;
const PROBE_STEP = 0.08;
const PROBE_MAX = 1.4;

const smooth01 = (t) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};
const levelAtY = (y) => (y > LEVEL_SPLIT_Y ? LEVEL_UPPER : LEVEL_GROUND);

/* 门洞中线：axis 是要对齐的坐标，at 是中线值，gate 是洞口所在位置，
   range 是沿行进方向的生效范围，reach 是横向接近阈值，level 限定楼层。
   只有真正走到洞口附近的路径才会被收正，避免隔着一堵墙误吸。 */
const DOOR_GATES = [
  { label: '门厅拱门', axis: 'x', at: 0, gate: -16.98, range: 1.15, reach: 2.0, level: LEVEL_GROUND },
  { label: '后台过道', axis: 'x', at: 4.6, gate: -58.5, range: 1.05, reach: 1.6, level: LEVEL_GROUND },
  { label: '绘景棚门', axis: 'x', at: 9.9, gate: -58.15, range: 0.9, reach: 1.6, level: LEVEL_GROUND },
  { label: '办公室门', axis: 'z', at: -64.7, gate: -8.59, range: 0.6, reach: 1.2, level: LEVEL_GROUND },
  { label: '放映厅门', axis: 'z', at: -25.6, gate: -2.62, range: 0.55, reach: 1.2, level: LEVEL_UPPER },
  { label: '右包厢门', axis: 'z', at: -40.82, gate: 6.24, range: 0.55, reach: 1.2, level: LEVEL_UPPER },
  { label: '左包厢门', axis: 'z', at: -40.82, gate: -6.24, range: 0.55, reach: 1.2, level: LEVEL_UPPER }
];

/* 侧向净距：从采样点沿 8 个方向探到可行走区边界。
   只用路径法向会在凹角处读到 0，斜向能正确量到墙角距离，
   同时给出最宽的一侧作为避让方向。 */
function probeDir(x, z, dx, dz, level) {
  let d = 0;
  for (let s = PROBE_STEP; s <= PROBE_MAX + 1e-6; s += PROBE_STEP) {
    const c = constrainWalk(x + dx * s, z + dz * s, level);
    if (!c || c.d > 0.012) break;
    d = s;
  }
  return d;
}

const DIAG = Math.SQRT1_2;

function clearanceAt(x, z, tx, tz, level, full = true) {
  const nx = -tz;
  const nz = tx;
  // 第一遍只量左右两侧，够用且快；最后一遍量 8 个方向给出验收净距
  const dirs = full
    ? [
        [nx, nz],
        [-nx, -nz],
        [tx, tz],
        [-tx, -tz],
        [(nx + tx) * DIAG, (nz + tz) * DIAG],
        [(nx - tx) * DIAG, (nz - tz) * DIAG],
        [(-nx + tx) * DIAG, (-nz + tz) * DIAG],
        [(-nx - tx) * DIAG, (-nz - tz) * DIAG]
      ]
    : [
        [nx, nz],
        [-nx, -nz]
      ];
  let min = Infinity;
  let mx = 1;
  let mz = 0;
  for (const [dx, dz] of dirs) {
    const d = probeDir(x, z, dx, dz, level);
    if (d < min) {
      min = d;
      mx = dx;
      mz = dz;
    }
  }
  // 沿离墙最近的那个方向的反向退让，而不是挑最空的方向，
  // 否则贴着墙角时可能沿墙平移，净距不增反降
  return { min, bx: -mx, bz: -mz };
}

/* 等弧长折线：采样点即动画采样点，位置与验收读数完全一致 */
class ArcPath {
  constructor(points) {
    this.points = points;
    this.cum = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += points[i].distanceTo(points[i - 1]);
      this.cum.push(total);
    }
    this.length = total;
  }

  locate(d) {
    const cum = this.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    return { i: lo, j: hi, t: (d - cum[lo]) / span };
  }

  getPointAt(u, target = new THREE.Vector3()) {
    const d = Math.max(0, Math.min(1, u)) * this.length;
    const { i, j, t } = this.locate(d);
    return target.copy(this.points[i]).lerp(this.points[j], t);
  }
}

function applyDoorGates(pts, base) {
  const N = pts.length - 1;
  for (const g of DOOR_GATES) {
    for (let i = 0; i <= N; i++) {
      const p = pts[i];
      if (levelAtY(base[i].y) !== g.level) continue;
      const along = Math.abs(g.axis === 'x' ? p.z - g.gate : p.x - g.gate);
      const lateral = Math.abs(g.axis === 'x' ? p.x - g.at : p.z - g.at);
      if (along >= g.range || lateral >= g.reach) continue;
      const edge = smooth01(Math.min(i, N - i) / Math.max(1, N * 0.05));
      const w = smooth01(1 - along / g.range) * 0.94 * edge;
      if (g.axis === 'x') p.x += (g.at - p.x) * w;
      else p.z += (g.at - p.z) * w;
    }
  }
}

/* 回到可行走区、留出侧向余量，并给出每点净距 */
function enforceSafe(pts, base, margin, full = true) {
  const N = pts.length - 1;
  const clearances = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const level = levelAtY(base[i].y);
    const c = constrainWalk(p.x, p.z, level);
    if (c && c.d > 0.001) {
      p.x = c.x;
      p.z = c.z;
    }
    const a = base[Math.max(0, i - 1)];
    const b = base[Math.min(N, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    let cl = clearanceAt(p.x, p.z, tx, tz, level, full);
    clearances[i] = cl.min;
    const edge = smooth01(Math.min(i, N - i) / Math.max(1, N * 0.04));
    if (edge <= 0) continue;
    // 凹角处一次退让不一定够（最近边界可能在斜向），最多迭代三次
    for (let k = 0; k < 3 && cl.min < margin; k++) {
      const prev = cl.min;
      const push = (margin - cl.min) * 0.95 * edge;
      const qx = p.x + cl.bx * push;
      const qz = p.z + cl.bz * push;
      const qc = constrainWalk(qx, qz, level);
      if (!qc || qc.d > 0.002) break;
      p.x = qx;
      p.z = qz;
      // 记录避让后的真实净距，验收读数才与最终路径一致
      cl = clearanceAt(p.x, p.z, tx, tz, level, full);
      clearances[i] = cl.min;
      if (cl.min <= prev + 0.005) break;
    }
  }
  return clearances;
}

/* 平滑侧向修正，端点保持不动，避免把落点挪走 */
function smoothOffsets(base, pts, radius, passes) {
  const N = pts.length - 1;
  const ox = new Float32Array(N + 1);
  const oz = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    ox[i] = pts[i].x - base[i].x;
    oz[i] = pts[i].z - base[i].z;
  }
  ox[0] = oz[0] = ox[N] = oz[N] = 0;
  for (let pass = 0; pass < passes; pass++) {
    const sx = Float32Array.from(ox);
    const sz = Float32Array.from(oz);
    for (let i = 1; i < N; i++) {
      let ax = 0;
      let az = 0;
      let wsum = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.max(0, Math.min(N, i + k));
        const w = 1 - Math.abs(k) / (radius + 1);
        ax += ox[j] * w;
        az += oz[j] * w;
        wsum += w;
      }
      sx[i] = ax / wsum;
      sz[i] = az / wsum;
    }
    ox.set(sx);
    oz.set(sz);
    ox[0] = oz[0] = ox[N] = oz[N] = 0;
  }
  for (let i = 0; i <= N; i++) {
    pts[i].x = base[i].x + ox[i];
    pts[i].z = base[i].z + oz[i];
  }
}

/* 竖向贴合地面：不低于地面 + 眼高，越界的坡道落差做平滑 */
function applyFloorHeight(pts, base) {
  const N = pts.length - 1;
  const floor = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const level = levelAtY(base[i].y);
    const c = constrainWalk(pts[i].x, pts[i].z, level);
    const fy = c ? c.y : 0;
    floor[i] = fy;
    // 相机严格贴地面走：路线点本来就等于地面 + 眼高，
    // 用 max 会在下坡段把镜头吊在空中
    pts[i].y = fy + EYE;
  }
  for (let pass = 0; pass < 2; pass++) {
    const sy = pts.map((p) => p.y);
    for (let i = 1; i < N; i++) {
      pts[i].y = (sy[i - 1] + sy[i] * 2 + sy[i + 1]) / 4;
    }
    pts[0].y = sy[0];
    pts[N].y = sy[N];
  }
  for (let i = 1; i < N; i++) {
    pts[i].y = Math.max(pts[i].y, floor[i] + 1.45);
  }
  pts[0].y = base[0].y;
  pts[N].y = base[N].y;
}

/* 净距 → 时间重映射：窄处慢、宽处快；两端交还给 easing */
function buildWarp(clearances) {
  const N = clearances.length - 1;
  const speed = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = smooth01((clearances[i] - 0.42) / 0.55);
    let f = 0.58 + 0.42 * t;
    const edge = Math.min(i, N - i) / Math.max(1, N * 0.09);
    if (edge < 1) f = 1 - (1 - f) * smooth01(edge);
    speed[i] = f;
  }
  const cum = new Float32Array(N + 1);
  for (let i = 1; i <= N; i++) {
    cum[i] = cum[i - 1] + 1 / Math.max(0.2, (speed[i] + speed[i - 1]) / 2);
  }
  const total = cum[N] || 1;
  for (let i = 0; i <= N; i++) cum[i] /= total;
  return (v) => {
    const t = Math.max(0, Math.min(1, v));
    let lo = 0;
    let hi = N;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1;
    return (lo + (t - cum[lo]) / span) / N;
  };
}

function measureSamples(pts, clearances) {
  const N = pts.length - 1;
  let clip = 0;
  let worstOut = 0;
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const c = constrainWalk(p.x, p.z, levelAtY(p.y));
    if (!c || c.d > 0.02) {
      clip += 1;
      worstOut = Math.max(worstOut, c ? c.d : 9);
    }
  }
  // 采样点之间的弦也要查：两帧之间的穿墙同样算穿模
  for (let i = 0; i < N; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const level = levelAtY(a.y);
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      const c = constrainWalk(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, level);
      if (!c || c.d > 0.02) {
        clip += 1;
        worstOut = Math.max(worstOut, c ? c.d : 9);
      }
    }
  }
  let minClear = Infinity;
  for (let i = 2; i < N - 1; i++) minClear = Math.min(minClear, clearances[i]);
  const doorOffsets = [];
  let doorMax = 0;
  let doorLabel = '';
  for (const g of DOOR_GATES) {
    let m = 0;
    let nearest = Infinity;
    for (let i = 0; i <= N; i++) {
      const p = pts[i];
      if (levelAtY(p.y) !== g.level) continue;
      const along = Math.abs(g.axis === 'x' ? p.z - g.gate : p.x - g.gate);
      const lateral = Math.abs(g.axis === 'x' ? p.x - g.at : p.z - g.at);
      if (along >= g.range * 0.6) continue;
      nearest = Math.min(nearest, lateral);
      m = Math.max(m, lateral);
    }
    // 只有真正从这个洞口通过的路线才计入，隔着墙的缺口不算
    if (nearest > 1.0) continue;
    doorOffsets.push({ label: g.label, offset: +m.toFixed(2) });
    if (m > doorMax) {
      doorMax = m;
      doorLabel = g.label;
    }
  }
  return {
    minClearance: +minClear.toFixed(2),
    clipFrames: clip,
    frames: N + 1 + N * 3,
    worstOutside: +worstOut.toFixed(2),
    doorMax: +doorMax.toFixed(2),
    doorLabel,
    doorOffsets
  };
}

function buildSafePath(raw, fromPos, toPos) {
  const N = PATH_SAMPLES;
  const base = [];
  for (let i = 0; i <= N; i++) base.push(raw.getPointAt(i / N));
  base[0].copy(fromPos);
  base[N].copy(toPos);
  const pts = base.map((p) => p.clone());

  applyDoorGates(pts, base);
  enforceSafe(pts, base, SAFE_MARGIN, false);
  smoothOffsets(base, pts, 5, 3);
  const clearances = enforceSafe(pts, base, SAFE_MARGIN, true);
  applyFloorHeight(pts, base);

  const path = new ArcPath(pts);
  return { path, warp: buildWarp(clearances), metrics: measureSamples(pts, clearances) };
}

export class Tour {
  constructor({ camera, rig, world, onPhase, onEntered, onArrived }) {
    this.camera = camera;
    this.rig = rig;
    this.world = world;
    this.onPhase = onPhase;
    this.onEntered = onEntered;
    this.onArrived = onArrived;
    this.playing = false;
    this.started = false;
    this.progress = 0;
    this.travelTween = null;
    // 竖屏单独取景：转场与落点都把视线压平，避免一抬头就只剩吊灯
    this.portrait = false;
  }

  /* 竖屏落点：保持机位与朝向，把注视点压到接近水平，
     让地面、主体与顶部同时进画面；横屏原样返回 */
  restLook(pos, look) {
    if (!this.portrait) return look.clone();
    const dx = look.x - pos.x;
    const dz = look.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return look.clone();
    const pitch = 0.045;
    return new THREE.Vector3(pos.x + dx, pos.y + Math.tan(pitch) * dist, pos.z + dz);
  }

  // 由注视点求水平朝向（俯仰归零）
  static yawOf(pos, look) {
    const dx = look.x - pos.x;
    const dz = look.z - pos.z;
    if (Math.hypot(dx, dz) < 1e-5) return 0;
    return Math.atan2(-dx, -dz);
  }

  // 落点俯仰：横屏用原注视点，竖屏用压平后的注视点
  static pitchOf(pos, look) {
    const d = new THREE.Vector3().subVectors(look, pos);
    const len = d.length();
    if (len < 1e-5) return 0;
    return Math.max(-0.24, Math.min(0.3, Math.asin(d.y / len)));
  }

  // 推门 → 穿过门洞 → 落入门厅
  start() {
    if (this.started) return;
    this.started = true;
    this.playing = true;
    this.onPhase?.('cinematic');

    const startPos = this.camera.position.clone();
    // 竖屏：入场一路走到长廊中段，让拱门帷幔成为落点主体
    const portrait = this.portrait;
    const endPos = portrait ? PORTRAIT_POSE.foyer.position : [0, 1.64, -3.0];
    const endLookRaw = portrait ? PORTRAIT_POSE.foyer.target : [0, 4.15, -16.0];
    const path = new THREE.CatmullRomCurve3(
      [
        startPos,
        new THREE.Vector3(0, 1.62, 5.2),
        new THREE.Vector3(0, 1.63, 2.3),
        new THREE.Vector3(0, 1.635, 0.35),
        new THREE.Vector3(0, 1.64, -1.9),
        new THREE.Vector3(0, 1.64, portrait ? -4.6 : -2.6),
        ...(portrait ? [new THREE.Vector3(0, 1.64, -7.8), new THREE.Vector3(0, 1.64, -11.2)] : []),
        new THREE.Vector3(...endPos)
      ],
      false,
      'centripetal'
    );

    const lookPath = new THREE.CatmullRomCurve3(
      this.portrait
        ? [
            new THREE.Vector3(0, 2.2, 0.3),
            new THREE.Vector3(0, 2.1, -2.4),
            new THREE.Vector3(0, 2.0, -7.0),
            new THREE.Vector3(0, 2.0, -12.0),
            new THREE.Vector3(...endLookRaw)
          ]
        : [
            new THREE.Vector3(0, 2.7, 0.3),
            new THREE.Vector3(0, 2.95, -2.4),
            new THREE.Vector3(0, 3.55, -6.8),
            new THREE.Vector3(0, 4.02, -12.0),
            new THREE.Vector3(0, 4.15, -16.0)
          ],
      false,
      'centripetal'
    );

    const look = new THREE.Vector3();

    tween({
      duration: 1.75,
      delay: 0.08,
      ease: easeInOutCubic,
      onUpdate: (v) => this.world.entrance.setOpen(v)
    });

    tween({
      duration: 2.5,
      delay: 0.45,
      ease: easeInOutSine,
      onUpdate: (v) => this.world.setInterior(0.32 + 0.68 * v)
    });

    tween({
      duration: 2.2,
      delay: 0.35,
      ease: easeInOutSine,
      onUpdate: (v) => this.world.setExterior(1 - 0.72 * v)
    });

    tween({
      duration: portrait ? 4.9 : 3.55,
      delay: 0.55,
      ease: easeInOutCubic,
      onUpdate: (v) => {
        this.progress = v;
        const p = path.getPoint(v);
        this.camera.position.copy(p);
        look.copy(lookPath.getPoint(v));
        this.camera.lookAt(look);
      },
      onComplete: () => {
        this.playing = false;
        this.progress = 1;
        const finalPos = new THREE.Vector3(...endPos);
        const finalLook = this.restLook(finalPos, new THREE.Vector3(...endLookRaw));
        this.camera.position.copy(finalPos);
        this.camera.lookAt(finalLook);
        this.rig.setPose(finalPos, finalLook);
        this.rig.setEnabled(true);
        this.onPhase?.('explore');
        this.onArrived?.('foyer');
        this.onEntered?.();
      }
    });
  }

  /* 由当前机位生成一次转场的全部数据：候选曲线 + 避让后的采样路径。
     不改变 playing 状态，供 travelTo 与验收测量共用。 */
  buildTravel(id, route = null) {
    const nav = NAV[id];
    const stop = STOP_BY_ID[id];
    const target = nav || (stop && stop.ready ? { pose: stop.pose, via: [], bounds: stop.bounds } : null);
    if (!target || !target.pose) return null;

    const fromPos = this.camera.position.clone();
    const fromDir = this.camera.getWorldDirection(new THREE.Vector3());
    const fromYaw = Math.atan2(-fromDir.x, -fromDir.z);
    const fromPitch = this.camera.rotation.x;
    const toPos = new THREE.Vector3(...((this.portrait && PORTRAIT_POSE[id]?.position) || target.pose.position));
    const toLook = this.restLook(
      toPos,
      new THREE.Vector3(...((this.portrait && PORTRAIT_POSE[id]?.target) || target.pose.target))
    );
    const toYaw = Tour.yawOf(toPos, toLook);
    const destPitch = Tour.pitchOf(toPos, toLook);

    const explicit = Array.isArray(route) && route.length > 0;
    const forward = toPos.z < fromPos.z;
    // 地面层之间移动时不绕上二楼；只有上楼或从楼座下来才走楼梯段
    const highPath = fromPos.y > 3.4 || toPos.y > 3.4;
    const via = explicit
      ? route.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
      : (target.via || [])
        .filter((p) => highPath || p[1] < 3.4)
        .filter(([, , z]) => (forward ? z < fromPos.z - 0.4 && z > toPos.z + 0.4 : z > fromPos.z + 0.4 && z < toPos.z - 0.4))
        .map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    if (!explicit && !forward) via.reverse();

    const points = [fromPos, ...via, toPos];
    let raw = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    raw.arcLengthDivisions = 320;
    // 下层通道进深较浅，去重后可能只剩很少点；退化时用直线段兜底
    if (points.length < 3) raw = new THREE.LineCurve3(fromPos, toPos);

    const safe = buildSafePath(raw, fromPos, toPos);
    return {
      id,
      fromPos,
      toPos,
      toLook,
      fromYaw,
      fromPitch,
      toYaw,
      destPitch,
      path: safe.path,
      warp: safe.warp,
      metrics: safe.metrics
    };
  }

  /* 验收用：从某个站点出发，返回该段转场的净距与穿模读数 */
  debugRoute(fromId, toId) {
    const from = NAV[fromId] || STOP_BY_ID[fromId];
    if (!from || !from.pose) return null;
    const savedPos = this.camera.position.clone();
    const savedRot = this.camera.rotation.clone();
    const savedPortrait = this.portrait;
    this.portrait = false;
    this.camera.position.set(...from.pose.position);
    const look = new THREE.Vector3(...(from.pose.target || from.pose.position));
    this.camera.lookAt(look);
    const plan = this.buildTravel(toId, routeBetween(fromId, toId));
    this.camera.position.copy(savedPos);
    this.camera.rotation.copy(savedRot);
    this.portrait = savedPortrait;
    if (!plan) return null;
    return {
      from: fromId,
      to: toId,
      length: +plan.path.length.toFixed(2),
      duration: +Math.min(7.2, Math.max(2.4, plan.path.length / 3.0)).toFixed(2),
      ...plan.metrics
    };
  }

  // 后续阶段：沿主动线走向下一个停靠点；显式 route 时按给定点走，不做朝向过滤
  travelTo(id, route = null) {
    if (this.playing) return false;
    const plan = this.buildTravel(id, route);
    if (!plan) return false;

    this.playing = true;
    this.onPhase?.('cinematic');

    const { path, warp, fromYaw, fromPitch, toYaw, destPitch, toPos, toLook } = plan;
    const duration = Math.min(7.2, Math.max(2.4, path.length / 3.0));

    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();

    /* 水平朝向采样：只取路径在 XZ 平面的切线，绝不带 y 分量，
       因此行进过程中镜头不会因为上楼梯或爬坡而抬起来。
       采样后做角度解缠，避免 ±π 处翻转。 */
    const SAMPLES = 48;
    const yawSamples = new Array(SAMPLES + 1);
    yawSamples[0] = fromYaw;
    for (let i = 1; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      path.getPointAt(Math.min(1, u), pA);
      path.getPointAt(Math.min(1, u + 0.004), pB);
      const dx = pB.x - pA.x;
      const dz = pB.z - pA.z;
      let y = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(-dx, -dz) : yawSamples[i - 1];
      while (y - yawSamples[i - 1] > Math.PI) y -= Math.PI * 2;
      while (y - yawSamples[i - 1] < -Math.PI) y += Math.PI * 2;
      yawSamples[i] = y;
    }
    // 终点朝向同样解缠到与路径末端同一分支，收尾不回摆
    let endYaw = toYaw;
    while (endYaw - yawSamples[SAMPLES] > Math.PI) endYaw -= Math.PI * 2;
    while (endYaw - yawSamples[SAMPLES] < -Math.PI) endYaw += Math.PI * 2;

    const smooth01Local = (t) => {
      const u = Math.max(0, Math.min(1, t));
      return u * u * (3 - 2 * u);
    };

    this.rig.setEnabled(false);
    const levelStart = performance.now();

    tween({
      duration,
      ease: easeInOutCubic,
      onUpdate: (v) => {
        // 净距重映射：窄处减速通过，宽处回升；两端仍由 easing 收住
        const u = warp(v);
        path.getPointAt(u, pA);
        this.camera.position.copy(pA);

        const f = Math.min(1, Math.max(0, u)) * SAMPLES;
        const i0 = Math.floor(f);
        const i1 = Math.min(SAMPLES, i0 + 1);
        const yawPath = yawSamples[i0] + (yawSamples[i1] - yawSamples[i0]) * (f - i0);

        // 起步：从当前视线转到行进方向；末段：并入站点正式朝向
        const ws = Math.pow(Math.max(0, 1 - v / 0.2), 2);
        const we = smooth01Local((u - 0.6) / 0.4);
        const wa = Math.max(0.02, 1 - ws - we);
        const total = ws + we + wa;
        const yaw = (fromYaw * ws + yawPath * wa + endYaw * we) / total;

        // 前 0.32 秒把残余俯仰抹平，之后整段行进严格水平（与缓动进度无关）
        const level = (performance.now() - levelStart) / 1000;
        const pitch = fromPitch * (1 - smooth01Local(level / 0.32));
        this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
      },
      onComplete: () => {
        this.camera.position.copy(toPos);
        this.camera.rotation.set(0, endYaw, 0, 'YXZ');
        // 到达后用极短的过渡把水平视线升/压到该站的正式注视点
        tween({
          duration: 0.28,
          ease: (t) => 1 - Math.pow(1 - t, 3),
          onUpdate: (t) => this.camera.rotation.set(destPitch * t, endYaw, 0, 'YXZ'),
          onComplete: () => {
            this.playing = false;
            this.rig.eyeHeight = toPos.y;
            this.rig.setPose(toPos, toLook);
            this.rig.setEnabled(true);
            this.onArrived?.(id);
            this.onPhase?.('explore');
          }
        });
      }
    });

    return true;
  }
}

export { updateTweens };

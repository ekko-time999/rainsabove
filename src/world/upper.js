import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxBatch, addGlowSprite, makeContactMaterial, mergeStatic } from './utils.js';
import { seatGeometry } from './auditorium.js';

/* ---------- 二楼标高与平面控制线 ----------
   楼座踏面与既有包厢挑台（y=4.03）同高，走廊、楼座与包厢由此连成一条连续的上层动线。 */
const LEVEL = 4.03;
const DECK_TOP = LEVEL - 0.012;   // 比既有包厢挑台低一线，避免共面闪烁
const SLAB = 0.28;   // 做实楼板厚度，板底由檐口线脚收边

const STAIR_BOTTOM = -7.0;
const STAIR_TOP = -15.35;
const STEPS = 24;
const FLIGHT = 12;
const TREAD = 0.3;
const RISE = LEVEL / STEPS;          // 0.1679m，踏高落在 0.16–0.18 区间
const FLIGHT_RUN = FLIGHT * TREAD;   // 3.6m
const LAND_Y = FLIGHT * RISE;        // 2.015m，中间休息平台
const LAND_DEPTH = 1.15;
const LAND_Z0 = STAIR_BOTTOM - FLIGHT_RUN;              // -10.60
const LAND_Z1 = LAND_Z0 - LAND_DEPTH;                   // -11.75
const F2_Z0 = LAND_Z1;                                  // 第二段起步
const STAIR_X = 5.925;
const FLIGHT_LEN = Math.hypot(FLIGHT_RUN, LAND_Y);
const STAIR_SLOPE = Math.atan2(LAND_Y, FLIGHT_RUN);

const GALLERY_FRONT = -15.35;
const GALLERY_BACK = -16.36;
const CORR_BACK = -30.6;

const DECK_BACK = -31.15;   // 观众席后墙的观众侧墙面
const DECK_FRONT = -36.2;   // 楼座挑台前缘
const BAL_HALF = 8.9;
const PROM_INNER = 6.9;
const PROM_END = -47.2;

const BOX_Z = [-34.4, -39.0, -43.6];
const ROWS = [
  { z: -33.8, y: LEVEL },
  { z: -32.75, y: LEVEL + 0.28 },
  { z: -31.72, y: LEVEL + 0.55 }
];

/* 轻量壁灯：只在批量金件上挂一枚光晕，避免像门厅壁灯那样增加十余个网格 */
function addSmallSconce(gold, glows, mats, parent, x, y, z, rotY, scale = 0.46) {
  gold.add(0.06, 0.34, 0.16, x, y, z, rotY);
  gold.add(0.16, 0.05, 0.12, x, y + 0.16, z, rotY);
  const dir = rotY === Math.PI ? -1 : 1;
  const glow = addGlowSprite(mats, parent, x + dir * 0.13, y + 0.14, z, scale, 0.5);
  glows.push(glow);
  return glow;
}

/* 二楼环廊：draw call 预算 10（静置机位实测 7）。
   这里多是独一份的材料，合并不动它。 */
export function buildUpper(scene, mats, quality) {
  const group = new THREE.Group();
  scene.add(group);

  const full = quality.tier === 'full';

  const gold = new BoxBatch(mats.gold);
  const goldDeep = new BoxBatch(mats.goldDeep);
  const wood = new BoxBatch(mats.wood, { castShadow: full });
  const marble = new BoxBatch(mats.marble);
  const velvet = new BoxBatch(mats.velvetWall);
  const glows = [];
  const lights = [];

  /* ---------- 门厅大楼梯：两侧对称，中途休息平台后升到二楼 ---------- */
  for (const sign of [-1, 1]) {
    const cx = sign * STAIR_X;

    // 第一段：12 级，踏高 0.1679、踏宽 0.30
    for (let i = 1; i <= FLIGHT; i++) {
      const h = i * RISE;
      const z = STAIR_BOTTOM - (i - 0.5) * TREAD;
      wood.add(1.65, h, TREAD + 0.018, cx, h / 2, z);
      gold.add(1.69, 0.026, 0.042, cx, h + 0.008, STAIR_BOTTOM - (i - 1) * TREAD - 0.015);
      goldDeep.add(1.67, 0.018, 0.026, cx, h - 0.03, STAIR_BOTTOM - (i - 1) * TREAD - 0.02);
    }

    // 中间休息平台：1.15m 进深，标高 2.015m
    wood.add(1.65, LAND_Y, LAND_DEPTH, cx, LAND_Y / 2, (LAND_Z0 + LAND_Z1) / 2);
    gold.add(1.69, 0.026, LAND_DEPTH, cx, LAND_Y + 0.008, (LAND_Z0 + LAND_Z1) / 2);
    goldDeep.add(1.67, 0.018, LAND_DEPTH, cx, LAND_Y - 0.03, LAND_Z0 - 0.02);

    // 第二段：12 级，从平台升到二楼 4.03m
    for (let i = 1; i <= FLIGHT; i++) {
      const h = LAND_Y + i * RISE;
      const z = F2_Z0 - (i - 0.5) * TREAD;
      wood.add(1.65, h, TREAD + 0.018, cx, h / 2, z);
      gold.add(1.69, 0.026, 0.042, cx, h + 0.008, F2_Z0 - (i - 1) * TREAD - 0.015);
      goldDeep.add(1.67, 0.018, 0.026, cx, h - 0.03, F2_Z0 - (i - 1) * TREAD - 0.02);
    }

    // 斜梁与扶手：两段同坡，平台上另做一段水平扶手
    for (const [zc, yc] of [[(STAIR_BOTTOM + LAND_Z0) / 2, LAND_Y / 2], [(F2_Z0 + STAIR_TOP) / 2, (LAND_Y + LEVEL) / 2]]) {
      wood.add(0.13, 0.34, FLIGHT_LEN, sign * 5.07, yc + 0.1, zc, 0, STAIR_SLOPE);
      gold.add(0.07, 0.07, FLIGHT_LEN, sign * 5.07, yc + 0.98, zc, 0, STAIR_SLOPE);
      goldDeep.add(0.09, 0.03, FLIGHT_LEN, sign * 5.07, yc + 0.91, zc, 0, STAIR_SLOPE);
    }
    gold.add(0.07, 0.07, LAND_DEPTH, sign * 5.07, LAND_Y + 0.98, (LAND_Z0 + LAND_Z1) / 2);

    for (const [z0, n, y0] of [[STAIR_BOTTOM, FLIGHT, 0], [F2_Z0, FLIGHT, LAND_Y]]) {
      for (let i = 2; i <= n; i += 2) {
        const y = y0 + i * RISE;
        const z = z0 - (i - 0.5) * TREAD;
        gold.add(0.032, 0.78, 0.032, sign * 5.07, y + 0.42, z);
      }
    }
    // 平台上的两根栏杆立柱
    for (const z of [LAND_Z0 - 0.08, LAND_Z1 + 0.08]) {
      gold.add(0.032, 0.78, 0.032, sign * 5.07, LAND_Y + 0.42, z);
    }

    // 起步柱头
    goldDeep.add(0.14, 0.9, 0.14, sign * 5.07, 0.52, STAIR_BOTTOM + 0.08);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 9), mats.gold);
    cap.position.set(sign * 5.07, 1.03, STAIR_BOTTOM + 0.08);
    group.add(cap);

    // 楼梯上方的壁灯，照亮墙面与扶手
    addSmallSconce(gold, glows, mats, group, sign * 6.82, 5.72, -11.6, sign === 1 ? Math.PI : 0, 0.44);

    // 二楼入口引导：梯口一盏落地暖光，踏面上再排一串小灯
    const foot = new THREE.PointLight(0xffae66, 16, 10, 2);
    foot.position.set(sign * 5.9, 2.2, STAIR_BOTTOM + 0.9);
    group.add(foot);
    lights.push({ light: foot, base: 16 });
    glows.push(addGlowSprite(mats, group, sign * 5.92, 1.12, STAIR_BOTTOM + 0.55, 0.85, 0.45));
    for (let i = 3; i <= 21; i += 6) {
      const h = i * RISE;
      const zz = STAIR_BOTTOM - (i - 0.5) * TREAD;
      glows.push(addGlowSprite(mats, group, sign * 5.12, h + 0.08, zz, 0.16, 0.5));
    }
  }

  /* ---------- 门厅尽端的二楼平台：把楼梯与中央拱门接起来 ---------- */
  wood.add(13.5, SLAB, 1.24, 0, LEVEL - SLAB / 2, (GALLERY_FRONT + GALLERY_BACK) / 2);
  gold.add(13.52, 0.05, 0.06, 0, LEVEL, GALLERY_FRONT + 0.005);
  // 挑檐口线脚：板底外挑一圈，把一楼天花收住
  goldDeep.add(13.62, 0.17, 0.32, 0, LEVEL - 0.30, GALLERY_FRONT - 0.03);
  gold.add(13.58, 0.035, 0.36, 0, LEVEL - 0.185, GALLERY_FRONT - 0.03);
  for (let x = -6.2; x <= 6.21; x += 0.9) {
    wood.add(0.3, 0.16, 0.46, x, LEVEL - 0.46, GALLERY_FRONT - 0.2);
  }

  // 平台外沿栏杆，只做中段，两端留给楼梯
  for (let x = -5.02; x <= 5.03; x += 0.42) {
    gold.add(0.032, 0.76, 0.032, x, LEVEL + 0.4, GALLERY_FRONT);
  }
  gold.add(10.2, 0.07, 0.07, 0, LEVEL + 0.82, GALLERY_FRONT);
  goldDeep.add(10.2, 0.06, 0.06, 0, LEVEL + 0.02, GALLERY_FRONT);

  /* ---------- 二楼走廊：叠在既有走廊之上，上下两层同宽 ---------- */
  wood.add(4.52, SLAB, 14.2, 0, LEVEL - SLAB / 2, -23.45);
  wood.add(4.52, SLAB, 0.72, 0, LEVEL - SLAB / 2, -30.9);
  // 靠墙金线：楼板压进墙体，接缝落在墙面以内
  gold.add(0.06, 0.05, 14.2, -2.23, LEVEL, -23.45);
  gold.add(0.06, 0.05, 14.2, 2.23, LEVEL, -23.45);
  // 上层踢脚线：墙面上下一贯通，不被楼板切断（左侧让开放映厅门）
  goldDeep.add(0.07, 0.09, 14.2, 2.19, LEVEL + 0.07, -23.45);
  goldDeep.add(0.07, 0.09, 8.55, -2.19, LEVEL + 0.07, -20.575);
  goldDeep.add(0.07, 0.09, 4.25, -2.19, LEVEL + 0.07, -28.375);
  // 顶角檐口：贴住走廊顶棚
  gold.add(0.08, 0.09, 14.2, 2.19, LEVEL + 2.77, -23.45);
  gold.add(0.08, 0.09, 14.2, -2.19, LEVEL + 2.77, -23.45);
  goldDeep.add(0.11, 0.07, 14.2, 2.19, LEVEL + 2.70, -23.45);
  goldDeep.add(0.11, 0.07, 14.2, -2.19, LEVEL + 2.70, -23.45);

  /* ---------- 楼梯口：门洞与过梁，不做裸露方洞 ----------
     门厅尽端的中央拱洞就是这一层的入口；在走廊内侧再包一道木门套与过梁，
     让洞口从走廊一侧看是“门”，而不是一块被楼板切开的空档。 */
  const PORTAL_Z = -17.34;
  for (const sign of [-1, 1]) {
    wood.add(0.18, 2.52, 0.16, sign * 2.14, LEVEL + 1.26, PORTAL_Z);
    gold.add(0.2, 0.07, 0.2, sign * 2.14, LEVEL + 2.54, PORTAL_Z);
  }
  wood.add(4.44, 0.26, 0.18, 0, LEVEL + 2.57, PORTAL_Z);
  goldDeep.add(4.5, 0.09, 0.24, 0, LEVEL + 2.73, PORTAL_Z);

  const runner = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 14.1), mats.carpet);
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(0, LEVEL + 0.006, -23.45);
  runner.receiveShadow = true;
  group.add(runner);

  // 上层墙面：连续丝绒饰板 + 金框，接在既有拱肋之间
  const panelZ = [-18.4, -23.2, -28.0];
  const panelGeos = [];
  for (const sign of [-1, 1]) {
    for (const z of panelZ) {
      const plane = new THREE.PlaneGeometry(2.6, 1.42);
      plane.rotateY(sign === 1 ? -Math.PI / 2 : Math.PI / 2);
      plane.translate(sign * 2.17, LEVEL + 0.94, z);
      panelGeos.push(plane);

      for (const dz of [-1.32, 1.32]) {
        gold.add(0.05, 1.52, 0.06, sign * 2.15, LEVEL + 0.94, z + dz);
      }
      gold.add(0.05, 0.06, 2.7, sign * 2.15, LEVEL + 1.65, z);
      gold.add(0.05, 0.06, 2.7, sign * 2.15, LEVEL + 0.23, z);
    }
    for (const z of [-20.8, -25.6]) {
      // 西墙 -25.6 正对放映厅门洞，壁灯挪到相邻饰板，避免灯座卡在门中央
      const zz = sign === -1 && z === -25.6 ? -24.2 : z;
      addSmallSconce(gold, glows, mats, group, sign * 2.18, LEVEL + 1.5, zz, sign === 1 ? Math.PI : 0, 0.42);
    }
  }
  const panelMesh = new THREE.Mesh(mergeGeometries(panelGeos, false), mats.velvetWall);
  panelMesh.receiveShadow = true;
  group.add(panelMesh);


  gold.build(group);
  goldDeep.build(group);
  wood.build(group);
  marble.build(group);
  velvet.build(group);

  let level = 1;
  function setLevel(v) {
    level = v;
    lights.forEach(({ light, base }) => {
      light.intensity = base * v;
    });
    glows.forEach((g) => {
      g.material.opacity = (g.userData.baseOpacity || 0.5) * (0.25 + 0.75 * v);
    });
  }
  setLevel(1);

  mergeStatic(group);

  return { group, setLevel, get level() { return level; } };
}

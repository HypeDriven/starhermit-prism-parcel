'use strict';

/**
 * Prism Parcel — render module: Three.js scene graph, semantic entity
 * views, authored camera, lighting, VFX, graphics quality (see gfx.js).
 * Consumes immutable rules snapshots; never mutates rules state.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOARD_SIZE, OFFER_COUNT, pieceById, canPlace } from './rules.js';
import { themeInfo } from './content.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

const CELL = 1;               // world units per board cell
const GAP = 0.08;             // visual gap between blocks
const BOARD_W = BOARD_SIZE * CELL;
const CELL_H = 0.55;
const OFFER_Z = BOARD_W / 2 + 2.2;
const PARTICLE_POOL = { low: 60, high: 360 };
const BURST = { low: 6, high: 12 };
const MOTES = 90;

// Authored camera framing constants (no magic offsets elsewhere).
export const FRAMING = Object.freeze({
  fov: 38,
  distance: 16.5,
  height: 13.5,
  lookAt: new THREE.Vector3(0, 0, 0.5),
  tiltLerp: 0.12
});

// Play area the key light's shadow frustum is fitted to (board + offer row).
const SHADOW_BOX = new THREE.Box3(new THREE.Vector3(-6.8, -0.5, -BOARD_W / 2 - 0.6), new THREE.Vector3(6.8, 1.4, OFFER_Z + 1.8));

const HUES = [0x6fd3ff, 0xff9d6f, 0x9ff06f, 0xff6fb0, 0xffe06f, 0xb09fff];
const HUES_CVD = [0x4cc9f0, 0xf72585, 0xffe169, 0x90be6d, 0xb5179e, 0xf8961e];

// Colour grade + vignette: gentle S-curve, a touch more saturation, cool shadows / warm highlights.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.99, 1.05), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`
};

let gpuCache = null;
/** Unmasked GPU name (best effort) for Auto detection and the settings summary. */
function gpuName(gl) {
  if (gpuCache) return gpuCache;
  let name = '';
  try {
    if (/firefox/i.test(navigator.userAgent)) name = gl.getParameter(gl.RENDERER);
    else {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
  } catch (e) { name = ''; }
  gpuCache = String(name || '');
  return gpuCache;
}

function isMobileDevice() {
  try {
    return (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches) ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  } catch (e) { return false; }
}

/** Deterministic value-noise canvas used for frosted/brushed surface detail. */
function noiseTexture(size, seed, rings) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5, dy = y / size - 0.5;
      const ring = rings ? 0.5 + 0.5 * Math.sin(Math.hypot(dx, dy) * rings) : 0.5;
      const v = Math.round(150 + (rnd() - 0.5) * 70 + (ring - 0.5) * 30);
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Soft round sprite for particles and motes. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.theme = options.theme || 'aurora';
    this.cvdPalette = !!options.cvdPalette;
    this._reducedMotion = !!options.reducedMotion;

    const info = themeInfo(this.theme);
    this.info = info;
    // No canvas MSAA: anti-aliasing is chosen per preset (MSAA runs in the composer target).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.gpu = gpuName(this.renderer.getContext());
    this.detected = detectPreset(this.gpu, isMobileDevice());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(info.bg);
    this.scene.fog = new THREE.Fog(info.bg, 26, 60);

    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 120);
    this.camera.position.set(0, FRAMING.height, FRAMING.distance);
    this.camera.lookAt(FRAMING.lookAt);
    // Layers: 0 environment, 1 gameplay, 2 selection/ghosts, 3 effects — all drawn.
    this.camera.layers.enableAll();

    this._dot = dotTexture();
    this._textures = [];
    this._buildBackdrop(info);
    this._buildLights(info);
    this._buildTable(info);
    this._buildBoard(info);
    this._buildGhost();
    this._buildCursorMarker();
    this._buildParticles();
    this._buildMotes(info);
    this._buildFlashes(info);

    this.offerGroup = new THREE.Group();
    this.offerGroup.position.set(0, 0, OFFER_Z);
    this.scene.add(this.offerGroup);
    this.offerViews = [null, null, null];
    this._selectedSlot = null;
    this._lastOffer = null;

    this._time = 0;
    this._shake = 0;
    this._disposed = false;
    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hitPoint = new THREE.Vector3();

    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this._envTex = null;

    this.setGraphics(options.graphics || {});
    this.resize();
  }

  get reducedMotion() { return this._reducedMotion; }
  set reducedMotion(v) { this._reducedMotion = !!v; this._applyMotion(); }

  /* ---------------------------------------------------------------- */
  /* Scene construction                                                */
  /* ---------------------------------------------------------------- */

  _buildBackdrop(info) {
    // Vertical gradient dome: deep theme colour at the horizon rising to a
    // softly lit ceiling, so the tabletop floats in a luminous room.
    const geo = new THREE.SphereGeometry(80, 32, 16);
    const bottom = new THREE.Color(info.bg).multiplyScalar(0.7);
    const mid = new THREE.Color(info.bg);
    const top = new THREE.Color(info.bg).lerp(new THREE.Color(info.fill), 0.45);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 80;
      if (y < 0) c.copy(mid).lerp(bottom, Math.min(1, -y * 2));
      else c.copy(mid).lerp(top, Math.pow(y, 0.7));
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    this.backdrop = new THREE.Mesh(geo, mat);
    this.backdrop.renderOrder = -1;
    this.scene.add(this.backdrop);
  }

  _buildLights(info) {
    const key = new THREE.DirectionalLight(info.key, 2.4);
    key.position.set(6, 14, 8);
    key.target.position.set(0, 0, 1);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key, key.target);
    this.keyLight = key;
    this._fitShadow();

    this.fill = new THREE.HemisphereLight(info.fill, info.bg, 0.9);
    this.scene.add(this.fill);

    const rim = new THREE.DirectionalLight(info.accent, 0.6);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);
  }

  /** Fit the key light's orthographic shadow frustum tightly around the play area. */
  _fitShadow() {
    const key = this.keyLight;
    const cam = key.shadow.camera;
    cam.position.copy(key.position);
    cam.lookAt(key.target.position);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    const b = SHADOW_BOX, p = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    Object.assign(cam, { left: minX, right: maxX, bottom: minY, top: maxY, near: Math.max(0.1, -maxZ - 1), far: -minZ + 1 });
    cam.updateProjectionMatrix();
  }

  _buildTable(info) {
    // Luminous frosted tabletop: rounded slab + soft glow disc.
    const tableGeo = new THREE.CylinderGeometry(11.5, 12.5, 0.8, 64);
    this.tableMat = new THREE.MeshPhysicalMaterial({
      color: info.table, roughness: 0.55, metalness: 0.15, clearcoat: 0, clearcoatRoughness: 0.5
    });
    const table = new THREE.Mesh(tableGeo, this.tableMat);
    table.position.y = -0.85;
    this.table = table;
    this.scene.add(table);

    const glowGeo = new THREE.CircleGeometry(9, 64);
    const glowMat = new THREE.MeshBasicMaterial({
      color: info.accent, transparent: true, opacity: 0.05, depthWrite: false
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.44;
    this.scene.add(glow);
    this.tableGlow = glowMat;

    this._tableNoise = noiseTexture(256, 7, 0);
    this._tableNoise.repeat.set(5, 5);
    this._textures.push(this._tableNoise);
  }

  _blockMaterial(color, extra = {}) {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.4,
      metalness: 0.02,
      clearcoat: 0.55,
      clearcoatRoughness: 0.32,
      envMapIntensity: 0.6,
      ...extra
    });
  }

  _buildBoard(info) {
    // Base plate under the grid.
    const plateGeo = new THREE.BoxGeometry(BOARD_W + 0.7, 0.3, BOARD_W + 0.7);
    this.plateMat = new THREE.MeshStandardMaterial({ color: 0x0c0f1e, roughness: 0.4, metalness: 0.3 });
    this.plate = new THREE.Mesh(plateGeo, this.plateMat);
    this.plate.position.y = -0.16;
    this.scene.add(this.plate);

    // Thin emissive rim around the plate: a gentle accent line that blooms.
    const half = (BOARD_W + 0.7) / 2;
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: info.accent, emissiveIntensity: 1.25, roughness: 1 });
    this.rimMat = rimMat;
    const rimH = new THREE.BoxGeometry(BOARD_W + 0.78, 0.05, 0.05);
    const rimV = new THREE.BoxGeometry(0.05, 0.05, BOARD_W + 0.78);
    for (const [g, x, z] of [[rimH, 0, -half], [rimH, 0, half], [rimV, -half, 0], [rimV, half, 0]]) {
      const m = new THREE.Mesh(g, rimMat);
      m.position.set(x, -0.01, z);
      this.scene.add(m);
    }

    // Cell sockets (always visible empty wells).
    const socketGeo = new THREE.BoxGeometry(CELL - GAP, 0.06, CELL - GAP);
    this.socketMat = new THREE.MeshStandardMaterial({ color: 0x35407a, roughness: 0.75, metalness: 0.1, emissive: 0x141a3a, emissiveIntensity: 0.6 });
    this.sockets = new THREE.InstancedMesh(socketGeo, this.socketMat, BOARD_SIZE * BOARD_SIZE);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        m.setPosition(this._cx(c), 0.03, this._cz(r));
        this.sockets.setMatrixAt(i++, m);
      }
    }
    this.scene.add(this.sockets);
    this._socketNoise = noiseTexture(128, 11, 0);
    this._textures.push(this._socketNoise);

    // Occupied cells: one InstancedMesh, per-instance colour. A faint
    // self-glow keeps the frosted blocks luminous in shadow.
    this._boxGeo = new THREE.BoxGeometry(CELL - GAP, CELL_H, CELL - GAP);
    this._roundGeo = new RoundedBoxGeometry(CELL - GAP, CELL_H, CELL - GAP, 3, 0.08);
    const cellMat = this._blockMaterial(0xffffff);
    cellMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.06;');
    };
    cellMat.customProgramCacheKey = () => 'pp-cell-glow';
    this.cellMat = cellMat;
    this.cells = new THREE.InstancedMesh(this._boxGeo, cellMat, BOARD_SIZE * BOARD_SIZE);
    this.cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.cells);
    this._cellState = new Int8Array(BOARD_SIZE * BOARD_SIZE); // 0 empty, 1 filled
    this._zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < BOARD_SIZE * BOARD_SIZE; k++) this.cells.setMatrixAt(k, this._zeroMatrix);
    this.cells.instanceMatrix.needsUpdate = true;
  }

  _buildGhost() {
    const geo = new THREE.BoxGeometry(CELL - GAP, 0.3, CELL - GAP);
    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0x9fefff, transparent: true, opacity: 0.35, depthWrite: false
    });
    this.ghost = new THREE.InstancedMesh(geo, this.ghostMat, 9);
    this.ghost.layers.set(2);
    this.scene.add(this.ghost);
    this.hideGhost();
  }

  _buildCursorMarker() {
    // Grounded selection marker ring (keyboard cursor).
    const geo = new THREE.RingGeometry(0.32, 0.44, 32);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
    this.cursorMarker = new THREE.Mesh(geo, mat);
    this.cursorMarker.rotation.x = -Math.PI / 2;
    this.cursorMarker.position.y = 0.09;
    this.cursorMarker.layers.set(2);
    this.cursorMarker.visible = false;
    this.scene.add(this.cursorMarker);
  }

  _buildParticles() {
    // Bounded pooled particle bursts (additive soft sprites; bright enough to bloom).
    const max = PARTICLE_POOL.high;
    this.pMax = PARTICLE_POOL.low;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(max * 3).fill(-100);
    this.pVel = new Float32Array(max * 3);
    this.pLife = new Float32Array(max);
    this.pCol = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.22, vertexColors: true, transparent: true, opacity: 0.95, map: this._dot,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    this.points = new THREE.Points(geo, mat);
    this.points.layers.set(3);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.pNext = 0;
  }

  _buildMotes(info) {
    // Ambient prism dust drifting above the table (animated background only).
    const geo = new THREE.BufferGeometry();
    this.mPos = new Float32Array(MOTES * 3);
    this.mSeed = new Float32Array(MOTES);
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < MOTES; i++) {
      const a = rnd() * Math.PI * 2, r = 4 + rnd() * 14;
      this.mPos[i * 3] = Math.cos(a) * r;
      this.mPos[i * 3 + 1] = rnd() * 9 - 1;
      this.mPos[i * 3 + 2] = Math.sin(a) * r - 4;
      this.mSeed[i] = rnd() * 100;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.mPos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.14, color: info.accent, transparent: true, opacity: 0.45, map: this._dot,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.layers.set(3);
    this.motes.frustumCulled = false;
    this.motes.visible = false;
    this.scene.add(this.motes);
  }

  _buildFlashes(info) {
    // Line-clear flash bars (pooled): a glowing sweep over each cleared row/column.
    const geo = new THREE.PlaneGeometry(BOARD_W, CELL * 0.9);
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.12;
      m.visible = false;
      m.layers.set(3);
      m.userData.life = 0;
      this.scene.add(m);
      this.flashes.push(m);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Graphics settings                                                 */
  /* ---------------------------------------------------------------- */

  /** Apply saved graphics settings live ({} = Auto). */
  setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === this._gfxJson) return; // unrelated settings changed
    this._gfxJson = json;
    const g = resolve(saved || {}, this.detected);
    const prev = this.q;
    this.q = g;

    // Shadows.
    const size = SHADOW_MAP[g.shadows];
    const on = size > 0;
    const shadowChanged = !prev || (SHADOW_MAP[prev.shadows] > 0) !== on;
    this.renderer.shadowMap.enabled = on;
    this.keyLight.castShadow = on;
    if (on && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
    }
    this.keyLight.shadow.radius = g.shadows === 'high' ? 3 : 1.5;
    for (const o of [this.table, this.plate, this.sockets]) o.receiveShadow = on;
    this.cells.castShadow = this.cells.receiveShadow = on;
    this._shadowsOn = on;

    // Reflections: image-based lighting from a neutral studio room.
    if (g.reflections === 'on') {
      if (!this._envTex) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this._envTex = pmrem.fromScene(room, 0.04).texture;
        room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        pmrem.dispose();
      }
      this.scene.environment = this._envTex;
      this.scene.environmentIntensity = 0.4;
    } else {
      this.scene.environment = null;
    }

    // Surface detail: rounded bevelled blocks and frosted/brushed textures.
    const detailed = g.detail === 'detailed';
    this.cells.geometry = detailed ? this._roundGeo : this._boxGeo;
    this.tableMat.roughnessMap = detailed ? this._tableNoise : null;
    this.tableMat.bumpMap = detailed ? this._tableNoise : null;
    this.tableMat.bumpScale = 0.25;
    this.tableMat.envMapIntensity = 0.5;
    this.tableMat.clearcoat = detailed ? 0.35 : 0;
    this.socketMat.bumpMap = detailed ? this._socketNoise : null;
    this.socketMat.bumpScale = 0.3;
    this.socketMat.envMapIntensity = 0.2;

    // Particles.
    this.pMax = PARTICLE_POOL[g.particles];
    this.pNext %= this.pMax;
    for (let k = this.pMax; k < PARTICLE_POOL.high; k++) { this.pLife[k] = 0; this.pPos[k * 3 + 1] = -100; }
    this.points.geometry.attributes.position.needsUpdate = true;

    this._applyMotion();
    if (this._lastOffer) this.applyOffer(this._lastOffer, this._selectedSlot);

    // Materials pick up shadow/env/map changes on recompile.
    if (shadowChanged || !prev || prev.detail !== g.detail || prev.reflections !== g.reflections) {
      for (const m of [this.tableMat, this.plateMat, this.socketMat, this.cellMat, this.rimMat]) m.needsUpdate = true;
    }

    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    this._applySize(true);
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(words) {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, words),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed
    };
  }

  _applyMotion() {
    const animated = this.q && this.q.background === 'animated';
    this.motes.visible = !!animated;
    this._ambient = !!animated && !this._reducedMotion;
    if (!this._ambient) this.tableGlow.opacity = animated ? 0.07 : 0.05;
  }

  _fpsVisible(on) {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _disposeComposer() {
    if (!this.composer) return;
    for (const p of this.composer.passes) { if (p.dispose) p.dispose(); }
    this.composer.dispose();
    this.composer = null;
  }

  _buildPost(w, h) {
    const g = this.q;
    this._disposeComposer();
    if (!g.post || this.postFailed) return;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.7;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive trims, sparks and specular glints bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.32, 0.35, 0.9));
      }
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly (the panel says so).
      this.postFailed = true;
      this._disposeComposer();
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(ms) {
    const f = this._frames;
    f.push(ms);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = typeof document !== 'undefined' && document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  /** Canvas size and pixel ratio = min(dpr, preset cap) × render scale × adaptive scale. */
  _applySize(force) {
    const parent = this.canvas.parentElement;
    if (!parent) return false;
    // While the game screen is hidden, size to the window so the summary stays meaningful.
    const w = parent.clientWidth || window.innerWidth || 1;
    const h = parent.clientHeight || window.innerHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (!force && w === this.size[0] && h === this.size[1] && ratio === this.pixelRatio) return false;
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Board state application (from immutable snapshot)                 */
  /* ---------------------------------------------------------------- */

  _cx(col) { return (col - (BOARD_SIZE - 1) / 2) * CELL; }
  _cz(row) { return (row - (BOARD_SIZE - 1) / 2) * CELL; }

  palette() { return this.cvdPalette ? HUES_CVD : HUES; }

  /** Reconcile instances with a rules board snapshot. */
  applyBoard(board) {
    const m = new THREE.Matrix4();
    const palette = this.palette();
    const col = new THREE.Color();
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const k = r * BOARD_SIZE + c;
        const v = board[r][c];
        if (v > 0) {
          m.makeScale(1, 1, 1).setPosition(this._cx(c), 0.3, this._cz(r));
          this.cells.setMatrixAt(k, m);
          col.setHex(palette[(v - 1) % palette.length]);
          this.cells.setColorAt(k, col);
          this._cellState[k] = 1;
        } else if (this._cellState[k]) {
          this.cells.setMatrixAt(k, this._zeroMatrix);
          this._cellState[k] = 0;
        }
      }
    }
    this.cells.instanceMatrix.needsUpdate = true;
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
  }

  /** Animate cleared cells (cosmetic only; logical state is already final). */
  animateClears(rows, cols, hueAt) {
    if (this._reducedMotion) return;
    const cells = [];
    for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) cells.push([r, c]);
    for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) cells.push([r, c]);
    for (const [r, c] of cells) this._burst(this._cx(c), 0.4, this._cz(r), hueAt ? hueAt(r, c) : 0);
    const lines = [...rows.map(r => ['r', r]), ...cols.map(c => ['c', c])];
    let fi = 0;
    for (const [kind, idx] of lines) {
      const f = this.flashes[fi++ % this.flashes.length];
      f.rotation.z = kind === 'c' ? Math.PI / 2 : 0;
      f.position.x = kind === 'c' ? this._cx(idx) : 0;
      f.position.z = kind === 'r' ? this._cz(idx) : 0;
      f.material.color.setHex(this.info.accent);
      f.userData.life = 0.45;
      f.visible = true;
    }
  }

  _burst(x, y, z, hueIdx) {
    const palette = this.palette();
    const color = new THREE.Color(palette[hueIdx % palette.length]);
    const n = BURST[this.q.particles];
    const boost = this.q.particles === 'high' ? 1.6 : 1;
    for (let i = 0; i < n; i++) {
      const k = this.pNext;
      this.pNext = (this.pNext + 1) % this.pMax;
      this.pPos[k * 3] = x; this.pPos[k * 3 + 1] = y; this.pPos[k * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2;
      this.pVel[k * 3] = Math.cos(a) * sp;
      this.pVel[k * 3 + 1] = 2 + Math.random() * 2.5;
      this.pVel[k * 3 + 2] = Math.sin(a) * sp;
      this.pLife[k] = 0.6 + Math.random() * 0.3;
      this.pCol[k * 3] = color.r * boost; this.pCol[k * 3 + 1] = color.g * boost; this.pCol[k * 3 + 2] = color.b * boost;
    }
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  shake(amount) {
    if (this._reducedMotion) return;
    this._shake = Math.min(0.35, this._shake + amount);
  }

  /* ---------------------------------------------------------------- */
  /* Offer pieces                                                      */
  /* ---------------------------------------------------------------- */

  /** Rebuild offer tray meshes from the snapshot offer. */
  applyOffer(offer, selectedSlot) {
    this._lastOffer = offer;
    for (const child of [...this.offerGroup.children]) {
      child.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.offerGroup.remove(child);
    }
    this.offerViews = [null, null, null];
    const palette = this.palette();
    const slotSpacing = 4.2;
    const detailed = this.q.detail === 'detailed';
    for (let i = 0; i < OFFER_COUNT; i++) {
      const slot = offer[i];
      const baseX = (i - 1) * slotSpacing;
      if (!slot) continue;
      const piece = pieceById(slot.piece);
      const group = new THREE.Group();
      const hue = palette[slot.hue % palette.length];
      const mat = this._blockMaterial(hue, { emissive: hue, emissiveIntensity: 0.1 });
      const geo = detailed ? new RoundedBoxGeometry(0.62, 0.4, 0.62, 2, 0.06) : new THREE.BoxGeometry(0.62, 0.4, 0.62);
      let minR = 99, maxR = -99, minC = 99, maxC = -99;
      for (const [dr, dc] of piece.cells) {
        minR = Math.min(minR, dr); maxR = Math.max(maxR, dr);
        minC = Math.min(minC, dc); maxC = Math.max(maxC, dc);
      }
      const offR = (minR + maxR) / 2, offC = (minC + maxC) / 2;
      for (const [dr, dc] of piece.cells) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set((dc - offC) * 0.7, 0.25, (dr - offR) * 0.7);
        mesh.castShadow = this._shadowsOn;
        group.add(mesh);
      }
      group.position.set(baseX, 0, 0);
      group.userData.slot = i;
      group.userData.mat = mat;
      this.offerGroup.add(group);
      this.offerViews[i] = group;
    }
    this.setSelectedSlot(selectedSlot);
  }

  setSelectedSlot(slot) {
    this._selectedSlot = slot;
    for (let i = 0; i < OFFER_COUNT; i++) {
      const g = this.offerViews[i];
      if (!g) continue;
      const sel = i === slot;
      g.position.y = sel ? 0.45 : 0;      // lift/pose
      g.scale.setScalar(sel ? 1.12 : 1);  // readable without post effects
      g.userData.mat.emissiveIntensity = sel ? 0.32 : 0.1;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Ghost preview                                                     */
  /* ---------------------------------------------------------------- */

  showGhost(board, pieceId, row, col, hue) {
    const piece = pieceById(pieceId);
    const legal = canPlace(board, row, col, piece);
    const m = new THREE.Matrix4();
    const palette = this.palette();
    this.ghostMat.color.setHex(legal ? palette[hue % palette.length] : 0xff4444);
    this.ghostMat.opacity = legal ? 0.4 : 0.25;
    let k = 0;
    for (const [dr, dc] of piece.cells) {
      const r = row + dr, c = col + dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
        m.makeScale(1, 1, 1).setPosition(this._cx(c), 0.25, this._cz(r));
        this.ghost.setMatrixAt(k++, m);
      }
    }
    for (; k < 9; k++) this.ghost.setMatrixAt(k, this._zeroMatrix);
    this.ghost.instanceMatrix.needsUpdate = true;
    this.ghost.visible = true;
    return legal;
  }

  hideGhost() {
    this.ghost.visible = false;
    for (let k = 0; k < 9; k++) this.ghost.setMatrixAt(k, this._zeroMatrix);
    this.ghost.instanceMatrix.needsUpdate = true;
  }

  setCursor(row, col, visible) {
    this.cursorMarker.visible = visible;
    if (visible) this.cursorMarker.position.set(this._cx(col), 0.09, this._cz(row));
  }

  /* ---------------------------------------------------------------- */
  /* Picking                                                           */
  /* ---------------------------------------------------------------- */

  /** Convert normalized pointer coords to a board cell, or null. */
  pickCell(ndcX, ndcY) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    this._raycaster.layers.enableAll();
    if (!this._raycaster.ray.intersectPlane(this._plane, this._hitPoint)) return null;
    const col = Math.round(this._hitPoint.x / CELL + (BOARD_SIZE - 1) / 2);
    const row = Math.round(this._hitPoint.z / CELL + (BOARD_SIZE - 1) / 2);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    return { row, col };
  }

  /** Which offer slot (0..2) is at these pointer coords, or null. */
  pickOffer(ndcX, ndcY) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    this._raycaster.layers.enableAll();
    const hits = this._raycaster.intersectObjects(this.offerGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.slot == null) o = o.parent;
      if (o) return o.userData.slot;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Frame loop                                                        */
  /* ---------------------------------------------------------------- */

  resize() {
    this._applySize(true);
    const [w, h] = this.size;
    // The DOM offer tray covers the bottom of the canvas: frame the board in
    // the band above it (view offset), and view it more top-down on short
    // screens so the far rows stay large enough to tap.
    let trayH = 0;
    const tray = typeof document !== 'undefined' ? document.getElementById('offer-tray') : null;
    if (tray && tray.offsetParent) trayH = Math.min(h * 0.35, tray.getBoundingClientRect().height + 8);
    const safeH = Math.max(120, h - trayH);
    this.camera.aspect = w / safeH;
    this.camera.setViewOffset(w, safeH, 0, 0, w, h);
    // Keep the whole board framed in narrow viewports.
    const aspect = w / safeH;
    const fit = Math.min(1, aspect / 0.85);
    const short = h < 520;
    const dist0 = short ? FRAMING.distance * 0.8 : FRAMING.distance;
    const height0 = short ? FRAMING.height * 1.25 : FRAMING.height;
    const d = dist0 / Math.max(0.62, fit);
    const hh = height0 / Math.max(0.62, fit);
    this.camera.position.set(0, hh, d);
    this.camera.lookAt(FRAMING.lookAt);
    // In narrow portrait frames the 3D offer pieces would render half off-screen;
    // the DOM offer tray already presents them, so hide the 3D duplicates.
    this.offerGroup.visible = w / h >= 0.8;
    this.camera.updateProjectionMatrix();
    this.postKey = null;
  }

  _animate(dt) {
    // Particles.
    let anyParticle = false;
    for (let k = 0; k < this.pMax; k++) {
      if (this.pLife[k] <= 0) continue;
      anyParticle = true;
      this.pLife[k] -= dt;
      this.pVel[k * 3 + 1] -= 9.8 * dt;
      this.pPos[k * 3] += this.pVel[k * 3] * dt;
      this.pPos[k * 3 + 1] += this.pVel[k * 3 + 1] * dt;
      this.pPos[k * 3 + 2] += this.pVel[k * 3 + 2] * dt;
      if (this.pLife[k] <= 0) this.pPos[k * 3 + 1] = -100;
    }
    if (anyParticle) this.points.geometry.attributes.position.needsUpdate = true;

    // Line-clear flashes fade out.
    for (const f of this.flashes) {
      if (!f.visible) continue;
      f.userData.life -= dt;
      if (f.userData.life <= 0) { f.visible = false; continue; }
      f.material.opacity = 0.55 * (f.userData.life / 0.45);
    }

    // Gentle ambient motion (off with reduced motion or a static background).
    if (this._ambient) {
      const t = this._time;
      this.tableGlow.opacity = 0.06 + 0.025 * Math.sin(t * 0.8);
      for (let i = 0; i < MOTES; i++) {
        const sd = this.mSeed[i];
        this.mPos[i * 3 + 1] += dt * (0.12 + (sd % 1) * 0.1);
        this.mPos[i * 3] += Math.sin(t * 0.3 + sd) * dt * 0.08;
        if (this.mPos[i * 3 + 1] > 8) this.mPos[i * 3 + 1] = -1;
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
      const sel = this._selectedSlot != null && this.offerViews[this._selectedSlot];
      if (sel) sel.position.y = 0.45 + Math.sin(t * 2.2) * 0.06;
    }
  }

  _draw() {
    if (this.composer) {
      try { this.composer.render(); return; } catch (e) {
        this.postFailed = true;
        this._disposeComposer();
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  render(dt) {
    if (this._disposed) return;
    this._time += dt;
    const now = performance.now();
    const ms = this._lastNow ? Math.min(250, now - this._lastNow) : 16;
    this._lastNow = now;
    const rescale = this._adapt(ms);
    if (this._applySize(rescale) || rescale) this.postKey = null;
    const key = this._postKey(this.size[0], this.size[1]);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(this.size[0], this.size[1]);
    }

    this._animate(dt);

    // Event-tiered camera shake: offset only for drawing and restore
    // immediately afterwards, so raycast truth never changes.
    if (this._shake > 0.001) {
      const s = this._shake;
      this._shake *= Math.exp(-6 * dt);
      const dx = (Math.random() - 0.5) * s;
      const dy = (Math.random() - 0.5) * s * 0.5;
      this.camera.position.x += dx;
      this.camera.position.y += dy;
      this._draw();
      this.camera.position.x -= dx;
      this.camera.position.y -= dy;
    } else {
      this._draw();
    }
  }

  /** Recover from WebGL context loss by rebuilding GPU resources. */
  handleContextLost(event) {
    event.preventDefault();
  }

  dispose() {
    this._disposed = true;
    this._disposeComposer();
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this._boxGeo.dispose(); this._roundGeo.dispose();
    for (const t of this._textures) t.dispose();
    this._dot.dispose();
    if (this._envTex) this._envTex.dispose();
    this.renderer.dispose();
  }
}

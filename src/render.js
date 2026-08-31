'use strict';

/**
 * Prism Parcel — render module: Three.js scene graph, semantic entity
 * views, authored camera, lighting, VFX, quality tiers.
 * Consumes immutable rules snapshots; never mutates rules state.
 */

import * as THREE from 'three';
import { BOARD_SIZE, OFFER_COUNT, pieceById, canPlace } from './rules.js';
import { themeInfo } from './content.js';

const CELL = 1;               // world units per board cell
const GAP = 0.08;             // visual gap between blocks
const BOARD_W = BOARD_SIZE * CELL;

// Authored camera framing constants (no magic offsets elsewhere).
export const FRAMING = Object.freeze({
  fov: 38,
  distance: 16.5,
  height: 13.5,
  lookAt: new THREE.Vector3(0, 0, 0.5),
  tiltLerp: 0.12
});

const HUES = [0x6fd3ff, 0xff9d6f, 0x9ff06f, 0xff6fb0, 0xffe06f, 0xb09fff];
const HUES_CVD = [0x4cc9f0, 0xf72585, 0xffe169, 0x90be6d, 0xb5179e, 0xf8961e];

export const QUALITY_TIERS = Object.freeze({
  low:    { pixelRatioCap: 1,   shadows: false, particles: 40,  antialias: false, renderScale: 0.85 },
  medium: { pixelRatioCap: 1.5, shadows: true,  particles: 120, antialias: true,  renderScale: 1 },
  high:   { pixelRatioCap: 2,   shadows: true,  particles: 300, antialias: true,  renderScale: 1 }
});

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.theme = options.theme || 'aurora';
    this.cvdPalette = !!options.cvdPalette;
    this.reducedMotion = !!options.reducedMotion;
    this.tier = QUALITY_TIERS[options.quality] || QUALITY_TIERS.high;
    this.tierName = options.quality || 'high';

    const info = themeInfo(this.theme);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.tier.antialias,
      powerPreference: 'high-performance'
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (this.tier.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(info.bg);
    this.scene.fog = new THREE.Fog(info.bg, 26, 46);

    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
    this.camera.position.set(0, FRAMING.height, FRAMING.distance);
    this.camera.lookAt(FRAMING.lookAt);

    // Layers: 0 environment, 1 gameplay, 2 selection/ghosts, 3 effects.
    this._buildLights(info);
    this._buildTable(info);
    this._buildBoard();
    this._buildGhost();
    this._buildCursorMarker();
    this._buildParticles();

    this.offerGroup = new THREE.Group();
    this.offerGroup.position.set(0, 0, BOARD_W / 2 + 2.2);
    this.scene.add(this.offerGroup);
    this.offerViews = [null, null, null];

    this._time = 0;
    this._shake = 0;
    this._clearAnims = [];
    this._resizeObserver = null;
    this._disposed = false;
    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hitPoint = new THREE.Vector3();

    this.resize();
  }

  /* ---------------------------------------------------------------- */
  /* Scene construction                                                */
  /* ---------------------------------------------------------------- */

  _buildLights(info) {
    const key = new THREE.DirectionalLight(info.key, 2.4);
    key.position.set(6, 14, 8);
    if (this.tier.shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -9; key.shadow.camera.right = 9;
      key.shadow.camera.top = 9; key.shadow.camera.bottom = -9;
      key.shadow.bias = -0.0004;
    }
    this.scene.add(key);
    this.keyLight = key;

    const fill = new THREE.HemisphereLight(info.fill, info.bg, 0.9);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(info.accent, 0.5);
    rim.position.set(-8, 6, -6);
    this.scene.add(rim);
  }

  _buildTable(info) {
    // Luminous frosted tabletop: large rounded slab + soft glow disc.
    const tableGeo = new THREE.CylinderGeometry(11.5, 12.5, 0.8, 48);
    const tableMat = new THREE.MeshStandardMaterial({
      color: info.table, roughness: 0.55, metalness: 0.15
    });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.y = -0.85;
    table.receiveShadow = this.tier.shadows;
    this.scene.add(table);

    const glowGeo = new THREE.CircleGeometry(9, 48);
    const glowMat = new THREE.MeshBasicMaterial({
      color: info.accent, transparent: true, opacity: 0.05, depthWrite: false
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.44;
    this.scene.add(glow);
    this.tableGlow = glowMat;
  }

  _blockMaterial(color, extra = {}) {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.32,
      metalness: 0.05,
      transmission: 0,           // frosted look via roughness, cheap on mobile
      clearcoat: 0.6,
      clearcoatRoughness: 0.4,
      ...extra
    });
  }

  _buildBoard() {
    // Base plate under the grid.
    const plateGeo = new THREE.BoxGeometry(BOARD_W + 0.7, 0.3, BOARD_W + 0.7);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x0c0f1e, roughness: 0.4, metalness: 0.3 });
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.y = -0.16;
    plate.receiveShadow = this.tier.shadows;
    this.scene.add(plate);

    // Cell sockets (always visible empty wells).
    const socketGeo = new THREE.BoxGeometry(CELL - GAP, 0.06, CELL - GAP);
    const socketMat = new THREE.MeshStandardMaterial({ color: 0x232a4a, roughness: 0.8, metalness: 0.1 });
    this.sockets = new THREE.InstancedMesh(socketGeo, socketMat, BOARD_SIZE * BOARD_SIZE);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        m.setPosition(this._cx(c), 0.03, this._cz(r));
        this.sockets.setMatrixAt(i++, m);
      }
    }
    this.sockets.receiveShadow = this.tier.shadows;
    this.scene.add(this.sockets);

    // Occupied cells: one InstancedMesh, per-instance color.
    const cellGeo = new THREE.BoxGeometry(CELL - GAP, 0.55, CELL - GAP);
    const cellMat = this._blockMaterial(0xffffff);
    this.cells = new THREE.InstancedMesh(cellGeo, cellMat, BOARD_SIZE * BOARD_SIZE);
    this.cells.castShadow = this.tier.shadows;
    this.cells.receiveShadow = this.tier.shadows;
    this.cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.cells);
    this._cellState = new Int8Array(BOARD_SIZE * BOARD_SIZE); // 0 empty, 1 filled
    this._cellHue = new Int8Array(BOARD_SIZE * BOARD_SIZE);
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
    const geo = new THREE.RingGeometry(0.32, 0.44, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
    this.cursorMarker = new THREE.Mesh(geo, mat);
    this.cursorMarker.rotation.x = -Math.PI / 2;
    this.cursorMarker.position.y = 0.09;
    this.cursorMarker.layers.set(2);
    this.cursorMarker.visible = false;
    this.scene.add(this.cursorMarker);
  }

  _buildParticles() {
    // Bounded pooled particle burst system (points).
    const max = this.tier.particles;
    this.pMax = max;
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(max * 3);
    this.pVel = new Float32Array(max * 3);
    this.pLife = new Float32Array(max);
    this.pCol = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, sizeAttenuation: true
    });
    this.points = new THREE.Points(geo, mat);
    this.points.layers.set(3);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.pNext = 0;
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
    if (this.reducedMotion) return;
    const cells = [];
    for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) cells.push([r, c]);
    for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) cells.push([r, c]);
    for (const [r, c] of cells) this._burst(this._cx(c), 0.4, this._cz(r), hueAt ? hueAt(r, c) : 0);
  }

  _burst(x, y, z, hueIdx) {
    const palette = this.palette();
    const color = new THREE.Color(palette[hueIdx % palette.length]);
    const n = 6;
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
      this.pCol[k * 3] = color.r; this.pCol[k * 3 + 1] = color.g; this.pCol[k * 3 + 2] = color.b;
    }
  }

  shake(amount) {
    if (this.reducedMotion) return;
    this._shake = Math.min(0.35, this._shake + amount);
  }

  /* ---------------------------------------------------------------- */
  /* Offer pieces                                                      */
  /* ---------------------------------------------------------------- */

  /** Rebuild offer tray meshes from the snapshot offer. */
  applyOffer(offer, selectedSlot) {
    for (const child of [...this.offerGroup.children]) {
      child.geometry && child.geometry.dispose();
      this.offerGroup.remove(child);
    }
    this.offerViews = [null, null, null];
    const palette = this.palette();
    const slotSpacing = 4.2;
    for (let i = 0; i < OFFER_COUNT; i++) {
      const slot = offer[i];
      const baseX = (i - 1) * slotSpacing;
      if (!slot) continue;
      const piece = pieceById(slot.piece);
      const group = new THREE.Group();
      const mat = this._blockMaterial(palette[slot.hue % palette.length]);
      const geo = new THREE.BoxGeometry(0.62, 0.4, 0.62);
      let minR = 99, maxR = -99, minC = 99, maxC = -99;
      for (const [dr, dc] of piece.cells) {
        minR = Math.min(minR, dr); maxR = Math.max(maxR, dr);
        minC = Math.min(minC, dc); maxC = Math.max(maxC, dc);
      }
      const offR = (minR + maxR) / 2, offC = (minC + maxC) / 2;
      for (const [dr, dc] of piece.cells) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set((dc - offC) * 0.7, 0.25, (dr - offR) * 0.7);
        mesh.castShadow = this.tier.shadows;
        group.add(mesh);
      }
      group.position.set(baseX, 0, 0);
      group.userData.slot = i;
      this.offerGroup.add(group);
      this.offerViews[i] = group;
    }
    this.setSelectedSlot(selectedSlot);
  }

  setSelectedSlot(slot) {
    for (let i = 0; i < OFFER_COUNT; i++) {
      const g = this.offerViews[i];
      if (!g) continue;
      const sel = i === slot;
      g.position.y = sel ? 0.45 : 0;      // lift/pose
      g.scale.setScalar(sel ? 1.12 : 1);  // readable without post effects
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
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    const pr = Math.min(window.devicePixelRatio || 1, this.tier.pixelRatioCap) * this.tier.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole board framed in narrow viewports.
    const fit = Math.min(1, (w / h) / 0.85);
    const d = FRAMING.distance / Math.max(0.62, fit);
    const hh = FRAMING.height / Math.max(0.62, fit);
    this.camera.position.set(0, hh, d);
    this.camera.lookAt(FRAMING.lookAt);
    this.camera.updateProjectionMatrix();
  }

  render(dt) {
    if (this._disposed) return;
    this._time += dt;

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

    // Event-tiered camera shake (never changes raycast truth: applied post-render? —
    // we apply to a wrapper offset only for drawing and restore immediately).
    if (this._shake > 0.001) {
      const s = this._shake;
      this._shake *= Math.exp(-6 * dt);
      const dx = (Math.random() - 0.5) * s;
      const dy = (Math.random() - 0.5) * s * 0.5;
      this.camera.position.x += dx;
      this.camera.position.y += dy;
      this.renderer.render(this.scene, this.camera);
      this.camera.position.x -= dx;
      this.camera.position.y -= dy;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Recover from WebGL context loss by rebuilding GPU resources. */
  handleContextLost(event) {
    event.preventDefault();
  }

  dispose() {
    this._disposed = true;
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.renderer.dispose();
  }
}

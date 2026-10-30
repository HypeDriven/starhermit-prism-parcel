// The luminous tabletop on starhermit:scene, as the browser build's
// src/render.js drew it with three.js r185: the gradient dome, the frosted
// table slab and its breathing glow disc, the board plate with its emissive
// accent rim, the hundred cell sockets, the placed blocks (one instanced mesh,
// a colour per hue, a faint self-glow), the ghost preview (legal in the
// piece's hue, illegal red), the keyboard cursor ring, the 3D offer row (the
// selected piece lifted, scaled 1.12, glowing and bobbing), pooled additive
// spark bursts and flash bars on line clears, the drifting prism motes and
// the event camera shake. The scene is rebuilt from the rules' snapshots; it
// never touches the rules state.
//
// three.js r185 (physically based lights): colours as written, the punctual
// and hemisphere lights' intensities ÷ π (the engine takes three's legacy
// units). The old composer (RenderPass in half floats → GTAO → UnrealBloom
// 0.32 / 0.35 / 0.9 → the colour grade in linear light → OutputPass with ACES
// 0.95 → SMAA / FXAA) is the runtime's renderer.ao / bloom / grade /
// antialias in the same order. The cell material's onBeforeCompile glow is a
// surface hook. The frosted noise maps are baked PNGs (tools/bake-noise.mjs,
// the same pixels). The old canvas sat in the playfield between the rails:
// the camera spans the window and its view offset puts the authored framing
// (the board, and the offer row when shown, fitted into the band between the
// HUD and the tray) where that canvas was.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, DynamicDrawUsage, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, NoColorSpace, PerspectiveCamera, PlaneGeometry, Plane, PMREMGenerator,
  OrthographicCamera, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, SphereGeometry,
  TextureLoader, Vector2, Vector3, renderer, scene, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, Rules, type Slot, type ThemeInfo } from "./game.ts";
import { MOTE_MAX, SPARK_MAX, sparkPool, type Look } from "./quality.ts";

const N = Rules.BOARD_SIZE;
const CELL = 1, GAP = 0.08, BOARD_W = N * CELL, CELL_H = 0.55;
const OFFER_Z = BOARD_W / 2 + 2.2;
const BURST = { low: 6, high: 12 };
const EXPOSURE = 0.95;
/** render.js FRAMING. */
const FRAMING = {
  fov: 38, distance: 14, height: 16, steepDistance: 8, steepHeight: 21, offerHalfX: 5.65, offerHalfZ: 1.95,
  lookAt: new Vector3(0, 0, 0.5),
};
const HUES = [0x6fd3ff, 0xff9d6f, 0x9ff06f, 0xff6fb0, 0xffe06f, 0xb09fff];
const HUES_CVD = [0x4cc9f0, 0xf72585, 0xffe169, 0x90be6d, 0xb5179e, 0xf8961e];
export interface Rect { x: number; y: number; width: number; height: number }

const cx = (col: number): number => (col - (N - 1) / 2) * CELL;
const cz = (row: number): number => (row - (N - 1) / 2) * CELL;

// ---------------------------------------------------------------- state
let info: ThemeInfo = Content.themeInfo("aurora");
let look: Look | null = null;
let cvd = false;
let reducedMotion = false;
let time = 0, shakeAmp = 0;
const camera = new PerspectiveCamera(FRAMING.fov, 1, 0.1, 120);
const camBase = new Vector3(0, FRAMING.height, FRAMING.distance);
const raycaster = new Raycaster();
const floor = new Plane(new Vector3(0, 1, 0), 0);
const zero = new Matrix4().makeScale(0, 0, 0);

/** The page's key-light ortho box, fitted tightly around the play area (board, offer row) in light space. */
function fitShadow(key: DirectionalLight): void {
  const o = key.position, t = key.target.position;
  const z = new Vector3().subVectors(o, t).normalize();
  const x = new Vector3(0, 1, 0).cross(z).normalize();
  const y = new Vector3().crossVectors(z, x);
  const lo = [-6.8, -0.5, -BOARD_W / 2 - 0.6], hi = [6.8, 1.4, OFFER_Z + 1.8];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const d = new Vector3();
  for (let i = 0; i < 8; i++) {
    d.set(i & 1 ? hi[0]! : lo[0]!, i & 2 ? hi[1]! : lo[1]!, i & 4 ? hi[2]! : lo[2]!).sub(o);
    const px = d.dot(x), py = d.dot(y), pz = d.dot(z);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
  }
  const cam = key.shadow.camera as OrthographicCamera;
  cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
  cam.near = Math.max(0.1, -maxZ - 1); cam.far = -minZ + 1;
  cam.updateProjectionMatrix();
}

// textures
const loader = new TextureLoader();
const noiseCache = new Map<string, Texture>();
function noise(kind: "table" | "socket", size: number): Texture {
  const k = `${kind}-${size}`;
  let t = noiseCache.get(k);
  if (!t) {
    t = loader.load(`assets/noise-${k}.png`, undefined, undefined, (e: unknown) => console.warn(`noise ${k}: ${e instanceof Error ? e.message : String(e)}`));
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = NoColorSpace;
    if (kind === "table") t.repeat.set(5, 5);
    noiseCache.set(k, t);
  }
  return t;
}
/** render.js dotTexture: the soft round sprite of sparks and motes. */
function dotTexture(): CanvasTexture {
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.7)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- materials (render.js _lit)
type LitParams = Record<string, unknown>;
function lit(params: LitParams): MeshStandardMaterial | MeshLambertMaterial {
  const tier = look?.budget.material ?? "standard";
  if (tier === "physical") return new MeshPhysicalMaterial(params as never);
  const std: LitParams = {};
  for (const [k, v] of Object.entries(params)) if (!/^clearcoat/.test(k)) std[k] = v;
  if (tier === "standard") return new MeshStandardMaterial(std as never);
  const lam: LitParams = {};
  for (const [k, v] of Object.entries(std)) if (!/^(roughness|metalness|envMapIntensity)$/.test(k)) lam[k] = v;
  return new MeshLambertMaterial(lam as never);
}
const blockMaterial = (color: number, extra: LitParams = {}): MeshStandardMaterial | MeshLambertMaterial =>
  lit({ color, roughness: 0.4, metalness: 0.02, clearcoat: 0.55, clearcoatRoughness: 0.32, envMapIntensity: 0.6, ...extra });
/** The cell glow (render.js onBeforeCompile: totalEmissiveRadiance += diffuseColor.rgb × 0.06). */
const GLOW = "fn surface(s: Surface) -> Surface { var o = s; o.emissive = o.emissive + o.base_color.rgb * 0.06; return o; }";
function cellMaterial(): MeshStandardMaterial | MeshLambertMaterial {
  const m = blockMaterial(0xffffff);
  m.hooks = { surface: GLOW };
  return m;
}
const tableMaterial = (): MeshStandardMaterial | MeshLambertMaterial => lit({ color: info.table, roughness: 0.55, metalness: 0.15, clearcoat: 0, clearcoatRoughness: 0.5 });
const plateMaterial = (): MeshStandardMaterial | MeshLambertMaterial => lit({ color: 0x0c0f1e, roughness: 0.4, metalness: 0.3 });
const rimMaterial = (): MeshStandardMaterial | MeshLambertMaterial => lit({ color: 0x000000, emissive: info.accent, emissiveIntensity: 1.25, roughness: 1 });
const socketMaterial = (): MeshStandardMaterial | MeshLambertMaterial => lit({ color: 0x35407a, roughness: 0.75, metalness: 0.1, emissive: 0x141a3a, emissiveIntensity: 0.6 });

// ---------------------------------------------------------------- the scene (built on first use)
let built = false;
let backdrop: Mesh, keyLight: DirectionalLight, fill: HemisphereLight, rimLight: DirectionalLight;
let table: Mesh, glow: Mesh, glowMat: MeshBasicMaterial, plate: Mesh, sockets: InstancedMesh, cells: InstancedMesh;
let rims: Mesh[] = [];
let tableMat: MeshStandardMaterial | MeshLambertMaterial, plateMat: MeshStandardMaterial | MeshLambertMaterial;
let rimMat: MeshStandardMaterial | MeshLambertMaterial, socketMat: MeshStandardMaterial | MeshLambertMaterial, cellMat: MeshStandardMaterial | MeshLambertMaterial;
let boxGeo: BoxGeometry, roundGeo: BufferGeometry;
let ghost: InstancedMesh, ghostMat: MeshBasicMaterial, cursor: Mesh;
let points: Points, pMat: PointsMaterial, motes: Points, motesMat: PointsMaterial;
const flashes: Mesh[] = [];
const flashLife: number[] = [];
let offerGroup: Group;
let offerViews: (Group | null)[] = [null, null, null];
const offerMats: (MeshStandardMaterial | MeshLambertMaterial | null)[] = [null, null, null];
const offerSlotOf = new Map<Object3D, number>();
const offerHitMat = new MeshBasicMaterial();
let selected: number | null = null;
let lastOffer: (Slot | null)[] | null = null;
const cellState = new Int8Array(N * N);
let lastBoard: number[][] | null = null;
let envTex: Texture | null = null;
let budgetKey = "";
let dot: CanvasTexture;
const pPos = new Float32Array(SPARK_MAX * 3).fill(-100), pVel = new Float32Array(SPARK_MAX * 3), pLife = new Float32Array(SPARK_MAX), pCol = new Float32Array(SPARK_MAX * 3);
let pMax = 60, pNext = 0;
const mPos = new Float32Array(MOTE_MAX * 3), mSeed = new Float32Array(MOTE_MAX);
let mLive = 50;

function backdropColors(): void {
  const geo = backdrop.geometry;
  const pos = geo.attributes.position!;
  const cols = new Float32Array(pos.count * 3);
  const bottom = new Color(info.bg).multiplyScalar(0.7), mid = new Color(info.bg), top = new Color(info.bg).lerp(new Color(info.fill), 0.45);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 80;
    if (y < 0) c.copy(mid).lerp(bottom, Math.min(1, -y * 2));
    else c.copy(mid).lerp(top, Math.pow(y, 0.7));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new BufferAttribute(cols, 3));
}

function build(): void {
  built = true;
  scene.background = new Color(info.bg);
  scene.fog = new Fog(info.bg, 26, 60);
  dot = dotTexture();
  // the dome
  backdrop = new Mesh(new SphereGeometry(80, 32, 16), new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }));
  backdrop.renderOrder = -1;
  backdropColors();
  scene.add(backdrop);
  // the lights (three r185 physical units, as engine minor 23+ takes them)
  keyLight = new DirectionalLight(info.key, 2.4);
  keyLight.position.set(6, 14, 8);
  keyLight.target.position.set(0, 0, 1);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  fitShadow(keyLight);
  scene.add(keyLight, keyLight.target);
  fill = new HemisphereLight(info.fill, info.bg, 0.9);
  scene.add(fill);
  rimLight = new DirectionalLight(info.accent, 0.6);
  rimLight.position.set(-8, 6, -6);
  scene.add(rimLight);
  // the table
  const seg = look?.budget.tableSeg ?? 48;
  tableMat = tableMaterial();
  table = new Mesh(new CylinderGeometry(11.5, 12.5, 0.8, seg), tableMat);
  table.position.y = -0.85;
  scene.add(table);
  glowMat = new MeshBasicMaterial({ color: info.accent, transparent: true, opacity: 0.05, depthWrite: false });
  glow = new Mesh(new CircleGeometry(9, seg), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -0.44;
  scene.add(glow);
  // the board
  plateMat = plateMaterial();
  plate = new Mesh(new BoxGeometry(BOARD_W + 0.7, 0.3, BOARD_W + 0.7), plateMat);
  plate.position.y = -0.16;
  scene.add(plate);
  const half = (BOARD_W + 0.7) / 2;
  rimMat = rimMaterial();
  const rimH = new BoxGeometry(BOARD_W + 0.78, 0.05, 0.05), rimV = new BoxGeometry(0.05, 0.05, BOARD_W + 0.78);
  rims = [];
  for (const [g, x, z] of [[rimH, 0, -half], [rimH, 0, half], [rimV, -half, 0], [rimV, half, 0]] as const) {
    const m = new Mesh(g, rimMat);
    m.position.set(x, -0.01, z);
    rims.push(m);
    scene.add(m);
  }
  socketMat = socketMaterial();
  sockets = new InstancedMesh(new BoxGeometry(CELL - GAP, 0.06, CELL - GAP), socketMat, N * N);
  const m = new Matrix4();
  let i = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { m.makeTranslation(cx(c), 0.03, cz(r)); sockets.setMatrixAt(i++, m); }
  sockets.instanceMatrix.needsUpdate = true;
  scene.add(sockets);
  boxGeo = new BoxGeometry(CELL - GAP, CELL_H, CELL - GAP);
  roundGeo = new RoundedBoxGeometry(CELL - GAP, CELL_H, CELL - GAP, (look?.budget.bevel ?? 2) + 1, 0.08);
  cellMat = cellMaterial();
  cells = new InstancedMesh(boxGeo, cellMat, N * N);
  cells.instanceMatrix.setUsage(DynamicDrawUsage);
  for (let k = 0; k < N * N; k++) { cells.setMatrixAt(k, zero); cells.setColorAt(k, new Color(0xffffff)); }
  cells.instanceMatrix.needsUpdate = true;
  scene.add(cells);
  // the ghost and the cursor ring
  ghostMat = new MeshBasicMaterial({ color: 0x9fefff, transparent: true, opacity: 0.35, depthWrite: false });
  ghost = new InstancedMesh(new BoxGeometry(CELL - GAP, 0.3, CELL - GAP), ghostMat, 9);
  scene.add(ghost);
  hideGhost();
  cursor = new Mesh(new RingGeometry(0.32, 0.44, 32), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false }));
  cursor.rotation.x = -Math.PI / 2;
  cursor.position.y = 0.09;
  cursor.visible = false;
  scene.add(cursor);
  // sparks
  const pGeo = new BufferGeometry();
  pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
  pMat = new PointsMaterial({ size: 0.22, vertexColors: true, transparent: true, opacity: 0.95, map: dot, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  points = new Points(pGeo, pMat);
  points.frustumCulled = false;
  scene.add(points);
  // motes
  let s = 12345;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let k = 0; k < MOTE_MAX; k++) {
    const a = rnd() * Math.PI * 2, rr = 4 + rnd() * 14;
    mPos[k * 3] = Math.cos(a) * rr;
    mPos[k * 3 + 1] = rnd() * 9 - 1;
    mPos[k * 3 + 2] = Math.sin(a) * rr - 4;
    mSeed[k] = rnd() * 100;
  }
  const mGeo = new BufferGeometry();
  mGeo.setAttribute("position", new BufferAttribute(mPos, 3));
  motesMat = new PointsMaterial({ size: 0.14, color: info.accent, transparent: true, opacity: 0.45, map: dot, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  motes = new Points(mGeo, motesMat);
  motes.frustumCulled = false;
  motes.visible = false;
  scene.add(motes);
  // flash bars
  const fGeo = new PlaneGeometry(BOARD_W, CELL * 0.9);
  for (let k = 0; k < 8; k++) {
    const f = new Mesh(fGeo, new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    f.rotation.x = -Math.PI / 2;
    f.position.y = 0.12;
    f.visible = false;
    flashes.push(f);
    flashLife.push(0);
    scene.add(f);
  }
  offerGroup = new Group();
  offerGroup.position.set(0, 0, OFFER_Z);
  scene.add(offerGroup);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
}

// ---------------------------------------------------------------- the look (setGraphics)
function applyBudget(): void {
  const b = look!.budget;
  const key = [b.material, b.bevel, b.noise, b.tableSeg].join("|");
  if (key === budgetKey) return;
  budgetKey = key;
  const swap = <M extends Material>(old: Material, next: M, meshes: Mesh[]): M => { for (const m of meshes) m.material = next; old.dispose(); return next; };
  tableMat = swap(tableMat, tableMaterial(), [table]);
  plateMat = swap(plateMat, plateMaterial(), [plate]);
  rimMat = swap(rimMat, rimMaterial(), rims);
  socketMat = swap(socketMat, socketMaterial(), [sockets]);
  cellMat = swap(cellMat, cellMaterial(), [cells]);
  roundGeo.dispose();
  roundGeo = new RoundedBoxGeometry(CELL - GAP, CELL_H, CELL - GAP, b.bevel + 1, 0.08);
  for (const mesh of [table, glow]) mesh.geometry.dispose();
  table.geometry = new CylinderGeometry(11.5, 12.5, 0.8, b.tableSeg);
  glow.geometry = new CircleGeometry(9, b.tableSeg);
  if (lastOffer) applyOffer(lastOffer, selected);
}

/** The runtime's quality tier applied live (no reload): asset variants, effects and the post chain. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  if (!built) build();
  applyBudget();
  const on = next.shadows > 0;
  renderer.shadowMap.enabled = on;
  keyLight.castShadow = on;
  if (on) keyLight.shadow.mapSize = next.shadows;
  keyLight.shadow.radius = next.shadows === 4096 ? 3 : 1.5;
  for (const o of [table, plate, sockets]) o.receiveShadow = on;
  cells.castShadow = cells.receiveShadow = on;
  for (const g of offerViews) if (g) for (const c of g.children) c.castShadow = on;
  // reflections: image-based lighting from a neutral studio room
  if (next.reflections) {
    if (!envTex) {
      // three r185's room: always the 900-candela light (the renderer passed) and lowered 3.5 m (r183+).
      try {
        const room = new RoomEnvironment(renderer);
        room.position.y = -3.5;
        envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
      } catch (e) { console.warn(`environment: ${String(e)}`); }
    }
    scene.environment = envTex;
    scene.environmentIntensity = 0.4;
  } else scene.environment = null;
  // surface detail
  applyDetail();
  // particles and motes
  pMax = sparkPool(next);
  pNext %= pMax;
  for (let k = pMax; k < SPARK_MAX; k++) { pLife[k] = 0; pPos[k * 3 + 1] = -100; }
  points.geometry.attributes.position!.needsUpdate = true;
  mLive = next.budget.motes;
  motes.geometry.setDrawRange(0, mLive);
  applyMotion();
  // UnrealBloomPass(0.32, 0.35, 0.9): only emissive trims, sparks and specular glints bloom.
  // three r185 page: bloom strength as written (the engine default r185 model).
  renderer.bloom = next.bloom ? { strength: 0.32, radius: 0.35, threshold: 0.9, resolution: next.budget.bloomRes } : null;
  // GTAOPass: radius 0.6, distance exponent 1.4, thickness 1.2; 16 / 8 samples and the denoise per tier; blend 0.7.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader on the linear buffer before the tone mapping: an 0.18 smoothstep S-curve (contrastCurve "s"), saturation 1.1, cool shadows /
  // warm highlights by a smoothstep of luma from 0.2 to 0.8, a 0.24 vignette from 0.38 to 0.9.
  renderer.grade = next.grade ? {
    space: "linear", contrastCurve: "s", overRange: "keep", contrast: 0.18, saturation: 1.1, split: [0.2, 0.8], shadows: [0.97, 0.99, 1.05], highlights: [1.03, 1.0, 0.97],
    vignette: { amount: 0.24, inner: 0.38, outer: 0.9, scale: [1, 1] },
  } : null;
  renderer.antialias = next.antialias;
}
function applyDetail(): void {
  const d = !!look?.detailed, b = look!.budget;
  cells.geometry = d ? roundGeo : boxGeo;
  tableMat.bumpMap = d ? noise("table", b.noise) : null;
  tableMat.bumpScale = 0.25;
  if ("roughnessMap" in tableMat) tableMat.roughnessMap = d ? noise("table", b.noise) : null;
  if ("clearcoat" in tableMat) (tableMat as MeshPhysicalMaterial).clearcoat = d ? 0.35 : 0;
  socketMat.bumpMap = d ? noise("socket", b.noise / 2) : null;
  socketMat.bumpScale = 0.3;
}
function applyMotion(): void {
  const animated = !!look?.animated;
  motes.visible = animated;
  if (!animated || reducedMotion) glowMat.opacity = animated ? 0.07 : 0.05;
}
export function setReducedMotion(v: boolean): void {
  reducedMotion = v;
  if (built) applyMotion();
}

/** The visual theme (render.js rebuilt the renderer on a change; here its colours change in place). */
export function setTheme(theme: string, cvdPalette: boolean): void {
  const next = Content.themeInfo(theme);
  const changed = next !== info || cvdPalette !== cvd;
  info = next;
  cvd = cvdPalette;
  if (!built || !changed) return;
  scene.background = new Color(info.bg);
  scene.fog = new Fog(info.bg, (scene.fog as Fog).near, (scene.fog as Fog).far);
  backdropColors();
  keyLight.color.set(info.key);
  fill.color.set(info.fill);
  fill.groundColor.set(info.bg);
  rimLight.color.set(info.accent);
  glowMat.color.set(info.accent);
  motesMat.color.set(info.accent);
  tableMat.color.set(info.table);
  rimMat.emissive.set(info.accent);
  if (lastBoard) { cellState.fill(0); applyBoard(lastBoard); }
  if (lastOffer) applyOffer(lastOffer, selected);
}
const palette = (): number[] => (cvd ? HUES_CVD : HUES);

// ---------------------------------------------------------------- snapshots
/** Reconcile the instances with a rules board snapshot. */
export function applyBoard(board: number[][]): void {
  lastBoard = board;
  if (!built) return;
  const m = new Matrix4(), col = new Color(), pal = palette();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const k = r * N + c, v = board[r]![c]!;
    if (v > 0) {
      m.makeTranslation(cx(c), 0.3, cz(r));
      cells.setMatrixAt(k, m);
      col.setHex(pal[(v - 1) % pal.length]!);
      cells.setColorAt(k, col);
      cellState[k] = 1;
    } else if (cellState[k]) {
      cells.setMatrixAt(k, zero);
      cellState[k] = 0;
    }
  }
  cells.instanceMatrix.needsUpdate = true;
  if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
}

/** Cleared lines: spark bursts and flash bars (cosmetic only; the logical state is already final). */
export function animateClears(rows: number[], cols: number[], hueAt: (r: number, c: number) => number): void {
  if (reducedMotion || !built) return;
  const list: [number, number][] = [];
  for (const r of rows) for (let c = 0; c < N; c++) list.push([r, c]);
  for (const c of cols) for (let r = 0; r < N; r++) list.push([r, c]);
  for (const [r, c] of list) burst(cx(c), 0.4, cz(r), hueAt(r, c));
  let fi = 0;
  for (const [kind, idx] of [...rows.map((r) => ["r", r] as const), ...cols.map((c) => ["c", c] as const)]) {
    const i = fi++ % flashes.length, f = flashes[i]!;
    f.rotation.z = kind === "c" ? Math.PI / 2 : 0;
    f.position.x = kind === "c" ? cx(idx) : 0;
    f.position.z = kind === "r" ? cz(idx) : 0;
    (f.material as MeshBasicMaterial).color.set(info.accent);
    flashLife[i] = 0.45;
    f.visible = true;
  }
}
function burst(x: number, y: number, z: number, hue: number): void {
  const pal = palette();
  const color = new Color(pal[hue % pal.length]!);
  const particles = look?.particles ?? "low";
  const n = BURST[particles], boost = particles === "high" ? 1.6 : 1;
  for (let i = 0; i < n; i++) {
    const k = pNext;
    pNext = (pNext + 1) % pMax;
    pPos[k * 3] = x; pPos[k * 3 + 1] = y; pPos[k * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2;
    pVel[k * 3] = Math.cos(a) * sp;
    pVel[k * 3 + 1] = 2 + Math.random() * 2.5;
    pVel[k * 3 + 2] = Math.sin(a) * sp;
    pLife[k] = 0.6 + Math.random() * 0.3;
    pCol[k * 3] = color.r * boost; pCol[k * 3 + 1] = color.g * boost; pCol[k * 3 + 2] = color.b * boost;
  }
  points.geometry.attributes.color!.needsUpdate = true;
}
export function shake(amount: number): void {
  if (reducedMotion) return;
  shakeAmp = Math.min(0.35, shakeAmp + amount);
}

/** Rebuild the offer row's meshes from the snapshot offer. */
export function applyOffer(offer: (Slot | null)[], sel: number | null): void {
  lastOffer = offer;
  if (!built) { selected = sel; return; }
  for (const child of [...offerGroup.children]) {
    for (const c of child.children) (c as Mesh).geometry?.dispose();
    offerGroup.remove(child);
  }
  for (const m of offerMats) m?.dispose();
  offerSlotOf.clear();
  offerViews = [null, null, null];
  const pal = palette(), detailed = !!look?.detailed, bevel = look?.budget.bevel ?? 2;
  for (let i = 0; i < Rules.OFFER_COUNT; i++) {
    const slot = offer[i];
    offerMats[i] = null;
    if (!slot) continue;
    const piece = Rules.pieceById(slot.piece);
    const group = new Group();
    const hue = pal[slot.hue % pal.length]!;
    const mat = blockMaterial(hue, { emissive: hue, emissiveIntensity: 0.1 });
    const geo = detailed ? new RoundedBoxGeometry(0.62, 0.4, 0.62, bevel, 0.06) : new BoxGeometry(0.62, 0.4, 0.62);
    let minR = 99, maxR = -99, minC = 99, maxC = -99;
    for (const [dr, dc] of piece.cells) { minR = Math.min(minR, dr); maxR = Math.max(maxR, dr); minC = Math.min(minC, dc); maxC = Math.max(maxC, dc); }
    const offR = (minR + maxR) / 2, offC = (minC + maxC) / 2;
    for (const [dr, dc] of piece.cells) {
      const mesh = new Mesh(geo, mat);
      mesh.position.set((dc - offC) * 0.7, 0.25, (dr - offR) * 0.7);
      mesh.castShadow = (look?.shadows ?? 0) > 0;
      group.add(mesh);
      offerSlotOf.set(mesh, i);
    }
    // An unseen hit box over the piece's whole footprint, so a press in the
    // gap between its blocks (a square's or a bar's centre) still picks it.
    const hit = new Mesh(new BoxGeometry((maxC - minC) * 0.7 + 0.62, 0.4, (maxR - minR) * 0.7 + 0.62), offerHitMat);
    hit.position.set(0, 0.25, 0);
    hit.visible = false; // the ray still hits it (engine minor 18+, as three.js)
    group.add(hit);
    offerSlotOf.set(hit, i);
    group.position.set((i - 1) * 3.7, 0, 0);
    offerGroup.add(group);
    offerViews[i] = group;
    offerMats[i] = mat;
  }
  setSelectedSlot(sel);
}
export function setSelectedSlot(slot: number | null): void {
  selected = slot;
  if (!built) return;
  for (let i = 0; i < Rules.OFFER_COUNT; i++) {
    const g = offerViews[i], mat = offerMats[i];
    if (!g || !mat) continue;
    const sel = i === slot;
    g.position.y = sel ? 0.45 : 0;
    g.scale.setScalar(sel ? 1.12 : 1);
    mat.emissiveIntensity = sel ? 0.32 : 0.1;
  }
}

/** The ghost preview; returns whether the placement is legal. */
export function showGhost(board: number[][], pieceId: string, row: number, col: number, hue: number): boolean {
  const piece = Rules.pieceById(pieceId);
  const legal = Rules.canPlace(board, row, col, piece);
  if (!built) return legal;
  const pal = palette(), m = new Matrix4();
  ghostMat.color.set(legal ? pal[hue % pal.length]! : 0xff4444);
  ghostMat.opacity = legal ? 0.4 : 0.25;
  let k = 0;
  for (const [dr, dc] of piece.cells) {
    const r = row + dr, c = col + dc;
    if (r >= 0 && r < N && c >= 0 && c < N) { m.makeTranslation(cx(c), 0.25, cz(r)); ghost.setMatrixAt(k++, m); }
  }
  for (; k < 9; k++) ghost.setMatrixAt(k, zero);
  ghost.instanceMatrix.needsUpdate = true;
  ghost.visible = true;
  return legal;
}
export function hideGhost(): void {
  if (!built) return;
  ghost.visible = false;
  for (let k = 0; k < 9; k++) ghost.setMatrixAt(k, zero);
  ghost.instanceMatrix.needsUpdate = true;
}
export function setCursor(row: number, col: number, visible: boolean): void {
  if (!built) return;
  cursor.visible = visible;
  if (visible) cursor.position.set(cx(col), 0.09, cz(row));
}
/** Particles and flashes cleared when a round starts (no leftovers from the last one). */
export function resetEffects(): void {
  if (!built) return;
  pLife.fill(0);
  for (let k = 0; k < SPARK_MAX; k++) pPos[k * 3 + 1] = -100;
  points.geometry.attributes.position!.needsUpdate = true;
  for (let i = 0; i < flashes.length; i++) { flashes[i]!.visible = false; flashLife[i] = 0; }
  shakeAmp = 0;
}

// ---------------------------------------------------------------- framing (render.js resize)
let win = { w: 1, h: 1 };
let frameKey = "";
let offerShown = true;
/** Whether the 3D offer row shows (hidden in narrow portrait and short frames: the tray presents the pieces there). */
export function offerRowShown(): boolean { return offerShown; }
/**
 * Fit the authored view into the playfield `rect` (window px) below `top` and above `bottom` (window px from the
 * playfield's edges); `lw`/`lh` are the playfield's logical size (the old CSS pixels the breakpoints used).
 */
export function fit(W: number, H: number, rect: Rect, top: number, bottom: number, lw: number, lh: number): void {
  const key = [W, H, rect.x, rect.y, rect.width, rect.height, top, bottom, lw, lh].map((v) => Math.round(v)).join(":");
  if (key === frameKey || W <= 0 || H <= 0 || rect.width <= 0 || rect.height <= 0) return;
  frameKey = key;
  win = { w: W, h: H };
  const w = rect.width, h = rect.height;
  const safeH = Math.max(Math.min(h, 120 * (h / lh)), h - top - bottom);
  const aspect = w / safeH;
  offerShown = lw / lh >= 0.8 && lh >= 520;
  if (built) offerGroup.visible = offerShown;
  const short = lh < 520;
  const steep = Math.min(1, Math.max(0, (1 - aspect) / 0.4));
  const Hh = FRAMING.height + (FRAMING.steepHeight - FRAMING.height) * steep;
  const Dz = FRAMING.distance + (FRAMING.steepDistance - FRAMING.distance) * steep;
  const dir = new Vector3(0, short ? Hh * 1.25 : Hh, short ? Dz * 0.8 : Dz).sub(FRAMING.lookAt);
  const len0 = dir.length();
  dir.normalize();
  const R = BOARD_W / 2 + 0.45;
  const pts: Vector3[] = [];
  for (const x of [-R, R]) for (const z of [-R, R]) for (const y of [0, 0.7]) pts.push(new Vector3(x, y, z));
  if (offerShown) {
    const ox = FRAMING.offerHalfX, oz = FRAMING.offerHalfZ;
    for (const x of [-ox, ox]) for (const z of [OFFER_Z - oz, OFFER_Z + oz]) for (const y of [0, 1.2]) pts.push(new Vector3(x, y, z));
  }
  camera.clearViewOffset();
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const v = new Vector3();
  const bounds = (dist: number): { x0: number; x1: number; y0: number; y1: number } => {
    camera.position.copy(FRAMING.lookAt).addScaledVector(dir, dist);
    camera.lookAt(FRAMING.lookAt);
    camera.updateMatrixWorld(true);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      v.copy(p).project(camera);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    return { x0, x1, y0, y1 };
  };
  const MARGIN = 0.94;
  const fits = (b: { x0: number; x1: number; y0: number; y1: number }): boolean => b.x1 - b.x0 <= 2 * MARGIN && b.y1 - b.y0 <= 2 * MARGIN;
  let lo = len0 * 0.3, hi = len0 * 6;
  for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (fits(bounds(mid))) hi = mid; else lo = mid; }
  const b = bounds(hi);
  camBase.copy(camera.position);
  const ccx = (b.x0 + b.x1) / 2, ccy = (b.y0 + b.y1) / 2;
  // render.js: setViewOffset(w, safeH, ccx·w/2, −top − ccy·safeH/2, w, h) on the playfield's canvas; the window shows
  // that canvas at rect.x, rect.y, so the sub-view is the window's W × H moved by the rectangle's offset.
  camera.setViewOffset(w, safeH, (ccx * w) / 2 - rect.x, -top - (ccy * safeH) / 2 - rect.y, W, H);
  camera.far = Math.max(120, hi + 60);
  camera.updateProjectionMatrix();
  if (built && scene.fog) { (scene.fog as Fog).near = hi + 26 - len0; (scene.fog as Fog).far = hi + 60 - len0; }
}

// ---------------------------------------------------------------- picking (window px)
const ndc = new Vector2();
function ray(x: number, y: number): void {
  camera.position.copy(camBase);
  camera.updateMatrixWorld(true);
  ndc.set((x / win.w) * 2 - 1, -((y / win.h) * 2 - 1));
  raycaster.setFromCamera(ndc, camera);
}
const hit = new Vector3();
/** The board cell under a window point, or null (render.js pickCell: the y = 0 plane). */
export function pickCell(x: number, y: number): { row: number; col: number } | null {
  ray(x, y);
  if (!raycaster.ray.intersectPlane(floor, hit)) return null;
  const col = Math.round(hit.x / CELL + (N - 1) / 2), row = Math.round(hit.z / CELL + (N - 1) / 2);
  if (row < 0 || row >= N || col < 0 || col >= N) return null;
  return { row, col };
}
/** The 3D offer slot under a window point, or null. */
export function pickOffer(x: number, y: number): number | null {
  if (!built || !offerShown) return null;
  ray(x, y);
  for (const h of raycaster.intersectObjects(offerGroup.children, true)) {
    const s = offerSlotOf.get(h.object);
    if (s !== undefined) return s;
  }
  return null;
}
/** A cell's top face on screen (window px bounding box), for its named target. */
export function cellRect(row: number, col: number): Rect {
  camera.position.copy(camBase);
  camera.updateMatrixWorld(true);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const p = new Vector3();
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]] as const) {
    p.set(cx(col) + dx * CELL, 0, cz(row) + dz * CELL).project(camera);
    const sx = (p.x + 1) / 2 * win.w, sy = (1 - p.y) / 2 * win.h;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------- each frame
/** Shows (on the game screen) or hides the scene. */
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

export function update(dt: number): void {
  if (!built) return;
  dt = Math.min(0.05, dt);
  time += dt;
  // sparks
  let any = false;
  for (let k = 0; k < pMax; k++) {
    if (pLife[k]! <= 0) continue;
    any = true;
    pLife[k] = pLife[k]! - dt;
    pVel[k * 3 + 1] = pVel[k * 3 + 1]! - 9.8 * dt;
    pPos[k * 3] = pPos[k * 3]! + pVel[k * 3]! * dt;
    pPos[k * 3 + 1] = pPos[k * 3 + 1]! + pVel[k * 3 + 1]! * dt;
    pPos[k * 3 + 2] = pPos[k * 3 + 2]! + pVel[k * 3 + 2]! * dt;
    if (pLife[k]! <= 0) pPos[k * 3 + 1] = -100;
  }
  if (any) points.geometry.attributes.position!.needsUpdate = true;
  // flashes fade out
  for (let i = 0; i < flashes.length; i++) {
    const f = flashes[i]!;
    if (!f.visible) continue;
    flashLife[i] = flashLife[i]! - dt;
    if (flashLife[i]! <= 0) { f.visible = false; continue; }
    (f.material as MeshBasicMaterial).opacity = 0.55 * (flashLife[i]! / 0.45);
  }
  // gentle ambient motion (off with reduced motion or a static background)
  if (look?.animated && !reducedMotion) {
    glowMat.opacity = 0.06 + 0.025 * Math.sin(time * 0.8);
    for (let i = 0; i < mLive; i++) {
      const sd = mSeed[i]!;
      mPos[i * 3 + 1] = mPos[i * 3 + 1]! + dt * (0.12 + (sd % 1) * 0.1);
      mPos[i * 3] = mPos[i * 3]! + Math.sin(time * 0.3 + sd) * dt * 0.08;
      if (mPos[i * 3 + 1]! > 8) mPos[i * 3 + 1] = -1;
    }
    motes.geometry.attributes.position!.needsUpdate = true;
    const g = selected != null ? offerViews[selected] : null;
    if (g) g.position.y = 0.45 + Math.sin(time * 2.2) * 0.06;
  }
  // event camera shake: offsets the drawn view only (picking uses the resting camera)
  camera.position.copy(camBase);
  if (shakeAmp > 0.001) {
    const s = shakeAmp;
    shakeAmp *= Math.exp(-6 * dt);
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s * 0.5;
  }
}

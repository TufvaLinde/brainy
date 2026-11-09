/** The sphere: the library hung on a globe like works on a turning wall.
 *  Each tile is its picture, at the picture's own proportions, or a
 *  typographic card where there is none; longer pieces and stronger interests
 *  hang a little larger. Tiles sit on the globe but always face you, level,
 *  however it turns. It drifts, spins under your finger, breathes while the
 *  agent speaks, and brings a picked item to the front and out toward you.
 *  When the cloud redraws the clusters, tiles glide to their new places. */
import * as THREE from "three"
import type { CatalogItem, Cluster } from "@/lib/hybrid/types"

const R = 2.2
const FONT = `"Helvetica Neue", Helvetica, Arial, sans-serif`
const PAPER = "#ffffff"
const INK = "#111111"
const CAPTION = "#8b877f"

type Tile = {
  item: CatalogItem
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  from: THREE.Vector3
  to: THREE.Vector3
  /** Width and height in world units, as hung. */
  size: THREE.Vector2
  /** How large it hangs, from its length and how much its cluster pulls. */
  scale: number
  aspect: number | null
  texture: THREE.Texture | null
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Evenly spread points, pole to pole, so consecutive ones make bands. */
function fibonacci(i: number, n: number): THREE.Vector3 {
  const y = 1 - (2 * (i + 0.5)) / n
  const r = Math.sqrt(1 - y * y)
  const phi = i * Math.PI * (3 - Math.sqrt(5))
  return new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r).multiplyScalar(R)
}

export const thumbnail = (src: string, w = 384) => `/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=75`

export const kindLabel = (item: CatalogItem) =>
  item.kind === "article" ? "Essay" : item.kind.charAt(0).toUpperCase() + item.kind.slice(1)

export class Orb {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  private group = new THREE.Group()
  private ring: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private tiles = new Map<number, Tile>()
  private raf = 0
  private clock = new THREE.Clock()
  private velocity = new THREE.Vector2(0.0008, 0.00015)
  private dragging: { x: number; y: number; t: number; moved: number } | null = null
  private spin: { from: THREE.Quaternion; to: THREE.Quaternion; start: number; ms: number; done(): void } | null = null
  private layoutStart = -1
  /** How deeply it breathes, eased toward where it's heading: idle, thinking or speaking. */
  private energy = 0
  /** Where in a breath it is; advanced by each frame, so a change of pace never jumps. */
  private phase = 0
  private thinking = false
  private speakingUntil = 0
  private lifted: { tile: Tile; start: number; up: boolean } | null = null
  private paused = false
  private ro: ResizeObserver
  private onTap: (id: number) => void

  constructor(private host: HTMLElement, onTap: (id: number) => void) {
    this.onTap = onTap
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x000000, 0)
    host.appendChild(this.renderer.domElement)
    Object.assign(this.renderer.domElement.style, { width: "100%", height: "100%", display: "block", touchAction: "none" })
    this.camera.position.set(0, 0, 7.6)
    this.scene.add(this.group)

    // A hairline for the globe's edge, which breathes when the agent speaks.
    const points = Array.from({ length: 160 }, (_, i) => {
      const a = (i / 160) * Math.PI * 2
      return new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0)
    })
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: CAPTION, transparent: true, opacity: 0.35 }))
    this.scene.add(this.ring)

    this.renderer.domElement.addEventListener("pointerdown", this.down)
    addEventListener("pointermove", this.move)
    addEventListener("pointerup", this.up)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    document.addEventListener("visibilitychange", this.visibility)
    this.loop()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    removeEventListener("pointermove", this.move)
    removeEventListener("pointerup", this.up)
    document.removeEventListener("visibilitychange", this.visibility)
    for (const t of this.tiles.values()) { t.texture?.dispose(); t.mesh.material.dispose(); t.mesh.geometry.dispose() }
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private visibility = () => {
    this.paused = document.visibilityState !== "visible"
    if (!this.paused) { this.clock.getDelta(); this.loop() }
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // As close as keeps the globe, and the tiles hanging off its edge, in view across the narrower side.
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * Math.min(1, w / h)
    this.camera.position.z = (R * 1.12) / half
    this.camera.updateProjectionMatrix()
  }

  /** Hang the items, banded by cluster, the heaviest at the top. Tiles already hung glide to their new place. */
  setItems(items: CatalogItem[], clusters: Cluster[]) {
    const order = new Map(clusters.map((c, i) => [c.name, i]))
    const pull = new Map(clusters.map(c => [c.name, c.weight]))
    const sorted = [...items].sort((a, b) => (order.get(a.cluster ?? "") ?? 99) - (order.get(b.cluster ?? "") ?? 99) || a.id - b.id)
    // Fewer, larger tiles for a small library; the gap between them stays about the same.
    const spacing = Math.sqrt((4 * Math.PI * R * R) / Math.max(sorted.length, 30))
    const seen = new Set<number>()
    sorted.forEach((item, i) => {
      const p = fibonacci(i, sorted.length)
      const length = Math.min(1, Math.log2(Math.max(1, item.minutes)) / 6)
      const scale = spacing * (0.5 + 0.17 * length + 0.12 * (pull.get(item.cluster ?? "") ?? 0))
      seen.add(item.id)
      const tile = this.tiles.get(item.id)
      if (tile) {
        tile.from = tile.mesh.position.clone()
        tile.to = p
        const redraw = tile.item.title !== item.title || tile.item.image !== item.image
        tile.item = item
        tile.scale = scale
        if (redraw) this.paint(tile)
        this.fit(tile)
      } else {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, color: 0xffffff }))
        mesh.position.copy(p)
        mesh.userData.id = item.id
        this.group.add(mesh)
        const t: Tile = { item, mesh, from: p.clone(), to: p, size: new THREE.Vector2(), scale, aspect: null, texture: null }
        this.tiles.set(item.id, t)
        this.paint(t)
      }
    })
    for (const [id, t] of this.tiles) if (!seen.has(id)) { this.group.remove(t.mesh); t.texture?.dispose(); this.tiles.delete(id) }
    this.layoutStart = performance.now()
  }

  /** Its size as hung: the longer side at its scale, a portrait a little taller. */
  private fit(t: Tile) {
    const a = t.aspect ?? 0.75
    const long = t.scale * (a < 1 ? 1.12 : 1)
    t.size.set(a >= 1 ? long : long * a, a >= 1 ? long / a : long)
    t.mesh.scale.set(t.size.x, t.size.y, 1)
  }

  /** The typographic card first, the same for every item; its picture over it once loaded. */
  private paint(t: Tile) {
    t.texture?.dispose()
    t.aspect = null
    t.texture = poster(t.item)
    t.mesh.material.map = t.texture
    t.mesh.material.needsUpdate = true
    this.fit(t)
    if (!t.item.image) return
    const image = new Image()
    image.decoding = "async"
    image.onload = () => {
      if (!image.naturalWidth || this.tiles.get(t.item.id) !== t) return
      const texture = new THREE.Texture(image)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 4
      texture.needsUpdate = true
      t.texture?.dispose()
      t.texture = texture
      // Within reason: a banner or a sliver is hung as a calmer shape.
      t.aspect = Math.min(1.9, Math.max(0.6, image.naturalWidth / image.naturalHeight))
      t.mesh.material.map = texture
      t.mesh.material.needsUpdate = true
      this.fit(t)
    }
    image.src = thumbnail(t.item.image)
  }

  private down = (e: PointerEvent) => {
    if (this.spin || this.lifted?.up) return
    this.dragging = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }
    this.velocity.set(0, 0)
  }
  private move = (e: PointerEvent) => {
    if (!this.dragging) return
    const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y
    this.dragging.moved += Math.abs(dx) + Math.abs(dy)
    const now = performance.now()
    const dt = Math.max(1, now - this.dragging.t)
    this.rotate(dx * 0.006, dy * 0.006)
    this.velocity.set((dx * 0.006) / dt * 16, (dy * 0.006) / dt * 16)
    Object.assign(this.dragging, { x: e.clientX, y: e.clientY, t: now })
  }
  private up = (e: PointerEvent) => {
    const drag = this.dragging
    this.dragging = null
    if (!drag || drag.moved > 8) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera)
    // Only the near side: a tile seen through the globe isn't a target.
    const v = new THREE.Vector3()
    const hit = ray.intersectObjects([...this.tiles.values()].map(t => t.mesh)).find(h => h.object.getWorldPosition(v).z > 0)
    if (hit) this.onTap(hit.object.userData.id)
  }

  private rotate(x: number, y: number) {
    this.group.quaternion.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(y, x, 0, "XYZ")))
  }

  /** A breath: each word the agent says. */
  /** A sign of speech: keeps it breathing as if speaking a little longer. Never a jolt: the breath itself only eases. */
  pulse(amount = 0.5) { this.speakingUntil = Math.max(this.speakingUntil, performance.now() + 500 + amount * 1200) }
  setThinking(on: boolean) { this.thinking = on }

  /** Bring an item round to the front, then out toward you. Tiles are always level, so only the turn is needed. */
  focus(id: number): Promise<void> {
    const tile = this.tiles.get(id)
    if (!tile) return Promise.resolve()
    if (this.lifted && this.lifted.tile !== tile) this.lifted = { tile: this.lifted.tile, start: performance.now(), up: false }
    this.velocity.set(0, 0)
    const facing = tile.to.clone().normalize().applyQuaternion(this.group.quaternion)
    const to = new THREE.Quaternion().setFromUnitVectors(facing, new THREE.Vector3(0, 0, 1)).multiply(this.group.quaternion)
    const angle = this.group.quaternion.angleTo(to)
    return new Promise(resolve => {
      this.spin = {
        from: this.group.quaternion.clone(), to, start: performance.now(), ms: 450 + angle * 400,
        done: () => {
          this.lifted = { tile, start: performance.now(), up: true }
          setTimeout(resolve, 360)
        },
      }
    })
  }

  /** Hang a lifted item back, and let the globe drift again. */
  release() {
    if (this.lifted) this.lifted = { ...this.lifted, start: performance.now(), up: false }
    this.velocity.set(0.0008, 0.00015)
  }

  private loop = () => {
    if (this.paused) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, this.clock.getDelta())
    const now = performance.now()
    if (this.spin) {
      const t = Math.min(1, (now - this.spin.start) / this.spin.ms)
      this.group.quaternion.slerpQuaternions(this.spin.from, this.spin.to, ease(t))
      if (t >= 1) { const done = this.spin.done; this.spin = null; done() }
    } else if (!this.dragging && !this.lifted?.up) {
      this.rotate(this.velocity.x, this.velocity.y)
      // Inertia settles to a slow drift.
      this.velocity.lerp(new THREE.Vector2(0.0008, 0.00015), 1 - Math.exp(-dt * 1.4))
    }
    const layout = this.layoutStart >= 0 ? ease(Math.min(1, (now - this.layoutStart) / 1600)) : 1
    if (layout >= 1) this.layoutStart = -1
    // Every tile faces you, level: the globe's turn undone for each.
    const level = this.group.quaternion.clone().invert()
    const v = new THREE.Vector3()
    for (const tile of this.tiles.values()) {
      const lifted = this.lifted?.tile === tile
      if (!lifted) {
        // Over the surface, not through the middle.
        tile.mesh.position.lerpVectors(tile.from, tile.to, layout).setLength(R + Math.sin(layout * Math.PI) * 0.45)
        tile.mesh.scale.set(tile.size.x, tile.size.y, 1)
      }
      tile.mesh.quaternion.copy(level)
      tile.mesh.getWorldPosition(v)
      // Near tiles solid, those round the back a faint trace.
      const depth = Math.max(0, Math.min(1, (v.z / R + 0.25) / 1.25))
      tile.mesh.material.opacity = lifted ? 1 : (this.lifted ? 0.35 : 1) * (0.04 + 0.96 * depth ** 2.2)
      tile.mesh.renderOrder = lifted ? 50 : v.z
    }
    if (this.lifted) {
      const { tile, start, up } = this.lifted
      const t = Math.min(1, (now - start) / 520)
      const k = up ? ease(t) : 1 - ease(t)
      // Out toward you and up the screen, in the turned globe's own axes.
      tile.mesh.position.copy(tile.to).setLength(R + k * 2)
      tile.mesh.position.add(new THREE.Vector3(0, k * 0.35, 0).applyQuaternion(level))
      tile.mesh.scale.set(tile.size.x * (1 + k * 1.3), tile.size.y * (1 + k * 1.3), 1)
      if (!up && t >= 1) this.lifted = null
    }
    // Breath: a slow, even rise and fall. Speaking breathes deepest and quickest, thinking a little, rest barely.
    const target = now < this.speakingUntil ? 1 : this.thinking ? 0.6 : 0.15
    this.energy += (target - this.energy) * (1 - Math.exp(-dt * 1.6))
    const period = 5.5 - 3.3 * this.energy
    this.phase += (dt / period) * Math.PI * 2
    const breath = (1 - Math.cos(this.phase)) / 2
    const depth = breath * this.energy
    this.group.scale.setScalar(1 + depth * 0.03)
    this.ring.scale.setScalar(1 + depth * 0.06)
    this.ring.material.opacity = 0.18 + depth * 0.45
    this.renderer.render(this.scene, this.camera)
  }
}

/** An exhibition poster for an item without a picture: its title, set large and tight, black on paper. */
function poster(item: CatalogItem): THREE.CanvasTexture {
  const canvas = document.createElement("canvas")
  canvas.width = 384
  canvas.height = 512
  const g = canvas.getContext("2d")!
  g.fillStyle = PAPER
  g.fillRect(0, 0, canvas.width, canvas.height)
  const pad = 30, width = canvas.width - pad * 2
  // The largest size the title fits in, in five lines at most.
  let size = 64, lines: string[] = []
  for (; size >= 26; size -= 4) {
    g.font = `700 ${size}px ${FONT}`
    g.letterSpacing = `${-size * 0.03}px`
    lines = wrap(g, item.title, width)
    if (lines.length <= 5 && lines.length * size * 0.98 < canvas.height - 120) break
  }
  g.fillStyle = INK
  g.textBaseline = "top"
  lines.slice(0, 5).forEach((line, i) => g.fillText(line, pad, pad + i * size * 0.98, width))
  g.font = `400 22px ${FONT}`
  g.letterSpacing = "0px"
  g.fillStyle = CAPTION
  g.textBaseline = "alphabetic"
  g.fillText(`${item.minutes} min · ${kindLabel(item)}`, pad, canvas.height - pad, width)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let row = ""
  for (const word of text.trim().split(/\s+/)) {
    const test = row ? `${row} ${word}` : word
    if (g.measureText(test).width > width && row) { lines.push(row); row = word } else row = test
  }
  if (row) lines.push(row)
  if (lines.length > 5) lines[4] = `${lines[4]}…`
  return lines
}

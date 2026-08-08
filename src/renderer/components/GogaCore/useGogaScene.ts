import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { GogaVisualState } from './GogaVisualState'

// ── PALETTE ──────────────────────────────────────────────────────────────────
const C = {
  bg:           0x06050e,
  deepViolet:   0x5b21ff,
  elecPurple:   0x8b5cff,
  lavender:     0xb794ff,
  cyan:         0x29d9ff,
  coreWhite:    0xf0e8ff,
  amber:        0xffaa22,
  teal:         0x00ffcc,
  red:          0xff2244,
}

// Equilateral triangle outline — exactly 3 edges, closed, NO diagonals
function triOutline(size: number): THREE.BufferGeometry {
  const h = size * Math.sqrt(3) / 2
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,          h * 0.6667,  0),
    new THREE.Vector3(-size / 2, -h * 0.3333,  0),
    new THREE.Vector3( size / 2, -h * 0.3333,  0),
    new THREE.Vector3(0,          h * 0.6667,  0), // close
  ])
}

// Solid filled triangle
function triFill(size: number): THREE.BufferGeometry {
  const h = size * Math.sqrt(3) / 2
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0,          h * 0.6667,  0,
   -size / 2,  -h * 0.3333,  0,
    size / 2,  -h * 0.3333,  0,
  ]), 3))
  geo.setIndex([0, 1, 2])
  return geo
}

const LAYERS = 9
const PARTICLES = 120

interface SR {
  renderer: THREE.WebGLRenderer
  composer: EffectComposer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  group: THREE.Group
  // Each layer = 3 lines: glow (wide, transparent), mid, bright inner
  layers: { glow: THREE.Line; mid: THREE.Line; inner: THREE.Line; baseZ: number; baseRotZ: number }[]
  coreFill: THREE.Mesh; coreMat: THREE.MeshBasicMaterial
  halo1: THREE.Mesh; halo1Mat: THREE.MeshBasicMaterial
  halo2: THREE.Mesh; halo2Mat: THREE.MeshBasicMaterial
  coreRing: THREE.Line; coreRingMat: THREE.LineBasicMaterial
  particles: THREE.Points; pPos: Float32Array
  bloom: UnrealBloomPass
  clock: THREE.Clock; frameId: number
  vs: GogaVisualState; amp: number
  userRotY: number; userScale: number
  pLight: THREE.PointLight; cLight: THREE.PointLight
}

export function useGogaScene(
  canvasRef: React.RefObject<HTMLCanvasElement>,
  visualState: GogaVisualState,
  audioAmplitude: number
) {
  const r = useRef<SR | null>(null)

  const rotateBy = useCallback((d: number) => { if (r.current) r.current.userRotY += d }, [])
  const scaleBy  = useCallback((f: number) => {
    if (r.current) r.current.userScale = Math.max(0.5, Math.min(2.2, r.current.userScale * f))
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(canvas.clientWidth, canvas.clientHeight)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(C.bg)

    const camera = new THREE.PerspectiveCamera(38, canvas.clientWidth / canvas.clientHeight, 0.1, 100)
    camera.position.set(0, 0.1, 8.0)

    // Lights
    scene.add(new THREE.AmbientLight(0x110022, 0.4))
    const pLight = new THREE.PointLight(C.elecPurple, 5, 16)
    pLight.position.set(0, 0.4, 3.5)
    scene.add(pLight)
    const cLight = new THREE.PointLight(C.cyan, 2.5, 12)
    cLight.position.set(1.2, -0.3, 2.5)
    scene.add(cLight)

    // ── TRIANGLE LAYERS ───────────────────────────────────────────────────────
    const group = new THREE.Group()
    scene.add(group)

    const outerSize = 3.0
    const innerSize = 0.65
    type LayerObj = { glow: THREE.Line; mid: THREE.Line; inner: THREE.Line; baseZ: number; baseRotZ: number }
    const layers: LayerObj[] = []

    for (let i = 0; i < LAYERS; i++) {
      const t = i / (LAYERS - 1)           // 0 = outermost, 1 = innermost
      const size = outerSize - t * (outerSize - innerSize)

      // Z: outer layers pushed back, inner layers forward — creates depth tunnel
      const baseZ = (t - 0.5) * 2.2

      // Rotation: TINY offsets only — ±4° max, alternating, so silhouette stays △
      const baseRotZ = (i % 2 === 0 ? 1 : -1) * (i * 0.008)   // ~0–4° total

      // Color gradient: outer=deepViolet → inner=lavender
      const col = new THREE.Color().lerpColors(
        new THREE.Color(C.deepViolet), new THREE.Color(C.lavender), t
      )
      const glowCol = new THREE.Color().lerpColors(
        new THREE.Color(C.deepViolet), new THREE.Color(C.elecPurple), t
      )

      // Glow layer — wide, very transparent purple
      const glowMat = new THREE.LineBasicMaterial({ color: glowCol, transparent: true, opacity: 0.18 + t * 0.12 })
      const glowLine = new THREE.Line(triOutline(size * 1.018), glowMat)

      // Mid layer — medium opacity
      const midMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.45 + t * 0.3 })
      const midLine = new THREE.Line(triOutline(size), midMat)

      // Inner bright line — high opacity, slightly smaller
      const innerCol = new THREE.Color().lerpColors(new THREE.Color(C.elecPurple), new THREE.Color(C.coreWhite), t * 0.5)
      const innerMat = new THREE.LineBasicMaterial({ color: innerCol, transparent: true, opacity: 0.7 + t * 0.25 })
      const innerLine = new THREE.Line(triOutline(size * 0.984), innerMat)

      // Subtle translucent fill — holographic glass feel
      const fillGeo = triFill(size)
      const fillMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(C.elecPurple),
        transparent: true,
        opacity: 0.018 + t * 0.012,
        side: THREE.DoubleSide,
      })
      const fillMesh = new THREE.Mesh(fillGeo, fillMat)

      const layerGroup = new THREE.Group()
      layerGroup.add(glowLine, midLine, innerLine, fillMesh)
      layerGroup.position.z = baseZ
      layerGroup.rotation.z = baseRotZ
      group.add(layerGroup)

      layers.push({ glow: glowLine, mid: midLine, inner: innerLine, baseZ, baseRotZ })
    }

    // ── CORE ──────────────────────────────────────────────────────────────────
    // Outer halo (large, very transparent cyan)
    const halo2Geo = triFill(0.72)
    const halo2Mat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.06, side: THREE.DoubleSide })
    const halo2 = new THREE.Mesh(halo2Geo, halo2Mat)
    halo2.position.z = 1.15
    scene.add(halo2)

    // Inner halo (medium, cyan)
    const halo1Geo = triFill(0.46)
    const halo1Mat = new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.14, side: THREE.DoubleSide })
    const halo1 = new THREE.Mesh(halo1Geo, halo1Mat)
    halo1.position.z = 1.18
    scene.add(halo1)

    // Core fill — bright white/lavender
    const coreFillGeo = triFill(0.28)
    const coreMat = new THREE.MeshBasicMaterial({ color: C.coreWhite, transparent: true, opacity: 0.97, side: THREE.DoubleSide })
    const coreFill = new THREE.Mesh(coreFillGeo, coreMat)
    coreFill.position.z = 1.22
    scene.add(coreFill)

    // Core outline ring — bright cyan
    const coreRingMat = new THREE.LineBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.95 })
    const coreRing = new THREE.Line(triOutline(0.32), coreRingMat)
    coreRing.position.z = 1.23
    scene.add(coreRing)

    // ── PARTICLES ─────────────────────────────────────────────────────────────
    const pPos = new Float32Array(PARTICLES * 3)
    for (let i = 0; i < PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2
      const rad = 1.0 + Math.random() * 2.2
      pPos[i*3]   = Math.cos(a) * rad
      pPos[i*3+1] = Math.sin(a) * rad * 0.88
      pPos[i*3+2] = (Math.random() - 0.5) * 2.0
    }
    const pGeo = new THREE.BufferGeometry()
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    const pMat = new THREE.PointsMaterial({ color: C.elecPurple, size: 0.02, transparent: true, opacity: 0.45, sizeAttenuation: true })
    const particles = new THREE.Points(pGeo, pMat)
    scene.add(particles)

    // ── BLOOM ─────────────────────────────────────────────────────────────────
    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(canvas.clientWidth, canvas.clientHeight), 1.8, 0.6, 0.15)
    composer.addPass(bloom)

    const clock = new THREE.Clock()

    r.current = {
      renderer, composer, scene, camera,
      group, layers,
      coreFill, coreMat, halo1, halo1Mat, halo2, halo2Mat, coreRing, coreRingMat,
      particles, pPos, bloom, clock, frameId: 0,
      vs: 'idle', amp: 0, userRotY: 0, userScale: 1,
      pLight, cLight,
    }

    const ro = new ResizeObserver(() => {
      if (!r.current) return
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (w === 0 || h === 0) return
      r.current.camera.aspect = w / h
      // Adjust FOV so triangle always fits — taller container = narrower FOV
      r.current.camera.fov = Math.max(28, Math.min(55, 38 * (400 / Math.max(h, 100))))
      r.current.camera.updateProjectionMatrix()
      r.current.renderer.setSize(w, h)
      r.current.composer.setSize(w, h)
      r.current.bloom.setSize(w, h)
    })
    ro.observe(canvas)

    // ── ANIMATION LOOP ────────────────────────────────────────────────────────
    function animate() {
      const s = r.current
      if (!s) return
      s.frameId = requestAnimationFrame(animate)
      const t = s.clock.getElapsedTime()
      const vs = s.vs

      // Gesture
      s.userRotY *= 0.90
      s.group.rotation.y += s.userRotY * 0.04
      const gs = s.userScale
      s.group.scale.lerp(new THREE.Vector3(gs, gs, gs), 0.06)

      // ── State params ─────────────────────────────────────────────────────
      let bloomTarget   = 1.8
      let zSpread       = 2.2
      let rotSpeed      = 0.0008   // very slow idle
      let coreScale     = 1.0
      let coreCol       = new THREE.Color(C.coreWhite)
      let haloCol       = new THREE.Color(C.cyan)
      let h1Opacity     = 0.14
      let h2Opacity     = 0.06
      let pSpeed        = 0.00025
      let pCol          = new THREE.Color(C.elecPurple)
      let outerCol      = new THREE.Color(C.deepViolet)
      let innerCol      = new THREE.Color(C.lavender)
      let glitch        = false

      if (vs === 'idle') {
        const b = Math.sin(t * 0.5)
        bloomTarget = 1.7 + b * 0.15
        coreScale   = 1.0 + Math.sin(t * 0.85) * 0.07
        h1Opacity   = 0.12 + Math.sin(t * 0.7) * 0.04
        h2Opacity   = 0.05 + Math.sin(t * 0.6) * 0.02
        // Tiny floating: group drifts very slightly
        s.group.position.y = Math.sin(t * 0.4) * 0.04

      } else if (vs === 'listening') {
        bloomTarget = 2.1; rotSpeed = 0.002
        outerCol = new THREE.Color(C.cyan); innerCol = new THREE.Color(C.coreWhite)
        coreCol = new THREE.Color(C.cyan); haloCol = new THREE.Color(C.cyan)
        h1Opacity = 0.25; h2Opacity = 0.12
        coreScale = 1.2 + Math.sin(t * 5) * 0.1
        pCol = new THREE.Color(C.cyan); pSpeed = 0.0006

      } else if (vs === 'transcribing') {
        // Ripples move inward — layers pulse from outer to inner
        bloomTarget = 1.9; rotSpeed = 0.001
        outerCol = new THREE.Color(C.cyan); innerCol = new THREE.Color(C.coreWhite)
        coreCol = new THREE.Color(C.cyan); haloCol = new THREE.Color(C.cyan)
        h1Opacity = 0.18 + Math.sin(t * 8) * 0.08
        h2Opacity = 0.08 + Math.sin(t * 8 + 1) * 0.04
        coreScale = 1.1 + Math.sin(t * 6) * 0.08
        pCol = new THREE.Color(C.cyan); pSpeed = 0.0004

      } else if (vs === 'thinking') {
        bloomTarget = 2.0; zSpread = 3.2; rotSpeed = 0.004
        coreScale = 1.1 + Math.sin(t * 7) * 0.14
        h1Opacity = 0.2; h2Opacity = 0.1
        innerCol = new THREE.Color(C.cyan)
        pSpeed = 0.001

      } else if (vs === 'acting') {
        bloomTarget = 2.3; rotSpeed = 0.01
        outerCol = new THREE.Color(C.elecPurple); innerCol = new THREE.Color(C.cyan)
        coreScale = 1.3; h1Opacity = 0.3; h2Opacity = 0.15
        pCol = new THREE.Color(C.lavender); pSpeed = 0.0018

      } else if (vs === 'seeing') {
        bloomTarget = 1.9
        coreCol = new THREE.Color(C.cyan); haloCol = new THREE.Color(C.cyan)
        h1Opacity = 0.22; h2Opacity = 0.1
        // Scan: group tilts slightly
        s.group.rotation.x = Math.sin(t * 1.2) * 0.08

      } else if (vs === 'searching') {
        bloomTarget = 1.8; rotSpeed = 0.003
        pCol = new THREE.Color(C.cyan); pSpeed = 0.002

      } else if (vs === 'speaking') {
        const a = s.amp
        bloomTarget = 1.6 + a * 1.6
        coreScale = 1.0 + a * 1.8
        h1Opacity = 0.14 + a * 0.28
        h2Opacity = 0.06 + a * 0.14

      } else if (vs === 'waitingApproval') {
        bloomTarget = 1.6; rotSpeed = 0.0005
        outerCol = new THREE.Color(C.amber); innerCol = new THREE.Color(C.amber)
        coreCol = new THREE.Color(C.amber); haloCol = new THREE.Color(C.amber)
        h1Opacity = 0.15 + Math.sin(t * 2.5) * 0.1

      } else if (vs === 'success') {
        bloomTarget = 2.5
        outerCol = new THREE.Color(C.teal); innerCol = new THREE.Color(C.teal)
        coreCol = new THREE.Color(C.teal); haloCol = new THREE.Color(C.teal)
        coreScale = 1.5; h1Opacity = 0.35; h2Opacity = 0.18
        pCol = new THREE.Color(C.teal); pSpeed = 0.0012

      } else if (vs === 'error') {
        glitch = true; bloomTarget = 2.0
        outerCol = new THREE.Color(C.red); innerCol = new THREE.Color(C.red)
        coreCol = new THREE.Color(C.red); haloCol = new THREE.Color(C.red)

      } else if (vs === 'stopped') {
        bloomTarget = 0.9; rotSpeed = 0.0002; pSpeed = 0.0001
      }

      // Reset non-seeing tilt
      if (vs !== 'seeing') s.group.rotation.x *= 0.95

      // Glitch
      if (glitch) {
        s.group.position.x = (Math.random() - 0.5) * 0.04
        s.group.position.y = (Math.random() - 0.5) * 0.04
      } else if (vs !== 'idle') {
        s.group.position.x *= 0.85
        if (vs !== 'idle') s.group.position.y *= 0.85
      }

      // ── Update layers ─────────────────────────────────────────────────────
      for (let i = 0; i < LAYERS; i++) {
        const layer = s.layers[i]
        const ti = i / (LAYERS - 1)
        const layerGroup = s.group.children[i] as THREE.Group

        // Z depth — lerp toward target spread
        const targetZ = (ti - 0.5) * zSpread
        layerGroup.position.z += (targetZ - layerGroup.position.z) * 0.035

        // Rotation: base offset + very slow drift — stays near △
        const dir = i % 2 === 0 ? 1 : -1
        layerGroup.rotation.z = layer.baseRotZ + Math.sin(t * 0.15 * (1 + i * 0.1)) * 0.03 * dir
        // During thinking/acting: slightly more rotation but still bounded
        if (vs === 'thinking' || vs === 'acting') {
          layerGroup.rotation.z += dir * rotSpeed * (1 + ti) * t * 0.1
          // Clamp to ±10°
          layerGroup.rotation.z = Math.max(-0.175, Math.min(0.175, layerGroup.rotation.z))
        }

        // Color lerp
        const tCol = new THREE.Color().lerpColors(outerCol, innerCol, ti)
        const glowMat = (layer.glow.material as THREE.LineBasicMaterial)
        const midMat  = (layer.mid.material  as THREE.LineBasicMaterial)
        const innerMat = (layer.inner.material as THREE.LineBasicMaterial)
        glowMat.color.lerp(tCol, 0.04)
        midMat.color.lerp(tCol, 0.04)
        innerMat.color.lerp(new THREE.Color().lerpColors(tCol, new THREE.Color(C.coreWhite), ti * 0.4), 0.04)

        // Subtle opacity breathe
        midMat.opacity = (0.4 + ti * 0.35) + Math.sin(t * 0.6 + i * 0.5) * 0.04
      }

      // ── Core ─────────────────────────────────────────────────────────────
      s.coreMat.color.lerp(coreCol, 0.07)
      s.coreFill.scale.setScalar(coreScale)
      s.coreFill.rotation.z += 0.006

      s.halo1Mat.color.lerp(haloCol, 0.07)
      s.halo1Mat.opacity += (h1Opacity - s.halo1Mat.opacity) * 0.06
      s.halo1.scale.setScalar(coreScale * (1 + Math.sin(t * 1.4) * 0.05))

      s.halo2Mat.color.lerp(haloCol, 0.07)
      s.halo2Mat.opacity += (h2Opacity - s.halo2Mat.opacity) * 0.06
      s.halo2.scale.setScalar(coreScale * (1 + Math.sin(t * 0.9) * 0.07))

      s.coreRingMat.color.lerp(new THREE.Color(C.cyan), 0.06)

      // ── Particles ─────────────────────────────────────────────────────────
      for (let i = 0; i < PARTICLES; i++) {
        const ix = i * 3
        const px = s.pPos[ix], py = s.pPos[ix+1]
        const a = Math.atan2(py, px) + pSpeed * 60
        const rad = Math.sqrt(px*px + py*py)
        s.pPos[ix]   = Math.cos(a) * rad
        s.pPos[ix+1] = Math.sin(a) * rad
      }
      ;(s.particles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
      ;(s.particles.material as THREE.PointsMaterial).color.lerp(pCol, 0.04)

      // ── Bloom ─────────────────────────────────────────────────────────────
      s.bloom.strength += (bloomTarget - s.bloom.strength) * 0.05

      composer.render()
    }

    animate()

    return () => {
      if (r.current) { cancelAnimationFrame(r.current.frameId); r.current.renderer.dispose(); r.current.composer.dispose() }
      ro.disconnect()
      r.current = null
    }
  }, [canvasRef])

  useEffect(() => { if (r.current) r.current.vs  = visualState    }, [visualState])
  useEffect(() => { if (r.current) r.current.amp = audioAmplitude }, [audioAmplitude])

  return { rotateBy, scaleBy }
}

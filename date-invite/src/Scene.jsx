/* eslint-disable react/no-unknown-property */
// WebGL sunset scene. Coordinate system: camera near origin looking down -z,
// water plane at y=0 stretching to z=-520, sun disc half-sunk behind its far edge.
import { useMemo, useRef, useEffect, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'

// ── timing helpers ───────────────────────────────────────────────────────────
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t) => t * t * (3 - 2 * t)
const backOut = (t) => { const c = 1.7; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u }

/** Seconds since the grow phase began (0 while on the start screen). */
function useGrowClock(growT0, reduced) {
  const get = () => {
    if (reduced) return 99
    return growT0.current ? (performance.now() - growT0.current) / 1000 : 0
  }
  return get
}

// ── sky ──────────────────────────────────────────────────────────────────────
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform float uGlow; // 0..1 sunrise progress
  void main() {
    float h = vDir.y;
    vec3 indigo  = vec3(0.055, 0.03, 0.13);
    vec3 violet  = vec3(0.24, 0.09, 0.32);
    vec3 crimson = vec3(0.55, 0.13, 0.24);
    vec3 orange  = vec3(0.80, 0.28, 0.10);
    vec3 gold    = vec3(1.15, 0.72, 0.30);
    vec3 below   = vec3(0.07, 0.03, 0.09);

    vec3 c = indigo;
    c = mix(violet,  c, smoothstep(0.18, 0.55, h));
    c = mix(crimson, c, smoothstep(0.09, 0.26, h));
    c = mix(orange,  c, smoothstep(0.035, 0.13, h));
    c = mix(gold,    c, smoothstep(0.0, 0.06, h));
    c = mix(below, c, smoothstep(-0.02, 0.0, h));

    // warm halo around the sun's azimuth (-z), strongest at the horizon
    float azim = max(0.0, -vDir.z);
    float halo = pow(azim, 6.0) * exp(-abs(h - 0.035) * 14.0);
    c += vec3(1.0, 0.55, 0.18) * halo * (0.55 * uGlow);

    gl_FragColor = vec4(c, 1.0);
  }
`
function Sky({ getGrow }) {
  const mat = useRef()
  useFrame(() => {
    if (mat.current) mat.current.uniforms.uGlow.value = clamp01(getGrow() / 4)
  })
  const uniforms = useMemo(() => ({ uGlow: { value: 0 } }), [])
  return (
    <mesh scale={[1, 1, 1]}>
      <sphereGeometry args={[700, 32, 24]} />
      <shaderMaterial ref={mat} side={THREE.BackSide} depthWrite={false}
        vertexShader={SKY_VERT} fragmentShader={SKY_FRAG} uniforms={uniforms} />
    </mesh>
  )
}

// ── sun + glow + god rays + haze bands + lens streak ─────────────────────────
function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const x = c.getContext('2d')
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255, 236, 200, 1)')
  g.addColorStop(0.25, 'rgba(255, 190, 110, 0.55)')
  g.addColorStop(0.6, 'rgba(255, 130, 60, 0.18)')
  g.addColorStop(1, 'rgba(255, 100, 40, 0)')
  x.fillStyle = g
  x.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  return t
}

let bandAlphaTex
function makeBandAlpha() {
  if (bandAlphaTex) return bandAlphaTex
  const c = document.createElement('canvas')
  c.width = 256; c.height = 4
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, 256, 0)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.3, 'rgba(255,255,255,1)')
  g.addColorStop(0.7, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, 256, 4)
  bandAlphaTex = new THREE.CanvasTexture(c)
  return bandAlphaTex
}

const RAYS_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uGlow;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);
    float rays = pow(abs(sin(a * 7.0 + uTime * 0.12)), 3.0)
               + 0.6 * pow(abs(sin(a * 11.0 - uTime * 0.07)), 4.0);
    float fall = exp(-r * 4.6) * smoothstep(0.85, 0.1, r);
    vec3 col = vec3(1.0, 0.72, 0.38) * rays * fall * 0.55 * uGlow;
    gl_FragColor = vec4(col, 1.0);
  }
`
const RAYS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

function Sun({ getGrow }) {
  const group = useRef()
  const rays = useRef()
  const glowTex = useMemo(makeGlowTexture, [])
  useFrame(({ clock }) => {
    const g = getGrow()
    // rise over ~4.5s, then (cinematic time passing) sink very slowly after 12s
    const rise = easeInOut(clamp01(g / 4.5))
    const sink = Math.min(7, Math.max(0, (g - 12) * 0.12))
    const y = THREE.MathUtils.lerp(-26, 11, rise) - sink
    if (group.current) group.current.position.y = y
    if (rays.current) {
      rays.current.material.uniforms.uTime.value = clock.elapsedTime
      rays.current.material.uniforms.uGlow.value = clamp01((g - 0.6) / 3.5)
    }
  })
  const raysUniforms = useMemo(() => ({ uTime: { value: 0 }, uGlow: { value: 0 } }), [])
  return (
    <group ref={group} position={[0, -26, 0]}>
      {/* blown-out core disc */}
      <mesh position={[0, 0, -520]}>
        <circleGeometry args={[34, 64]} />
        <meshBasicMaterial color={[3.2, 2.35, 1.5]} toneMapped={false} />
      </mesh>
      {/* atmospheric haze bands slicing the disc — alpha fades at the ends */}
      {[[-4, 2.4, 0.5], [4, 1.6, 0.38], [12, 1.1, 0.3]].map(([hy, hh, op], i) => (
        <mesh key={i} position={[0, hy, -516]}>
          <planeGeometry args={[110, hh]} />
          <meshBasicMaterial color="#3d1024" transparent opacity={op} depthWrite={false}
            alphaMap={makeBandAlpha()} />
        </mesh>
      ))}
      {/* volumetric-ish glow */}
      <sprite position={[0, 2, -519]} scale={[300, 300, 1]}>
        <spriteMaterial map={glowTex} blending={THREE.AdditiveBlending} depthWrite={false} opacity={0.85} />
      </sprite>
      {/* rotating god rays — depth-tested so the sea occludes them below the horizon */}
      <mesh ref={rays} position={[0, 2, -518]}>
        <planeGeometry args={[300, 300]} />
        <shaderMaterial vertexShader={RAYS_VERT} fragmentShader={RAYS_FRAG} uniforms={raysUniforms}
          blending={THREE.AdditiveBlending} depthWrite={false} transparent />
      </mesh>
      {/* anamorphic lens streak */}
      <mesh position={[0, 1, -517]}>
        <planeGeometry args={[560, 5]} />
        <meshBasicMaterial color={[1.4, 0.9, 0.5]} toneMapped={false} transparent opacity={0.16}
          blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

// ── water ────────────────────────────────────────────────────────────────────
const WATER_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`
const WATER_FRAG = /* glsl */ `
  varying vec3 vWorld;
  uniform float uTime;
  uniform float uGlow;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float wx = vWorld.x;
    float wz = vWorld.z;                     // 0 near camera → -520 horizon
    float depth = clamp(-wz / 520.0, 0.0, 1.0);

    // base sea — deep plum near camera, warm near horizon
    vec3 nearC = vec3(0.045, 0.02, 0.07);
    vec3 farC  = vec3(0.30, 0.10, 0.13);
    vec3 c = mix(nearC, farC, pow(depth, 2.2));

    // world-space ripple field (two drifting octaves) — no uv aliasing
    vec2 rp = vec2(wx * 0.55, wz * 0.9);
    float n = noise(rp + vec2(uTime * 0.35, uTime * 1.1))
            * noise(rp * 2.3 - vec2(uTime * 0.5, uTime * 0.8));

    // specular sun path — a column under the sun (x≈0), soft edges
    float sigma = mix(3.0, 24.0, depth);
    float path = exp(-(wx * wx) / (sigma * sigma));
    float glint = smoothstep(0.28, 0.60, n);
    vec3 gold = vec3(1.35, 0.78, 0.32);
    c += gold * path * (0.16 + 1.25 * glint) * (0.22 + 0.78 * pow(depth, 1.3)) * uGlow;

    // faint overall shimmer away from the path
    c += vec3(0.35, 0.16, 0.14) * glint * 0.09 * pow(depth, 2.0) * uGlow;

    // horizon glow line
    c += vec3(1.1, 0.6, 0.25) * smoothstep(0.965, 1.0, depth) * 0.7 * uGlow;

    gl_FragColor = vec4(c, 1.0);
  }
`
function Water({ getGrow }) {
  const mat = useRef()
  useFrame(({ clock }) => {
    if (!mat.current) return
    mat.current.uniforms.uTime.value = clock.elapsedTime
    mat.current.uniforms.uGlow.value = clamp01(getGrow() / 4.5)
  })
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uGlow: { value: 0 } }), [])
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -252]}>
      <planeGeometry args={[900, 540, 1, 1]} />
      <shaderMaterial ref={mat} vertexShader={WATER_VERT} fragmentShader={WATER_FRAG} uniforms={uniforms} />
    </mesh>
  )
}

// ── foreground silhouette banks ──────────────────────────────────────────────
function bankGeometry(width, height, seed) {
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -2)
  const steps = 24
  for (let i = 0; i <= steps; i++) {
    const x = -width / 2 + (i / steps) * width
    const y = height * (0.55 + 0.45 * Math.sin(i * 0.9 + seed) * Math.sin(i * 0.37 + seed * 2))
    shape.lineTo(x, Math.max(0.08, y))
  }
  shape.lineTo(width / 2, -2)
  shape.closePath()
  return new THREE.ShapeGeometry(shape)
}
function Banks() {
  const far = useMemo(() => bankGeometry(120, 2.6, 1.7), [])
  const near = useMemo(() => bankGeometry(80, 1.6, 4.2), [])
  return (
    <group>
      <mesh geometry={far} position={[6, 0, -26]}>
        <meshBasicMaterial color="#140a1e" />
      </mesh>
      <mesh geometry={near} position={[-3, 0, -14]}>
        <meshBasicMaterial color="#0c0614" />
      </mesh>
    </group>
  )
}

// ── crystal roses ────────────────────────────────────────────────────────────
function petalRing(count, radius, tilt, yOff, petalScale) {
  const geos = []
  for (let i = 0; i < count; i++) {
    const g = new THREE.IcosahedronGeometry(1, 0)
    g.scale(0.52 * petalScale, 0.85 * petalScale, 0.24 * petalScale)
    g.rotateX(tilt)
    g.translate(0, yOff, radius)
    g.rotateY((i / count) * Math.PI * 2 + radius * 7)
    geos.push(g)
  }
  return mergeGeometries(geos)
}

function useRoseAssets(quality) {
  return useMemo(() => {
    const outer = petalRing(7, 0.36, 0.82, 0.12, 1.0)
    const inner = petalRing(5, 0.17, 0.34, 0.28, 0.72)
    const core = new THREE.OctahedronGeometry(0.17, 0)

    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.09, 0.5, 0.02),
      new THREE.Vector3(-0.06, 1.0, -0.02),
      new THREE.Vector3(0, 1.42, 0),
    ])
    const stem = new THREE.TubeGeometry(stemCurve, 10, 0.028, 6)

    const glass = (color, emissive) => new THREE.MeshPhysicalMaterial({
      color, flatShading: true, metalness: 0, roughness: 0.06,
      ior: 1.5, envMapIntensity: 2.2,
      emissive, emissiveIntensity: 0.18,
      ...(quality === 'high'
        ? { transmission: 1, thickness: 0.5, iridescence: 0.9, iridescenceIOR: 1.3 }
        : { transparent: true, opacity: 0.62 }),
    })
    const pink = glass(new THREE.Color('#ffb6d0'), new THREE.Color('#ff5c93'))
    const amber = glass(new THREE.Color('#ffd9a0'), new THREE.Color('#ff9a3c'))
    const coreMat = new THREE.MeshPhysicalMaterial({
      color: '#fff6ea', roughness: 0.1, metalness: 0,
      emissive: '#ffd9b0', emissiveIntensity: 0.7,
    })
    const stemMat = new THREE.MeshPhysicalMaterial({
      color: '#1d3a2f', roughness: 0.25, metalness: 0.1,
      emissive: '#0f2a1e', emissiveIntensity: 0.35,
    })
    return { outer, inner, core, stem, pink, amber, coreMat, stemMat }
  }, [quality])
}

const ROSES = Array.from({ length: 16 }, (_, i) => {
  // two loose banks flanking the sun path, deterministic layout
  const side = i % 2 === 0 ? -1 : 1
  const t = Math.floor(i / 2) / 7
  return {
    x: side * (1.4 + t * 5.4) + Math.sin(i * 12.9) * 0.7,
    z: -2.8 - t * 7.5 + Math.cos(i * 7.3) * 0.9,
    y: 0.02 + Math.abs(Math.sin(i * 5.1)) * 0.22,
    s: 0.5 + Math.abs(Math.sin(i * 3.7)) * 0.35,
    delay: 1.0 + i * 0.21,
    amber: i % 3 === 2,
    sway: 0.5 + Math.abs(Math.sin(i * 9.4)) * 0.8,
  }
})

function Rose({ def, assets, getGrow }) {
  const root = useRef()
  const stemRef = useRef()
  const bloomRef = useRef()
  const outerRef = useRef()
  const innerRef = useRef()
  useFrame(({ clock }) => {
    const g = getGrow() - def.delay
    const stemK = easeOutCubic(clamp01(g / 0.9))
    const outerK = backOut(clamp01((g - 0.7) / 0.8))
    const innerK = backOut(clamp01((g - 1.0) / 0.7))
    if (stemRef.current) stemRef.current.scale.set(stemK > 0 ? 1 : 0, Math.max(0.001, stemK), 1)
    if (bloomRef.current) {
      bloomRef.current.position.y = 1.42 * stemK
      const idle = 1 + Math.sin(clock.elapsedTime * 1.3 + def.x * 3) * 0.02
      bloomRef.current.scale.setScalar(idle)
    }
    if (outerRef.current) outerRef.current.scale.setScalar(Math.max(0.001, outerK))
    if (innerRef.current) innerRef.current.scale.setScalar(Math.max(0.001, innerK))
    if (root.current) {
      root.current.rotation.z = Math.sin(clock.elapsedTime * 0.6 * def.sway + def.z) * 0.035
    }
  })
  const mat = def.amber ? assets.amber : assets.pink
  return (
    <group ref={root} position={[def.x, def.y, def.z]} scale={def.s}>
      <mesh ref={stemRef} geometry={assets.stem} material={assets.stemMat} scale={[0, 0.001, 1]} />
      <group ref={bloomRef} position={[0, 0, 0]}>
        <mesh ref={outerRef} geometry={assets.outer} material={mat} scale={0.001} />
        <mesh ref={innerRef} geometry={assets.inner} material={mat} scale={0.001} />
        <mesh geometry={assets.core} material={assets.coreMat} position={[0, 0.3, 0]} />
      </group>
    </group>
  )
}

function RoseField({ getGrow, quality }) {
  const assets = useRoseAssets(quality)
  useFrame(({ clock }) => {
    // shared breathing glow on the glass
    const k = 0.15 + 0.12 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.4))
    assets.pink.emissiveIntensity = k
    assets.amber.emissiveIntensity = k
  })
  return ROSES.map((def, i) => <Rose key={i} def={def} assets={assets} getGrow={getGrow} />)
}

// ── round particle sprite (stars + motes would otherwise render as squares) ──
let dotTex
function makeDotTexture() {
  if (dotTex) return dotTex
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const x = c.getContext('2d')
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(255,255,255,0.8)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, 32, 32)
  dotTex = new THREE.CanvasTexture(c)
  return dotTex
}

// ── dusk stars ───────────────────────────────────────────────────────────────
function Stars({ getGrow }) {
  const matA = useRef(); const matB = useRef()
  const [a, b] = useMemo(() => {
    const make = (n, seed) => {
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const az = (Math.sin(i * 91.7 + seed) * 0.5 + 0.5) * Math.PI * 2
        const el = 0.18 + (Math.sin(i * 37.3 + seed * 2) * 0.5 + 0.5) * 1.2
        const r = 640
        pos[i * 3] = r * Math.cos(el) * Math.sin(az)
        pos[i * 3 + 1] = r * Math.sin(el)
        pos[i * 3 + 2] = -r * Math.cos(el) * Math.cos(az)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      return g
    }
    return [make(130, 1), make(90, 5)]
  }, [])
  useFrame(({ clock }) => {
    const base = clamp01((getGrow() - 1.5) / 3)
    const t = clock.elapsedTime
    if (matA.current) matA.current.opacity = base * (0.55 + 0.35 * Math.sin(t * 1.7))
    if (matB.current) matB.current.opacity = base * (0.55 + 0.35 * Math.sin(t * 2.3 + 2))
  })
  return (
    <group>
      <points geometry={a}>
        <pointsMaterial ref={matA} color="#fff2e0" size={2.4} sizeAttenuation={false}
          map={makeDotTexture()} transparent opacity={0} depthWrite={false} />
      </points>
      <points geometry={b}>
        <pointsMaterial ref={matB} color="#ffe0f0" size={1.6} sizeAttenuation={false}
          map={makeDotTexture()} transparent opacity={0} depthWrite={false} />
      </points>
    </group>
  )
}

// ── golden motes ─────────────────────────────────────────────────────────────
function Motes({ getGrow }) {
  const ref = useRef()
  const mat = useRef()
  const N = 110
  const { geo, speeds } = useMemo(() => {
    const pos = new Float32Array(N * 3)
    const speeds = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16
      pos[i * 3 + 1] = Math.random() * 7
      pos[i * 3 + 2] = -2 - Math.random() * 13
      speeds[i] = 0.15 + Math.random() * 0.35
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return { geo: g, speeds }
  }, [])
  useFrame((_, dt) => {
    const p = geo.attributes.position.array
    const t = performance.now() / 1000
    for (let i = 0; i < N; i++) {
      p[i * 3 + 1] += speeds[i] * dt
      p[i * 3] += Math.sin(t * 0.5 + i) * 0.15 * dt
      if (p[i * 3 + 1] > 7.2) p[i * 3 + 1] = 0
    }
    geo.attributes.position.needsUpdate = true
    if (mat.current) mat.current.opacity = clamp01((getGrow() - 2) / 2.5) * 0.75
  })
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial ref={mat} color="#ffcf8a" size={3.2} sizeAttenuation={false}
        map={makeDotTexture()} transparent opacity={0} depthWrite={false}
        blending={THREE.AdditiveBlending} />
    </points>
  )
}

// ── birds crossing the sun ───────────────────────────────────────────────────
function Birds({ getGrow, reduced }) {
  const group = useRef()
  const wings = useRef([])
  const flock = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    dx: (i - 2) * 9 + Math.sin(i * 7) * 4,
    dy: Math.abs(i - 2) * 3.2 + Math.sin(i * 13) * 2,
    flap: 7 + i * 0.6,
  })), [])
  useFrame(({ clock }) => {
    if (!group.current) return
    if (reduced || getGrow() < 4) { group.current.visible = false; return }
    const t = clock.elapsedTime
    const cycle = (t % 16) / 16 // crossing every 16s
    if (cycle > 0.55) { group.current.visible = false; return }
    group.current.visible = true
    const x = THREE.MathUtils.lerp(-160, 160, cycle / 0.55)
    group.current.position.set(x, 34 + Math.sin(cycle * 9) * 3, -420)
    wings.current.forEach((w, i) => {
      if (w) w.rotation.z = Math.sin(t * flock[i % 5].flap) * 0.65
    })
  })
  return (
    <group ref={group} visible={false}>
      {flock.map((b, i) => (
        <group key={i} position={[b.dx, b.dy, 0]}>
          <mesh ref={(el) => { wings.current[i * 2] = el }} position={[-1.1, 0, 0]}>
            <planeGeometry args={[2.4, 0.5]} />
            <meshBasicMaterial color="#120818" side={THREE.DoubleSide} />
          </mesh>
          <mesh ref={(el) => { wings.current[i * 2 + 1] = el }} position={[1.1, 0, 0]} rotation={[0, 0, Math.PI]}>
            <planeGeometry args={[2.4, 0.5]} />
            <meshBasicMaterial color="#120818" side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

// ── shooting star ────────────────────────────────────────────────────────────
function ShootingStar({ getGrow, reduced }) {
  const ref = useRef()
  const state = useRef({ next: 7, active: false, t0: 0, x: 0, y: 0, dx: 0, dy: 0 })
  useFrame(({ clock }) => {
    if (!ref.current) return
    const s = state.current
    const t = clock.elapsedTime
    if (reduced || getGrow() < 3) { ref.current.visible = false; return }
    if (!s.active && t > s.next) {
      s.active = true; s.t0 = t
      s.x = (Math.random() - 0.5) * 500
      s.y = 180 + Math.random() * 160
      s.dx = (Math.random() > 0.5 ? 1 : -1) * (160 + Math.random() * 80)
      s.dy = -(70 + Math.random() * 40)
    }
    if (s.active) {
      const k = (t - s.t0) / 1.1
      if (k > 1) { s.active = false; s.next = t + 6 + Math.random() * 8; ref.current.visible = false; return }
      ref.current.visible = true
      ref.current.position.set(s.x + s.dx * k, s.y + s.dy * k, -560)
      ref.current.rotation.z = Math.atan2(s.dy, s.dx)
      ref.current.material.opacity = Math.sin(k * Math.PI) * 0.9
    }
  })
  return (
    <mesh ref={ref} visible={false}>
      <planeGeometry args={[26, 0.7]} />
      <meshBasicMaterial color={[1.6, 1.5, 1.3]} toneMapped={false} transparent opacity={0}
        blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  )
}

// ── drifting warm mist ───────────────────────────────────────────────────────
function makeMistTexture() {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 64
  const x = c.getContext('2d')
  const g = x.createRadialGradient(128, 32, 4, 128, 32, 120)
  g.addColorStop(0, 'rgba(255, 170, 110, 0.30)')
  g.addColorStop(0.6, 'rgba(230, 120, 90, 0.12)')
  g.addColorStop(1, 'rgba(220, 100, 80, 0)')
  x.fillStyle = g
  x.fillRect(0, 0, 256, 64)
  return new THREE.CanvasTexture(c)
}
function Mist({ getGrow }) {
  const refs = useRef([])
  const tex = useMemo(makeMistTexture, [])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    const vis = clamp01((getGrow() - 1) / 3)
    refs.current.forEach((m, i) => {
      if (!m) return
      m.position.x = Math.sin(t * 0.05 + i * 2.4) * 30 * (i + 1)
      m.material.opacity = vis * (0.30 - i * 0.07)
    })
  })
  return (
    <group>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(el) => { refs.current[i] = el }} position={[0, 1 + i * 1.2, -160 - i * 70]}>
          <planeGeometry args={[600, 10 + i * 5]} />
          <meshBasicMaterial map={tex} transparent opacity={0} depthWrite={false}
            blending={THREE.AdditiveBlending} />
        </mesh>
      ))}
    </group>
  )
}

// ── camera rig: ambient drift + pointer + gyro ───────────────────────────────
function CameraRig({ getGrow, gyroRef, reduced }) {
  const { camera } = useThree()
  const target = useRef(new THREE.Vector3())
  useFrame(({ clock, pointer }) => {
    const t = clock.elapsedTime
    const g = getGrow()
    // slow cinematic push-in during grow
    const dolly = THREE.MathUtils.lerp(11.5, 8.8, easeInOut(clamp01(g / 7)))
    let ax = 0, ay = 0
    if (!reduced) {
      // ambient drift — always on, so parallax reads with zero sensors
      ax = Math.sin(t * 0.16) * 0.6 + Math.sin(t * 0.07 + 1.3) * 0.3
      ay = Math.sin(t * 0.11 + 2) * 0.28
    }
    const gx = THREE.MathUtils.clamp((gyroRef.current.gamma || 0) / 38, -1, 1) * 1.3
    const gy = THREE.MathUtils.clamp(((gyroRef.current.beta || 0) - gyroRef.current.beta0) / 45, -1, 1) * 0.8
    const px = pointer.x * 1.1
    const py = pointer.y * 0.5

    target.current.set(ax + px + gx, 2.4 + ay + py - gy, dolly)
    camera.position.lerp(target.current, 0.045)
    // aim just above the horizon: sun in the upper half, roses fill the lower third
    camera.lookAt(-camera.position.x * 1.5, 1.2 - (camera.position.y - 2.4) * 0.6, -520)
  })
  return null
}

// ── environment map (sunset reflections for the glass) ───────────────────────
function SunsetEnv() {
  const { scene } = useThree()
  useEffect(() => {
    const c = document.createElement('canvas')
    c.width = 128; c.height = 64
    const x = c.getContext('2d')
    const grad = x.createLinearGradient(0, 0, 0, 64)
    grad.addColorStop(0, '#0e0721')
    grad.addColorStop(0.32, '#3b1650')
    grad.addColorStop(0.44, '#7a1e3c')
    grad.addColorStop(0.5, '#c2461f')
    grad.addColorStop(0.55, '#ffb347')
    grad.addColorStop(0.62, '#331020')
    grad.addColorStop(1, '#0a0510')
    x.fillStyle = grad
    x.fillRect(0, 0, 128, 64)
    // bright sun blob near the horizon
    const sg = x.createRadialGradient(64, 33, 1, 64, 33, 16)
    sg.addColorStop(0, 'rgba(255,245,220,1)')
    sg.addColorStop(0.4, 'rgba(255,190,110,0.8)')
    sg.addColorStop(1, 'rgba(255,140,60,0)')
    x.fillStyle = sg
    x.fillRect(0, 0, 128, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.mapping = THREE.EquirectangularReflectionMapping
    tex.colorSpace = THREE.SRGBColorSpace
    scene.environment = tex
    return () => { scene.environment = null; tex.dispose() }
  }, [scene])
  return null
}

// ── scene root ───────────────────────────────────────────────────────────────
export default function Scene({ growT0, gyroRef, reduced, quality }) {
  const getGrow = useGrowClock(growT0, reduced)
  const [dpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2))
  // debug: ?no=mist,birds,… strips components to isolate render issues
  const [off] = useState(() => {
    try {
      return new Set((new URLSearchParams(window.location.search).get('no') || '').split(','))
    } catch { return new Set() }
  })
  return (
    <Canvas
      dpr={quality === 'high' ? dpr : Math.min(dpr, 1.5)}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ fov: 58, near: 0.1, far: 1500, position: [0, 2.3, 11.5] }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <color attach="background" args={['#12081f']} />
      <SunsetEnv />
      <ambientLight intensity={0.25} color="#5a2a4a" />
      <directionalLight position={[0, 14, -80]} intensity={2.2} color="#ffb066" />
      {!off.has('sky') && <Sky getGrow={getGrow} />}
      {!off.has('sun') && <Sun getGrow={getGrow} />}
      {!off.has('water') && <Water getGrow={getGrow} />}
      {!off.has('stars') && <Stars getGrow={getGrow} />}
      {!off.has('meteor') && <ShootingStar getGrow={getGrow} reduced={reduced} />}
      {!off.has('birds') && <Birds getGrow={getGrow} reduced={reduced} />}
      {!off.has('mist') && <Mist getGrow={getGrow} />}
      {!off.has('banks') && <Banks />}
      {!off.has('roses') && <RoseField getGrow={getGrow} quality={quality} />}
      {!off.has('motes') && <Motes getGrow={getGrow} />}
      <CameraRig getGrow={getGrow} gyroRef={gyroRef} reduced={reduced} />
      {quality === 'high' && !off.has('post') && (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.62} luminanceSmoothing={0.25} />
          <Vignette eskil={false} offset={0.18} darkness={0.82} />
        </EffectComposer>
      )}
    </Canvas>
  )
}

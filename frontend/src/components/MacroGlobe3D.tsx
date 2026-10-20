"use client";

import { Component, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { FeedHealth, FeedSource } from "@/lib/types";
import { TIER_HEX } from "./ui";

const HEALTH_HEX: Record<FeedHealth, string> = {
  ok: "#059669",
  degraded: "#D97706",
  down: "#DC2626",
  unknown: "#94A3B8",
};

// Fixed latitudes/longitudes keep the three feeds spread across the sphere.
const NODE_DIRECTIONS: [number, number, number][] = [
  [0.82, 0.38, 0.43],
  [-0.55, 0.62, 0.56],
  [0.12, -0.6, 0.79],
];

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function FeedNode({ position, color, core }: { position: THREE.Vector3; color: string; core: THREE.Vector3 }) {
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints([core, position]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
    return new THREE.Line(geo, mat);
  }, [core, position, color]);
  return (
    <group>
      <primitive object={line} />
      <mesh position={position}>
        <sphereGeometry args={[0.1, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} roughness={0.35} />
      </mesh>
      <mesh position={position}>
        <sphereGeometry args={[0.18, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.14} />
      </mesh>
    </group>
  );
}

function Scene({ tier, health }: { tier: number; health: FeedHealth[] }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const still = useMemo(() => reducedMotion(), []);
  const tierColor = TIER_HEX[Math.min(Math.max(tier, 0), 2)];
  const core = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const nodes = useMemo(() => NODE_DIRECTIONS.map((d) => new THREE.Vector3(...d).normalize().multiplyScalar(1.6)), []);

  useFrame((state, delta) => {
    if (still) return;
    if (group.current) group.current.rotation.y += delta * 0.12;
    if (ring.current) {
      const t = (state.clock.elapsedTime % 3) / 3;
      ring.current.scale.setScalar(1 + t * 1.1);
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - t);
    }
  });

  return (
    <>
      <ambientLight intensity={1.15} />
      <directionalLight position={[3, 4, 5]} intensity={1.4} />
      <group ref={group} rotation={[0.35, 0, 0]}>
        <mesh>
          <sphereGeometry args={[1.58, 48, 48]} />
          <meshStandardMaterial color="#F8FAFC" roughness={0.9} transparent opacity={0.9} />
        </mesh>
        <mesh>
          <icosahedronGeometry args={[1.6, 3]} />
          <meshBasicMaterial wireframe color="#94A3B8" transparent opacity={0.5} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.34, 32, 32]} />
          <meshStandardMaterial color={tierColor} emissive={tierColor} emissiveIntensity={0.45} roughness={0.3} />
        </mesh>
        <mesh ref={ring} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.36, 0.4, 64]} />
          <meshBasicMaterial color={tierColor} transparent opacity={0.3} side={THREE.DoubleSide} />
        </mesh>
        {nodes.map((p, i) => (
          <FeedNode key={i} position={p} core={core} color={HEALTH_HEX[health[i] ?? "unknown"]} />
        ))}
      </group>
    </>
  );
}

class WebGLBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function MacroGlobe3D({ tier, feeds, health }: { tier: number; feeds?: FeedSource[]; health: FeedHealth[] }) {
  const tierName = ["NORMAL", "ELEVATED", "CRITICAL"][Math.min(Math.max(tier, 0), 2)];
  const labels = feeds?.map((f) => f.label) ?? ["SEC_REGULATORY_MIRROR", "CENTRAL_BANK_MACRO_MIRROR", "GLOBAL_ECONOMIC_WIRE_MIRROR"];
  return (
    <div className="glass overflow-hidden">
      <div className="relative h-[320px] w-full sm:h-[380px]" role="img" aria-label={`Feed network globe. Active tier ${tierName}. Feed health: ${labels.map((l, i) => `${l} ${health[i] ?? "unknown"}`).join(", ")}.`}>
        <WebGLBoundary
          fallback={<div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-mute">3D view unavailable (WebGL is disabled). All data is shown in the panels.</div>}
        >
          <Canvas camera={{ position: [0, 0, 5.2], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
            <Scene tier={tier} health={health} />
          </Canvas>
        </WebGLBoundary>
        <span className="eyebrow pointer-events-none absolute left-4 top-3">Feed network</span>
      </div>
      <ul className="grid gap-px border-t border-silver bg-silver sm:grid-cols-3">
        {labels.map((label, i) => (
          <li key={label} className="flex items-center gap-2 bg-white/80 px-4 py-2.5 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: HEALTH_HEX[health[i] ?? "unknown"] }} aria-hidden />
            <span className="truncate font-medium text-ink-soft">{label.replaceAll("_", " ")}</span>
            <span className="ml-auto text-ink-mute">{health[i] ?? "unknown"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

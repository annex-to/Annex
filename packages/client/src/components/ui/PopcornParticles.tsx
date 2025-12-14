import { useEffect, useRef, useState } from "react";

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  scale: number;
  opacity: number;
  birth: number;
}

interface PopcornParticlesProps {
  trigger: number;
  originX: number;
  originY: number;
  spread?: number; // Horizontal spread width
}

const PARTICLE_COUNT = 6;
const GRAVITY = 800; // pixels per second squared
const LIFETIME = 1500; // ms

// Fluffy popcorn SVG as a data URL - looks like popped corn
const popcornSvg = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <ellipse cx="16" cy="18" rx="10" ry="8" fill="#fef9c3"/>
  <ellipse cx="10" cy="12" rx="7" ry="6" fill="#fefce8"/>
  <ellipse cx="22" cy="13" rx="6" ry="5" fill="#fef9c3"/>
  <ellipse cx="16" cy="8" rx="6" ry="5" fill="#fffbeb"/>
  <ellipse cx="12" cy="20" rx="5" ry="4" fill="#fde68a"/>
  <ellipse cx="21" cy="19" rx="4" ry="4" fill="#fef3c7"/>
  <ellipse cx="8" cy="16" rx="4" ry="3" fill="#fefce8"/>
  <ellipse cx="24" cy="16" rx="3" ry="3" fill="#fef9c3"/>
</svg>
`)}`;

export function PopcornParticles({ trigger, originX, originY, spread = 60 }: PopcornParticlesProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const animationRef = useRef<number>();
  const lastTimeRef = useRef<number>(0);

  // Spawn new particles when trigger changes, one by one at random intervals
  useEffect(() => {
    if (trigger === 0) return;

    const timeouts: NodeJS.Timeout[] = [];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const delay = Math.random() * 400; // Random delay up to 400ms

      const timeout = setTimeout(() => {
        const now = performance.now();
        const newParticle: Particle = {
          id: now + Math.random(),
          x: originX + (Math.random() - 0.5) * spread, // Spread across button width
          y: originY,
          vx: (Math.random() - 0.5) * 100, // Slight horizontal drift
          vy: -150 - Math.random() * 100, // Gentle pop just above the button
          rotation: Math.random() * 360,
          rotationSpeed: (Math.random() - 0.5) * 720, // degrees per second
          scale: 0.6 + Math.random() * 0.4,
          opacity: 1,
          birth: now,
        };
        setParticles((prev) => [...prev, newParticle]);
      }, delay);

      timeouts.push(timeout);
    }

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [trigger, originX, originY, spread]);

  // Physics animation loop
  useEffect(() => {
    if (particles.length === 0) {
      lastTimeRef.current = 0;
      return;
    }

    const animate = (time: number) => {
      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
      }

      const deltaTime = (time - lastTimeRef.current) / 1000; // Convert to seconds
      lastTimeRef.current = time;

      setParticles((prev) => {
        const now = performance.now();
        return prev
          .map((p) => {
            const age = now - p.birth;
            const lifeProgress = age / LIFETIME;

            // Remove old particles
            if (lifeProgress >= 1) return null;

            // Apply gravity to velocity
            const newVy = p.vy + GRAVITY * deltaTime;

            // Update position
            const newX = p.x + p.vx * deltaTime;
            const newY = p.y + newVy * deltaTime;

            // Update rotation
            const newRotation = p.rotation + p.rotationSpeed * deltaTime;

            // Fade out in the last 40% of life
            const opacity = lifeProgress > 0.6 ? 1 - (lifeProgress - 0.6) / 0.4 : 1;

            return {
              ...p,
              x: newX,
              y: newY,
              vy: newVy,
              rotation: newRotation,
              opacity,
            };
          })
          .filter((p): p is Particle => p !== null);
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [particles.length > 0]);

  if (particles.length === 0) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[100] overflow-hidden">
      {particles.map((particle) => (
        <img
          key={particle.id}
          src={popcornSvg}
          alt=""
          className="absolute w-5 h-5"
          style={{
            left: particle.x - 10,
            top: particle.y - 10,
            transform: `rotate(${particle.rotation}deg) scale(${particle.scale})`,
            opacity: particle.opacity,
            willChange: "transform, opacity",
          }}
        />
      ))}
    </div>
  );
}

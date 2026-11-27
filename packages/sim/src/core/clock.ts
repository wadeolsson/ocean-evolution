/**
 * Fixed-timestep clock with tiered update rates.
 *
 * The three simulation layers run at wildly different frequencies: individual
 * creatures need 60Hz, regional populations are fine at 1Hz, and the global field
 * stack at 2Hz. Registering them here (rather than counting frames at each call
 * site) means `fastForward` can drive 50 simulated years through exactly the same
 * code path the live game uses -- which is the whole point of keeping the sim
 * free of the renderer.
 */

export type TierFn = (dtSim: number) => void;

interface Tier { readonly hz: number; readonly interval: number; acc: number; readonly fn: TierFn; readonly name: string; }

export class Clock {
  /** Sim seconds per base step. */
  readonly dt: number;
  /** Multiplier on real time. 1 = live, 10000 = headless balancing run. */
  timeScale = 1;
  /** Total simulated seconds elapsed. */
  simTime = 0;
  steps = 0;

  private acc = 0;
  private readonly tiers: Tier[] = [];
  private readonly maxStepsPerAdvance: number;

  constructor(dt = 1 / 60, maxStepsPerAdvance = 8) {
    this.dt = dt;
    this.maxStepsPerAdvance = maxStepsPerAdvance;
  }

  /** Register a system to run at `hz` simulated hertz. */
  onTier(name: string, hz: number, fn: TierFn): void {
    this.tiers.push({ name, hz, interval: 1 / hz, acc: 0, fn });
  }

  private step(): void {
    this.simTime += this.dt;
    this.steps++;
    for (const t of this.tiers) {
      t.acc += this.dt;
      if (t.acc >= t.interval) {
        const elapsed = t.acc;
        t.acc = 0;
        t.fn(elapsed);
      }
    }
  }

  /**
   * Advance by a frame of real time. Returns the number of sim steps taken.
   * Capped so a stalled tab cannot trigger a thousand-step catch-up spiral.
   */
  advance(realDt: number): number {
    this.acc += realDt * this.timeScale;
    let n = 0;
    while (this.acc >= this.dt && n < this.maxStepsPerAdvance) {
      this.acc -= this.dt;
      this.step();
      n++;
    }
    if (n === this.maxStepsPerAdvance) this.acc = 0; // drop the backlog
    return n;
  }

  /** Headless: run exactly `simSeconds` of simulation as fast as the CPU allows. */
  fastForward(simSeconds: number): void {
    const n = Math.round(simSeconds / this.dt);
    for (let i = 0; i < n; i++) this.step();
  }
}

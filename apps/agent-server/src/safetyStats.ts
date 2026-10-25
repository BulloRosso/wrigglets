import type { AgentSafetyStats } from '@cw/shared';

/** Counters (last hour) for the control plane's safety rules (kill-switch auto triggers, ADR-0022). */
export class SafetyStats {
  private tokens: Array<{ at: number; n: number }> = [];
  private failures: number[] = [];
  private violations: number[] = [];

  recordTokens(n: number) {
    this.tokens.push({ at: Date.now(), n });
    this.prune();
  }

  recordPermissionViolation() {
    this.violations.push(Date.now());
    this.prune();
  }

  recordStepFailure() {
    this.failures.push(Date.now());
    this.prune();
  }

  private prune() {
    const cutoff = Date.now() - 3_600_000;
    this.tokens = this.tokens.filter((t) => t.at >= cutoff);
    this.failures = this.failures.filter((t) => t >= cutoff);
    this.violations = this.violations.filter((t) => t >= cutoff);
  }

  snapshot(): AgentSafetyStats {
    this.prune();
    return {
      at: new Date().toISOString(),
      tokensLastHour: this.tokens.reduce((a, t) => a + t.n, 0),
      permissionViolations: this.violations.length,
      stepFailuresLastHour: this.failures.length,
    };
  }
}

export const safetyStats = new SafetyStats();

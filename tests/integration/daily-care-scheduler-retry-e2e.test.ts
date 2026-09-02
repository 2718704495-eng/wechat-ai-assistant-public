import { describe, expect, it } from "vitest";

import {
  runMorningRetrySimulation,
  runNightRetrySimulation,
} from "../fixtures/daily-care-scheduler-simulation.js";

describe("daily-care scheduler retry simulation", () => {
  it("falls back within the observed morning weather failure tick and submits exactly once", async () => {
    await expect(runMorningRetrySimulation()).resolves.toEqual({
      liveLockResidual: false,
      submitCalls: 1,
    });
  });

  it("accepts a 22:31 scheduler delay and two pre-draft closes before one submit", async () => {
    await expect(runNightRetrySimulation()).resolves.toEqual({
      liveLockResidual: false,
      submitCalls: 1,
    });
  });
});

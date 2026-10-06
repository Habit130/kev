import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { stableModelIdentity } from "../../src/lib/workbench/tasks";
import { relativeSessionPath, sessionCandidates } from "../../src/lib/workbench/storage";

const DATA_ROOT = process.env.KEV_WORKBENCH_DATA_ROOT;
if (!DATA_ROOT) throw new Error("Playwright must allocate an isolated workbench data root.");

test("projects the consumer identity pin into a path-free workbench identity", () => {
  const checkpoint = { source: "jaredpalmer/kev-0.8b", revision: "a".repeat(40) };
  const base = { source: "Qwen/Qwen3.5-0.8B-Base", revision: "b".repeat(40) };
  const identity = stableModelIdentity({
    model_id: "kev-0.8b",
    checkpoint: {
      path: "/synthetic/local/checkpoint",
      requested: "/synthetic/local/checkpoint",
      pin: checkpoint,
    },
    base: {
      path: "/synthetic/local/base",
      pin: base,
    },
    backend: "mlx",
    dtype: "bfloat16",
    device: "mps",
  });

  expect(identity).toEqual({
    modelId: "kev-0.8b",
    checkpoint,
    base,
    backend: "mlx",
    dtype: "bfloat16",
    device: "mps",
  });
  expect(JSON.stringify(identity)).not.toContain("/synthetic/local");

  expect(stableModelIdentity({
    modelId: "kev-0.8b",
    checkpoint,
    base,
    backend: "mlx",
    dtype: "bfloat16",
    device: "mps",
  })).toEqual(identity);
});

function createRuntimeSessionFixture(): { absolutePath: string; relativePath: string } {
  const id = randomUUID().replaceAll("-", "");
  const relativePath = `runtime/.local/kev/sessions/${id}/session.json`;
  const absolutePath = path.join(DATA_ROOT!, ...relativePath.split("/"));
  mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(absolutePath, "{}\n", { mode: 0o600 });
  return { absolutePath, relativePath };
}

test("accepts a consumer session nested under the lifecycle-config directory", () => {
  const session = createRuntimeSessionFixture();
  expect(relativeSessionPath(session.absolutePath)).toBe(session.relativePath);
});

test("discovers runtime-nested consumer sessions for restart recovery", () => {
  const session = createRuntimeSessionFixture();
  expect(sessionCandidates()).toContainEqual({
    relativePath: session.relativePath,
    modifiedAt: expect.any(Number),
  });
});

// Per-job model settings adopted from the Day-0 bench (docs/nemotron-bench.md).
// CLEARSHELF_THINK=off forces think off for every job. The host-RAM growth seen in the
// bench comes from the runner's prompt cache and happens in both think modes; think on
// roughly doubles each step, so this switch slows the growth but does not stop it. The
// RAM guard in ollama.ts is the protection.

export type JobName = "ingredient" | "notice" | "planner" | "brief" | "miner";

export interface JobSettings {
  think: boolean;
  num_predict: number;
}

export const ADOPTED_JOB_SETTINGS: Readonly<Record<JobName, Readonly<JobSettings>>> = {
  ingredient: { think: false, num_predict: 1536 },
  notice: { think: false, num_predict: 1536 },
  planner: { think: true, num_predict: 2048 },
  brief: { think: true, num_predict: 2048 },
  miner: { think: false, num_predict: 1536 },
};

export function jobSettings(job: JobName, env: Record<string, string | undefined> = process.env): JobSettings {
  const s = ADOPTED_JOB_SETTINGS[job];
  return env.CLEARSHELF_THINK === "off" ? { ...s, think: false } : { ...s };
}

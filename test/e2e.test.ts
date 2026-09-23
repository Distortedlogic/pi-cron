import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentsSourceRoot } from "pi-agents-yaml";
import { type CronJob, loadCronJobs, scheduleCronJobs } from "../src/index.ts";

function source(rootPath: string): AgentsSourceRoot {
	return {
		rootPath,
		sourcePath: join(rootPath, "AGENTS.yml"),
		hasAgentsFile: true,
		scope: "project",
		origin: "project",
	};
}

const JOB: CronJob = {
	id: "/project/AGENTS.yml:review",
	name: "review",
	schedule: "0 9 * * *",
	chain: ["Review the project.", "Apply the safe fixes."],
	cwd: "/project",
	sourcePath: "/project/AGENTS.yml",
};

test("loads named cron jobs from each AGENTS.yml directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-cron-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, "AGENTS.yml"),
		JSON.stringify({
			cron: {
				review: {
					schedule: "0 9 * * *",
					chain: ["Review the project.", "Apply the safe fixes."],
				},
			},
		}),
	);

	const jobs = await loadCronJobs([source(root)]);
	assert.deepEqual(jobs, [
		{
			...JOB,
			id: `${join(root, "AGENTS.yml")}:review`,
			cwd: root,
			sourcePath: join(root, "AGENTS.yml"),
		},
	]);
	assert.equal(Object.isFrozen(jobs), true);
	assert.equal(Object.isFrozen(jobs[0]?.chain), true);
});

test("rejects an invalid cron section", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-cron-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "AGENTS.yml"), JSON.stringify({ cron: { review: { schedule: "0 9 * * *", chain: [] } } }));
	await assert.rejects(loadCronJobs([source(root)]), /Invalid configuration.*cron/);
});

test("schedules each job, runs its chain, and stops cleanly", async () => {
	const callbacks: Array<() => Promise<void>> = [];
	const stopped: boolean[] = [];
	const runs: Array<{ job: CronJob; aborted: boolean }> = [];
	const dispose = scheduleCronJobs(
		[JOB],
		async (job, signal) => {
			runs.push({ job: job as CronJob, aborted: signal.aborted });
		},
		(schedule, run) => {
			assert.equal(schedule, JOB.schedule);
			callbacks.push(run);
			const index = stopped.push(false) - 1;
			return {
				stop: () => {
					stopped[index] = true;
				},
			};
		},
	);

	await callbacks[0]?.();
	assert.deepEqual(runs, [{ job: JOB, aborted: false }]);
	dispose();
	assert.deepEqual(stopped, [true]);
});

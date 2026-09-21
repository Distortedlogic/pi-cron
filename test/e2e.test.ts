import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentsSourceRoot } from "pi-agents-yaml";
import { type CronJob, loadCronJobs, scheduleCronJobs } from "../src/index.ts";

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const cliPath = join(dirname(codingAgentEntry), "cli.js");

const SYSTEM_ENVIRONMENT_KEYS = [
	"COMSPEC",
	"HOME",
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
] as const;

function systemEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of SYSTEM_ENVIRONMENT_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

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

test("packs and loads the production package in Pi without provider credentials", { timeout: 120_000 }, async (t) => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cron-e2e-"));
	t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const archiveDirectory = join(temporaryDirectory, "archive");
	const installDirectory = join(temporaryDirectory, "install");
	const agentDirectory = join(temporaryDirectory, "agent");
	await Promise.all([mkdir(archiveDirectory), mkdir(installDirectory), mkdir(agentDirectory)]);

	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const environment = systemEnvironment();
	const { stdout: packOutput } = await execFileAsync(npm, ["pack", "--json", "--pack-destination", archiveDirectory], {
		cwd: projectDirectory,
		encoding: "utf8",
		env: environment,
		timeout: 30_000,
	});
	const packed = (JSON.parse(packOutput) as Array<{ filename?: unknown; name?: unknown }>)[0];
	if (!packed || typeof packed.filename !== "string" || typeof packed.name !== "string") {
		assert.fail("npm pack returned no package name or archive filename");
	}
	const archivePath = join(archiveDirectory, packed.filename);

	await execFileAsync(
		npm,
		["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--omit=peer", archivePath],
		{ cwd: installDirectory, encoding: "utf8", env: environment, timeout: 60_000 },
	);

	const installedPackageDirectory = join(installDirectory, "node_modules", packed.name);
	const manifest = JSON.parse(await readFile(join(installedPackageDirectory, "package.json"), "utf8")) as {
		pi?: { extensions?: unknown };
	};
	assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);

	const { stderr } = await execFileAsync(
		process.execPath,
		[cliPath, "--no-session", "--no-extensions", "--extension", installedPackageDirectory, "--list-models"],
		{
			cwd: installDirectory,
			encoding: "utf8",
			env: { ...environment, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" },
			timeout: 30_000,
		},
	);

	assert.doesNotMatch(stderr, /Failed to load extension|No API key|Authentication failed/i);
});

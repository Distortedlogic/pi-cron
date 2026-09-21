import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, RpcClient } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { type AgentsSourceRoot, discoverAgentsSources, loadAgentsSection } from "pi-agents-yaml";
import { configurationSchema } from "../agents.ts";

const STATUS_KEY = "pi-cron";
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIRECTORY = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
const CODING_AGENT_ENTRY = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const CLI_PATH = join(dirname(CODING_AGENT_ENTRY), "cli.js");
const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;

export interface CronJob {
	id: string;
	name: string;
	schedule: string;
	chain: readonly string[];
	cwd: string;
	sourcePath: string;
}

export interface ScheduledTask {
	stop(): void;
}

export type PromptChainRunner = (job: Readonly<CronJob>, signal: AbortSignal) => Promise<void>;
export type ScheduledTaskFactory = (schedule: string, run: () => Promise<void>) => ScheduledTask;

export async function loadCronJobs(
	sources: readonly AgentsSourceRoot[],
	signal?: AbortSignal,
): Promise<readonly Readonly<CronJob>[]> {
	const jobs: CronJob[] = [];
	for (const source of sources) {
		signal?.throwIfAborted();
		if (!source.hasAgentsFile) continue;
		const section = await loadAgentsSection(source.sourcePath, "cron", configurationSchema, { signal });
		if (!section) continue;
		for (const [name, definition] of Object.entries(section.value)) {
			jobs.push({
				id: `${source.sourcePath}:${name}`,
				name,
				schedule: definition.schedule,
				chain: Object.freeze([...definition.chain]),
				cwd: source.rootPath,
				sourcePath: source.sourcePath,
			});
		}
	}
	return Object.freeze(jobs.map((job) => Object.freeze(job)));
}

export async function runPromptChain(job: Readonly<CronJob>, signal: AbortSignal, cliPath = CLI_PATH): Promise<void> {
	signal.throwIfAborted();
	const client = new RpcClient({ cliPath, cwd: job.cwd, args: ["--no-extensions"] });
	let abort: () => void = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => reject(signal.reason ?? new Error("Scheduled prompt chain was cancelled."));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		await Promise.race([client.start(), cancelled]);
		for (const prompt of job.chain) {
			signal.throwIfAborted();
			await Promise.race([client.promptAndWait(prompt, undefined, PROMPT_TIMEOUT_MS), cancelled]);
		}
	} finally {
		signal.removeEventListener("abort", abort);
		await client.stop();
	}
}

function defaultTaskFactory(schedule: string, run: () => Promise<void>): ScheduledTask {
	return new Cron(schedule, { protect: true }, run);
}

export function scheduleCronJobs(
	jobs: readonly Readonly<CronJob>[],
	runner: PromptChainRunner,
	factory: ScheduledTaskFactory = defaultTaskFactory,
): () => void {
	const controller = new AbortController();
	const tasks: ScheduledTask[] = [];
	try {
		for (const job of jobs) {
			tasks.push(
				factory(job.schedule, async () => {
					try {
						await runner(job, controller.signal);
					} catch (error) {
						if (!controller.signal.aborted) {
							console.error(`[pi-cron] ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}),
			);
		}
	} catch (error) {
		controller.abort();
		for (const task of tasks) task.stop();
		throw error;
	}
	return () => {
		controller.abort();
		for (const task of tasks) task.stop();
	};
}

export default function registerCron(pi: ExtensionAPI): void {
	let disposeSchedules: (() => void) | undefined;
	let generation = 0;

	pi.on("session_start", async (_event, ctx) => {
		const currentGeneration = ++generation;
		disposeSchedules?.();
		disposeSchedules = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const sources = discoverAgentsSources({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			packageRoot: PACKAGE_ROOT,
			agentDirectory: AGENT_DIRECTORY,
			signal: ctx.signal,
		});
		const jobs = await loadCronJobs(sources, ctx.signal);
		if (currentGeneration !== generation) return;
		disposeSchedules = scheduleCronJobs(jobs, runPromptChain);
		if (jobs.length > 0) ctx.ui.setStatus(STATUS_KEY, `Cron: ${jobs.length} scheduled`);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		disposeSchedules?.();
		disposeSchedules = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

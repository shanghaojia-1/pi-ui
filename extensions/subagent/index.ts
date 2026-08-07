/**
 * Observable subagent tool for Pi Studio.
 *
 * Each invocation runs a separate pi JSON-mode process. The extension turns
 * the child JSONL lifecycle into a bounded, structured details payload so GUI
 * hosts can render queued/running/tool/streaming/completed state without
 * parsing presentation text.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TASK_CHARS = 100 * 1024;
const OUTPUT_CAP = 50 * 1024;
const LIVE_TEXT_CAP = 12 * 1024;
const EVENT_TEXT_CAP = 8 * 1024;
const STDERR_CAP = 16 * 1024;
const MAX_EVENTS = 60;
const UPDATE_INTERVAL_MS = 80;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;
const CONTROL_SYMBOL = Symbol.for("pi-studio.subagent-control");

type SubagentControlRegistry = Map<string, () => void>;

function controlRegistry(): SubagentControlRegistry {
	const host = globalThis as typeof globalThis & { [CONTROL_SYMBOL]?: SubagentControlRegistry };
	host[CONTROL_SYMBOL] ??= new Map();
	return host[CONTROL_SYMBOL];
}

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	groq: ["GROQ_API_KEY"],
	xai: ["XAI_API_KEY"],
	moonshot: ["MOONSHOT_API_KEY"],
	zhipuai: ["ZHIPUAI_API_KEY"],
	ollama: [],
};

interface ProviderAuthResult {
	auth?: { apiKey?: string };
	env?: Record<string, string | undefined>;
}

interface ModelRegistryLike {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
	getProviderAuth?(provider: string): Promise<ProviderAuthResult | undefined>;
	getAvailable?(): Array<{ provider: string; id: string }> | Promise<Array<{ provider: string; id: string }>>;
}

async function resolveProvider(
	agent: AgentConfig,
	modelRegistry: ModelRegistryLike,
	parentProvider: string | undefined,
): Promise<string | undefined> {
	if (!agent.model) return parentProvider;
	try {
		const available = await modelRegistry.getAvailable?.();
		const match = available?.find((model) => model.id === agent.model || `${model.provider}/${model.id}` === agent.model);
		if (match) return match.provider;
	} catch {
		/* fall through to the explicit provider prefix */
	}
	const slash = agent.model.indexOf("/");
	return slash > 0 ? agent.model.slice(0, slash) : parentProvider;
}

/** Pass only the selected provider's resolved auth environment to the child. */
async function buildSpawnEnv(modelRegistry: ModelRegistryLike, provider: string | undefined): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Child agents are unattended JSON hosts; never let them inherit the GUI's
	// project-agent approval capability and recursively bypass the desktop gate.
	delete env.PI_STUDIO_HOST;
	for (const vars of Object.values(PROVIDER_ENV_KEYS)) {
		for (const name of vars) delete env[name];
	}
	if (!provider) return env;

	try {
		const resolved = await modelRegistry.getProviderAuth?.(provider);
		for (const [name, value] of Object.entries(resolved?.env ?? {})) {
			if (typeof value === "string" && value !== "") env[name] = value;
		}
		const apiKey = resolved?.auth?.apiKey ?? (await modelRegistry.getApiKeyForProvider(provider));
		const keyName = PROVIDER_ENV_KEYS[provider]?.[0];
		if (keyName && apiKey) env[keyName] = apiKey;
	} catch {
		/* auth.json/models.json remain available to the child as a fallback */
	}
	return env;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type TaskStatus = "queued" | "starting" | "thinking" | "running_tool" | "streaming" | "completed" | "failed" | "cancelled";
type EventKind = "lifecycle" | "thinking" | "message" | "tool" | "error";

interface SubagentEvent {
	id: string;
	kind: EventKind;
	status: "running" | "success" | "error";
	label: string;
	timestamp: number;
	toolName?: string;
	toolCallId?: string;
	args?: string;
	output?: string;
	text?: string;
}

interface SingleResult {
	id: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	status: TaskStatus;
	exitCode: number;
	messages: Message[];
	events: SubagentEvent[];
	liveText: string;
	output: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
}

interface SubagentDetails {
	version: 2;
	runId: string;
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	total: number;
	maxConcurrency: number;
	results: SingleResult[];
}

const clipText = (value: string, limit: number): string =>
	value.length > limit ? `…${value.slice(value.length - limit)}` : value;

function printable(value: unknown, limit = EVENT_TEXT_CAP): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	return clipText(text, limit);
}

function numericEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string; thinking?: string };
			if (block.type === "thinking") return block.thinking ?? block.text ?? "";
			return block.type === "text" ? block.text ?? "" : "";
		})
		.join("");
}

function getFinalOutput(result: SingleResult): string {
	if (result.output) return result.output;
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i];
		if (msg?.role !== "assistant") continue;
		const text = messageText(msg);
		if (text) return text;
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.status === "cancelled" || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) return result.errorMessage || result.stderr || getFinalOutput(result) || "(no output)";
	return getFinalOutput(result) || "(no output)";
}

function truncateOutput(output: string): string {
	const bytes = Buffer.byteLength(output, "utf8");
	if (bytes <= OUTPUT_CAP) return output;
	let truncated = output.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${bytes - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	onQueued: (item: TIn, index: number) => void,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	items.forEach(onQueued);
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current]!, current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function safeChildCwd(defaultCwd: string, requested: string | undefined): string {
	const workspace = fs.realpathSync(defaultCwd);
	const candidate = fs.realpathSync(path.resolve(defaultCwd, requested ?? "."));
	const rel = path.relative(workspace, candidate);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Subagent cwd must stay inside the workspace: ${candidate}`);
	if (!fs.statSync(candidate).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${candidate}`);
	return candidate;
}

interface PiInvocation {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}

function getPiInvocation(args: string[]): PiInvocation {
	const explicit = process.env.PI_SUBAGENT_CLI;
	if (explicit?.trim()) return { command: explicit.trim(), args };
	const engine = process.env.PI_SUBAGENT_ENGINE;
	if (engine?.trim()) {
		return {
			command: process.execPath,
			args: [path.join(engine.trim(), "dist", "cli.js"), ...args],
			env: { ELECTRON_RUN_AS_NODE: "1" },
		};
	}
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		const execName = path.basename(process.execPath).toLowerCase();
		if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function blankResult(id: string, agent: string, task: string, step?: number): SingleResult {
	return {
		id,
		agent,
		agentSource: "unknown",
		task,
		status: "queued",
		exitCode: -1,
		messages: [],
		events: [],
		liveText: "",
		output: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...(step !== undefined ? { step } : {}),
	};
}

function addEvent(result: SingleResult, event: Omit<SubagentEvent, "timestamp"> & { timestamp?: number }): void {
	const next: SubagentEvent = { ...event, timestamp: event.timestamp ?? Date.now() };
	const index = result.events.findIndex((item) => item.id === next.id);
	if (index >= 0) result.events[index] = next;
	else result.events.push(next);
	if (result.events.length > MAX_EVENTS) result.events.splice(0, result.events.length - MAX_EVENTS);
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	seed: SingleResult,
	prompt: string,
	requestedCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelRegistry: ModelRegistryLike,
	parentModel: { provider: string; id: string } | undefined,
	thinkingLevel: string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === seed.agent);
	if (!agent) {
		seed.status = "failed";
		seed.exitCode = 1;
		seed.errorMessage = `Unknown agent: "${seed.agent}". Available agents: ${agents.map((item) => `"${item.name}"`).join(", ") || "none"}.`;
		addEvent(seed, { id: `${seed.id}:error`, kind: "error", status: "error", label: "Agent not found", text: seed.errorMessage });
		onUpdate?.({ content: [{ type: "text", text: seed.errorMessage }], details: makeDetails([seed]) });
		return seed;
	}

	seed.agentSource = agent.source;
	const effectiveModel = agent.model ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
	if (effectiveModel) seed.model = effectiveModel;
	seed.status = "starting";
	seed.startedAt = Date.now();
	addEvent(seed, { id: `${seed.id}:lifecycle`, kind: "lifecycle", status: "running", label: "Starting subagent" });

	const args: string[] = [
		"--mode", "json", "-p", "--no-session",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
	];
	if (effectiveModel) args.push("--model", effectiveModel);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let lastEmit = 0;
	const emitNow = () => {
		if (!onUpdate) return;
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
		lastEmit = Date.now();
		onUpdate({
			content: [{ type: "text", text: seed.liveText || `${seed.agent}: ${seed.status}` }],
			details: makeDetails([seed]),
		});
	};
	const scheduleUpdate = () => {
		if (!onUpdate) return;
		const delay = Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - lastEmit));
		if (delay === 0) emitNow();
		else if (!updateTimer) {
			updateTimer = setTimeout(emitNow, delay);
			updateTimer.unref?.();
		}
	};

	let proc: ChildProcessWithoutNullStreams | null = null;
	let settled = false;
	let wasAborted = false;
	let timedOut: "total" | "idle" | null = null;
	let totalTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;

	const terminate = (reason: "abort" | "total" | "idle") => {
		if (reason === "abort") {
			wasAborted = true;
			seed.status = "cancelled";
			seed.errorMessage = "Subagent was cancelled";
			addEvent(seed, { id: `${seed.id}:lifecycle`, kind: "error", status: "error", label: "Subagent cancelled", text: seed.errorMessage });
		} else {
			timedOut = reason;
			seed.status = "failed";
			seed.errorMessage = reason === "idle" ? "Subagent stopped producing events" : "Subagent exceeded its time limit";
			addEvent(seed, { id: `${seed.id}:lifecycle`, kind: "error", status: "error", label: "Subagent timed out", text: seed.errorMessage });
		}
		emitNow();
		if (!proc || settled) return;
		proc.kill("SIGTERM");
		const force = setTimeout(() => {
			if (!settled) proc?.kill("SIGKILL");
		}, KILL_GRACE_MS);
		force.unref?.();
	};
	const refreshIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => terminate("idle"), numericEnv("PI_SUBAGENT_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS));
		idleTimer.unref?.();
	};
	const cancelTask = () => terminate("abort");
	controlRegistry().set(seed.id, cancelTask);

	emitNow();
	try {
		const childCwd = safeChildCwd(defaultCwd, requestedCwd);
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			args.push("--append-system-prompt", tmp.filePath);
		}
		const provider = await resolveProvider(agent, modelRegistry, parentModel?.provider);
		const spawnEnv = await buildSpawnEnv(modelRegistry, provider);
		if (wasAborted) throw new Error("Subagent was cancelled before launch");
		const invocation = getPiInvocation(args);
		const exitCode = await new Promise<number>((resolve) => {
			let buffer = "";
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};
			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: childCwd,
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...spawnEnv, ...(invocation.env ?? {}) },
				});
			} catch (error) {
				seed.errorMessage = error instanceof Error ? error.message : String(error);
				finish(1);
				return;
			}

			seed.status = "thinking";
			addEvent(seed, { id: `${seed.id}:lifecycle`, kind: "lifecycle", status: "running", label: "Subagent started" });
			emitNow();
			totalTimer = setTimeout(() => terminate("total"), numericEnv("PI_SUBAGENT_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS));
			totalTimer.unref?.();
			refreshIdleTimer();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				refreshIdleTimer();
				let event: Record<string, any>;
				try {
					event = JSON.parse(line) as Record<string, any>;
				} catch {
					addEvent(seed, { id: `${seed.id}:protocol`, kind: "error", status: "error", label: "Invalid child event", text: clipText(line, 1000) });
					scheduleUpdate();
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") {
					seed.status = "thinking";
					addEvent(seed, { id: `${seed.id}:message-live`, kind: "thinking", status: "running", label: "Thinking" });
					scheduleUpdate();
					return;
				}
				if (event.type === "message_update" && event.message?.role === "assistant") {
					const updateType = event.assistantMessageEvent?.type;
					const thinking = typeof updateType === "string" && updateType.startsWith("thinking");
					seed.status = thinking ? "thinking" : "streaming";
					seed.liveText = clipText(messageText(event.message), LIVE_TEXT_CAP);
					addEvent(seed, {
						id: `${seed.id}:message-live`,
						kind: thinking ? "thinking" : "message",
						status: "running",
						label: thinking ? "Thinking" : "Writing response",
						text: seed.liveText,
					});
					scheduleUpdate();
					return;
				}
				if (event.type === "tool_execution_start") {
					seed.status = "running_tool";
					addEvent(seed, {
						id: `${seed.id}:tool:${String(event.toolCallId)}`,
						kind: "tool",
						status: "running",
						label: `Running ${String(event.toolName)}`,
						toolName: String(event.toolName),
						toolCallId: String(event.toolCallId),
						args: printable(event.args),
					});
					emitNow();
					return;
				}
				if (event.type === "tool_execution_update") {
					seed.status = "running_tool";
					addEvent(seed, {
						id: `${seed.id}:tool:${String(event.toolCallId)}`,
						kind: "tool",
						status: "running",
						label: `Running ${String(event.toolName)}`,
						toolName: String(event.toolName),
						toolCallId: String(event.toolCallId),
						args: printable(event.args),
						output: clipText(messageText(event.partialResult) || printable(event.partialResult), EVENT_TEXT_CAP),
					});
					scheduleUpdate();
					return;
				}
				if (event.type === "tool_execution_end") {
					seed.status = "thinking";
					addEvent(seed, {
						id: `${seed.id}:tool:${String(event.toolCallId)}`,
						kind: "tool",
						status: event.isError ? "error" : "success",
						label: `${String(event.toolName)} ${event.isError ? "failed" : "completed"}`,
						toolName: String(event.toolName),
						toolCallId: String(event.toolCallId),
						output: clipText(messageText(event.result) || printable(event.result), EVENT_TEXT_CAP),
					});
					emitNow();
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					seed.messages.push(msg);
					if (msg.role === "assistant") {
						seed.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							seed.usage.input += usage.input || 0;
							seed.usage.output += usage.output || 0;
							seed.usage.cacheRead += usage.cacheRead || 0;
							seed.usage.cacheWrite += usage.cacheWrite || 0;
							seed.usage.cost += usage.cost?.total || 0;
							seed.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!seed.model && msg.model) seed.model = msg.model;
						if (msg.stopReason) seed.stopReason = msg.stopReason;
						if (msg.errorMessage) seed.errorMessage = msg.errorMessage;
						seed.liveText = clipText(messageText(msg), LIVE_TEXT_CAP);
					}
					scheduleUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				seed.stderr = clipText(seed.stderr + data.toString(), STDERR_CAP);
				scheduleUpdate();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? (wasAborted ? 130 : 1));
			});
			proc.on("error", (error) => {
				seed.errorMessage = error.message;
				addEvent(seed, { id: `${seed.id}:spawn-error`, kind: "error", status: "error", label: "Failed to start child process", text: error.message });
				finish(1);
			});

			abortHandler = () => terminate("abort");
			if (signal?.aborted) abortHandler();
			else signal?.addEventListener("abort", abortHandler, { once: true });
			proc.stdin.end(`Task: ${prompt}`);
		});

		seed.exitCode = exitCode;
		seed.finishedAt = Date.now();
		if (seed.startedAt) seed.durationMs = seed.finishedAt - seed.startedAt;
		seed.output = truncateOutput(getFinalOutput(seed));
		if (wasAborted) {
			seed.status = "cancelled";
			seed.stopReason = "aborted";
			seed.errorMessage = seed.errorMessage || "Subagent was cancelled";
		} else if (timedOut) {
			seed.status = "failed";
			seed.errorMessage = `Subagent ${timedOut === "idle" ? "stopped producing events" : "exceeded its time limit"}`;
		} else if (exitCode !== 0 || seed.stopReason === "error" || seed.stopReason === "aborted") {
			seed.status = "failed";
			seed.errorMessage = seed.errorMessage || seed.stderr || `Subagent exited with code ${exitCode}`;
		} else {
			seed.status = "completed";
		}
		addEvent(seed, {
			id: `${seed.id}:lifecycle`,
			kind: seed.status === "completed" ? "lifecycle" : "error",
			status: seed.status === "completed" ? "success" : "error",
			label: seed.status === "completed" ? "Subagent completed" : seed.status === "cancelled" ? "Subagent cancelled" : "Subagent failed",
			...(seed.errorMessage ? { text: seed.errorMessage } : {}),
		});
		// New structured events/output replace the heavyweight child transcript.
		seed.messages = [];
		emitNow();
		return seed;
	} catch (error) {
		seed.exitCode = 1;
		seed.status = wasAborted || signal?.aborted ? "cancelled" : "failed";
		if (seed.status === "cancelled") seed.stopReason = "aborted";
		seed.finishedAt = Date.now();
		if (seed.startedAt) seed.durationMs = seed.finishedAt - seed.startedAt;
		seed.errorMessage = error instanceof Error ? error.message : String(error);
		addEvent(seed, { id: `${seed.id}:error`, kind: "error", status: "error", label: "Subagent failed", text: seed.errorMessage });
		emitNow();
		return seed;
	} finally {
		settled = true;
		if (updateTimer) clearTimeout(updateTimer);
		if (totalTimer) clearTimeout(totalTimer);
		if (idleTimer) clearTimeout(idleTimer);
		if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		if (controlRegistry().get(seed.id) === cancelTask) controlRegistry().delete(seed.id);
		if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 64, description: "Name of the agent to invoke" }),
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the active workspace" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ minLength: 1, maxLength: 64, description: "Name of the agent to invoke" }),
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the active workspace" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user".',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { maxItems: MAX_PARALLEL_TASKS, description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(ChainItem, { maxItems: MAX_CHAIN_STEPS, description: "Sequential tasks" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Working directory inside the active workspace (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to observable isolated-context subagents.",
			"Use exactly one mode: single (agent + task), parallel (tasks), or chain (chain).",
			`User agents are loaded from ${path.join(getAgentDir(), "agents")}.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const runId = toolCallId || `subagent-${Date.now().toString(36)}`;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const total = hasChain ? params.chain!.length : hasTasks ? params.tasks!.length : hasSingle ? 1 : 0;
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				version: 2,
				runId,
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				total,
				maxConcurrency: MAX_CONCURRENCY,
				results,
			});

			if (modeCount !== 1) {
				return { content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode. Available agents: ${agents.map((a) => a.name).join(", ") || "none"}` }], details: makeDetails([]), isError: true };
			}
			if (hasTasks && params.tasks!.length > MAX_PARALLEL_TASKS) {
				return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: makeDetails([]), isError: true };
			}

			const requestedNames = new Set<string>();
			if (params.chain) for (const item of params.chain) requestedNames.add(item.agent);
			if (params.tasks) for (const item of params.tasks) requestedNames.add(item.agent);
			if (params.agent) requestedNames.add(params.agent);
			const projectAgents = [...requestedNames]
				.map((name) => agents.find((agent) => agent.name === name))
				.filter((agent): agent is AgentConfig => agent?.source === "project");
			if (projectAgents.length > 0 && process.env.PI_STUDIO_HOST !== "1") {
				if (ctx.mode === "tui") {
					const ok = await ctx.ui.confirm("Run project-local agents?", `Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "unknown"}`);
					if (!ok) return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: makeDetails([]), isError: true };
				} else if (!ctx.isProjectTrusted()) {
					return { content: [{ type: "text", text: "Project-local agents require host approval or a trusted project." }], details: makeDetails([]), isError: true };
				}
			}

			const run = (
				seed: SingleResult,
				cwd: string | undefined,
				update: OnUpdateCallback | undefined,
				prompt = seed.task,
			) => runSingleAgent(
				ctx.cwd,
				agents,
				seed,
				prompt,
				cwd,
				signal,
				update,
				makeDetails,
				ctx.modelRegistry,
				ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				ctx.thinkingLevel,
			);

			if (params.chain?.length) {
				const results = params.chain.map((item, index) => blankResult(`${runId}:${index}`, item.agent, item.task, index + 1));
				onUpdate?.({ content: [{ type: "text", text: "Chain queued" }], details: makeDetails(results) });
				let previousOutput = "";
				for (let index = 0; index < params.chain.length; index++) {
					const item = params.chain[index]!;
					const seed = results[index]!;
					const prompt = item.task.replace(/\{previous\}/g, previousOutput);
					const result = await run(seed, item.cwd, onUpdate ? (partial) => {
						const live = partial.details?.results[0];
						if (live) results[index] = live;
						onUpdate({ content: partial.content, details: makeDetails([...results]) });
					} : undefined, prompt);
					results[index] = result;
					if (isFailedResult(result)) return { content: [{ type: "text", text: `Chain stopped at step ${index + 1}: ${getResultOutput(result)}` }], details: makeDetails(results), isError: true };
					previousOutput = getFinalOutput(result);
				}
				return { content: [{ type: "text", text: getFinalOutput(results.at(-1)!) || "(no output)" }], details: makeDetails(results) };
			}

			if (params.tasks?.length) {
				const allResults = params.tasks.map((item, index) => blankResult(`${runId}:${index}`, item.agent, item.task));
				const emitAll = () => onUpdate?.({ content: [{ type: "text", text: "Subagents running" }], details: makeDetails([...allResults]) });
				emitAll();
				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					() => undefined,
					async (item, index) => {
						const result = await run(allResults[index]!, item.cwd, onUpdate ? (partial) => {
							const live = partial.details?.results[0];
							if (live) allResults[index] = live;
							emitAll();
						} : undefined);
						allResults[index] = result;
						emitAll();
						return result;
					},
				);
				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map((result) => `### [${result.agent}] ${isFailedResult(result) ? "failed" : "completed"}\n\n${truncateOutput(getResultOutput(result))}`);
				return { content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }], details: makeDetails(results), ...(successCount === 0 ? { isError: true } : {}) };
			}

			const seed = blankResult(`${runId}:0`, params.agent!, params.task!);
			const result = await run(seed, params.cwd, onUpdate);
			return { content: [{ type: "text", text: getResultOutput(result) }], details: makeDetails([result]), ...(isFailedResult(result) ? { isError: true } : {}) };
		},
	});
}

import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { SessionId as SessionId$1 } from "@deepseek-ai/dsh-session";
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, createUserMessage, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import * as fs from "node:fs";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
//#region src/bilingual.ts
/** Host-side messages reach the UI and the command line as text; they carry both languages. */
const bi = (zh, en) => `${zh} / ${en}`;
//#endregion
//#region src/digest.ts
function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const record = value;
		return Object.fromEntries(Object.keys(record).filter((key) => !key.startsWith("_")).sort().map((key) => [key, sortKeys(record[key])]));
	}
	return value;
}
function canonicalJson(value) {
	return JSON.stringify(sortKeys(value));
}
function digestOf(value) {
	return sha256Hex(canonicalJson(value));
}
//#endregion
//#region src/errors.ts
var FusionError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "FusionError";
	}
};
const FUSION_CONTEXT_BUDGET = "FUSION_CONTEXT_BUDGET";
const REVISION_CONFLICT = "REVISION_CONFLICT";
const REVISION_STALE = "REVISION_STALE";
const EVENT_CONFLICT = "EVENT_CONFLICT";
const FLUSH_FAILED = "FLUSH_FAILED";
const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";
const LEASE_BUSY = "LEASE_BUSY";
const LEASE_GENERATION = "LEASE_GENERATION";
const PROFILE_UNAVAILABLE = "PROFILE_UNAVAILABLE";
const SPEND_UNAUTHORIZED = "SPEND_UNAUTHORIZED";
const APPROVAL_SCOPE = "APPROVAL_SCOPE";
const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";
const NEEDS_REPAIR = "NEEDS_REPAIR";
const USAGE_MERGE_CONFLICT = "USAGE_MERGE_CONFLICT";
const USAGE_LEDGER_REQUIRED = "USAGE_LEDGER_REQUIRED";
const CONTROL_BLOCKED = "CONTROL_BLOCKED";
const REVIEW_RESULT_CONFLICT = "REVIEW_RESULT_CONFLICT";
const REVIEW_TICKET_REQUIRED = "REVIEW_TICKET_REQUIRED";
const WORK_ORDER_CONFLICT = "WORK_ORDER_CONFLICT";
const STORE_MIGRATION_REQUIRED = "STORE_MIGRATION_REQUIRED";
//#endregion
//#region src/usage/ledger.ts
const known = (tokens) => ({
	state: "known",
	tokens: safeTokens(tokens)
});
const unknown = () => ({ state: "unknown" });
const na = () => ({ state: "not_applicable" });
function requireThat$3(condition, code, message = code) {
	if (!condition) throw new FusionError(USAGE_MERGE_CONFLICT, message);
}
function safeTokens(n) {
	requireThat$3(Number.isSafeInteger(n) && n >= 0, "INVALID_TOKEN_COUNT");
	return n;
}
function same(a, b) {
	return digestOf(a) === digestOf(b);
}
function freezeDeep(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}
function newLedger(key) {
	requireThat$3(Object.values(key).every((value) => typeof value === "string" && value.length > 0), "INVALID_REQUEST_KEY");
	return freezeDeep({
		schemaVersion: 2,
		key: structuredClone(key),
		observations: []
	});
}
function validCount(value) {
	requireThat$3(value && [
		"known",
		"unknown",
		"not_applicable"
	].includes(value.state), "INVALID_COUNT");
	if (value.state === "known") safeTokens(value.tokens);
}
function validateBill(bill) {
	validCount(bill.uncachedInput);
	validCount(bill.cacheRead);
	validCount(bill.output);
	validCount(bill.reasoning.tokens);
	requireThat$3([
		"included",
		"separate",
		"unknown",
		"not_applicable"
	].includes(bill.reasoning.kind), "INVALID_REASONING_CONTRACT");
	if (bill.reasoning.kind === "included" && bill.reasoning.tokens.state === "known" && bill.output.state === "known") requireThat$3(bill.reasoning.tokens.tokens <= bill.output.tokens, "REASONING_EXCEEDS_OUTPUT");
	if (bill.reasoning.kind === "not_applicable") requireThat$3(bill.reasoning.tokens.state === "not_applicable", "REASONING_NOT_APPLICABLE_CONFLICT");
	const write = bill.cacheWrite;
	requireThat$3([
		"aggregate",
		"details",
		"unknown",
		"not_applicable"
	].includes(write.kind), "INVALID_CACHE_LAYOUT");
	if (write.kind === "aggregate") {
		validCount(write.tokens);
		requireThat$3(write.rateKey.length > 0, "RATE_KEY_REQUIRED");
	}
	if (write.kind === "details") {
		requireThat$3(Object.keys(write.buckets).length > 0, "EMPTY_CACHE_DETAIL");
		for (const bucket of Object.values(write.buckets)) {
			validCount(bucket.tokens);
			requireThat$3(bucket.rateKey.length > 0, "RATE_KEY_REQUIRED");
		}
	}
}
function addCount(first, second) {
	if (first.state === "unknown" || second.state === "unknown") return unknown();
	if (first.state === "not_applicable") return second;
	if (second.state === "not_applicable") return first;
	return known(first.tokens + second.tokens);
}
function addWrites(first, second) {
	if (first.kind === "unknown" || second.kind === "unknown") return { kind: "unknown" };
	if (first.kind === "not_applicable") return second;
	if (second.kind === "not_applicable") return first;
	requireThat$3(first.kind === second.kind, "CACHE_LAYOUT_MIX_REQUIRES_EXPLICIT_CONVERSION");
	if (first.kind === "aggregate" && second.kind === "aggregate") {
		requireThat$3(first.rateKey === second.rateKey, "CACHE_RATE_CONFLICT");
		return {
			kind: "aggregate",
			rateKey: first.rateKey,
			tokens: addCount(first.tokens, second.tokens)
		};
	}
	requireThat$3(first.kind === "details" && second.kind === "details", "CACHE_LAYOUT_CONFLICT");
	const keys = [...new Set([...Object.keys(first.buckets), ...Object.keys(second.buckets)])].sort();
	return {
		kind: "details",
		buckets: Object.fromEntries(keys.map((key) => {
			const left = first.buckets[key];
			const right = second.buckets[key];
			if (!left) return [key, right];
			if (!right) return [key, left];
			requireThat$3(left.rateKey === right.rateKey, "CACHE_RATE_CONFLICT");
			return [key, {
				rateKey: left.rateKey,
				tokens: addCount(left.tokens, right.tokens)
			}];
		}))
	};
}
function addBill(first, second) {
	requireThat$3(first.reasoning.kind === second.reasoning.kind, "DELTA_REASONING_CONTRACT_CONFLICT");
	return {
		uncachedInput: addCount(first.uncachedInput, second.uncachedInput),
		cacheRead: addCount(first.cacheRead, second.cacheRead),
		output: addCount(first.output, second.output),
		cacheWrite: addWrites(first.cacheWrite, second.cacheWrite),
		reasoning: {
			kind: first.reasoning.kind,
			tokens: addCount(first.reasoning.tokens, second.reasoning.tokens)
		}
	};
}
function projectLedger(ledger) {
	const finals = ledger.observations.filter((item) => item.mode === "final");
	if (finals.length) {
		for (const item of finals) requireThat$3(same(item.bill, finals[0].bill), "CONFLICTING_FINAL_BILLS");
		return {
			authority: "final",
			bill: finals[0].bill
		};
	}
	const base = ledger.observations.filter((item) => item.mode === "snapshot").sort((a, b) => a.sequence - b.sequence).at(-1);
	const deltas = ledger.observations.filter((item) => item.mode === "delta" && (!base || item.sequence > base.sequence)).sort((a, b) => a.sequence - b.sequence);
	let bill = base?.bill;
	for (const delta of deltas) bill = bill ? addBill(bill, delta.bill) : delta.bill;
	return {
		authority: bill ? "provisional" : "none",
		bill
	};
}
function ingestObservation(ledger, observation) {
	requireThat$3(ledger.schemaVersion === 2 && same(ledger.key, observation.key), "REQUEST_SCOPE_MISMATCH");
	requireThat$3(observation.id.length > 0 && Number.isSafeInteger(observation.sequence) && observation.sequence >= 0, "INVALID_OBSERVATION_ID_OR_SEQUENCE");
	requireThat$3([
		"snapshot",
		"delta",
		"final"
	].includes(observation.mode), "INVALID_OBSERVATION_MODE");
	validateBill(observation.bill);
	const existing = ledger.observations.find((item) => item.id === observation.id);
	if (existing) {
		requireThat$3(digestOf(existing) === digestOf(observation), "OBSERVATION_ID_CONFLICT");
		return ledger;
	}
	const sameSlot = ledger.observations.find((item) => item.sequence === observation.sequence);
	if (sameSlot) {
		requireThat$3(sameSlot.mode === observation.mode && same(sameSlot.bill, observation.bill), "OBSERVATION_SEQUENCE_CONFLICT");
		requireThat$3(observation.mode !== "delta", "DELTA_REQUIRES_STABLE_EVENT_ID");
	}
	const next = freezeDeep({
		...ledger,
		observations: [...ledger.observations, structuredClone(observation)]
	});
	projectLedger(next);
	return next;
}
function ingestDurable(ledger, observation) {
	return ingestObservation(structuredClone(ledger), structuredClone(observation));
}
function restoreLedger(raw) {
	requireThat$3(raw && typeof raw === "object", "INVALID_LEDGER");
	const value = raw;
	requireThat$3(value.schemaVersion === 2 && value.key && Array.isArray(value.observations), "UNSUPPORTED_LEDGER_FORMAT");
	for (const field of [
		"provider",
		"model",
		"requestId",
		"attemptId",
		"contractDigest"
	]) requireThat$3(typeof value.key[field] === "string" && value.key[field].length, "INVALID_REQUEST_KEY");
	let state = newLedger(structuredClone(value.key));
	for (const item of value.observations ?? []) state = ingestDurable(state, item);
	return state;
}
function splitInput(total, cached, includesCache) {
	if (includesCache === false) return total;
	if (includesCache === null) {
		if (cached.state === "not_applicable" || cached.state === "known" && cached.tokens === 0) return total;
		return unknown();
	}
	if (total.state !== "known" || cached.state !== "known") return unknown();
	requireThat$3(cached.tokens <= total.tokens, "CACHE_EXCEEDS_INPUT");
	return known(total.tokens - cached.tokens);
}
//#endregion
//#region src/host/history.ts
function taskSummary(state, createdAt, updatedAt) {
	return {
		id: state.taskId,
		sessionId: state.parent,
		seq: state.seq,
		createdAt,
		updatedAt,
		title: state.currentWorkOrder?.goal?.slice(0, 160) || "对话任务",
		phase: state.phase,
		verification: state.verification,
		mode: state.control.mode
	};
}
function usageSummary(row) {
	const projection = projectLedger(restoreLedger(row.ledger));
	return {
		id: row.nativeInvocationId,
		taskId: row.taskId,
		role: row.role,
		provider: row.ledger.key.provider,
		model: row.ledger.key.model,
		purpose: row.purpose ?? "conversation",
		startedAt: row.startedAt,
		outcome: row.outcome,
		authority: projection.authority,
		input: projection.bill?.uncachedInput ?? { state: "unknown" },
		output: projection.bill?.output ?? { state: "unknown" },
		cacheRead: projection.bill?.cacheRead ?? { state: "unknown" }
	};
}
/** Once at plugin startup; GET never writes, starts agents, or scans full task/usage snapshots. */
function backfillHistory(store) {
	for (const id of store.listTaskIds()) {
		if (store.readDocument(`task-index:${id}`)) continue;
		const state = store.load(id), events = store.events(id);
		store.writeDocument(`task-index:${id}`, 0, taskSummary(state, events[0].createdAt, events.at(-1).createdAt));
	}
	for (const id of store.listDocumentIds("usage:")) {
		const projectionId = `usage-index:${id.slice(6)}`;
		if (store.readDocument(projectionId)) continue;
		store.writeDocument(projectionId, 0, usageSummary(store.readDocument(id).value));
	}
}
const empty = () => ({
	calls: 0,
	final: 0,
	provisional: 0,
	unreported: 0,
	input: {
		known: 0,
		reported: 0
	},
	output: {
		known: 0,
		reported: 0
	},
	cacheRead: {
		known: 0,
		reported: 0
	}
});
function add(total, row) {
	total.calls++;
	total[row.authority === "none" ? "unreported" : row.authority]++;
	for (const key of [
		"input",
		"output",
		"cacheRead"
	]) {
		const count = row[key];
		if (count.state === "known") {
			total[key].known += count.tokens;
			total[key].reported++;
		}
	}
}
function readHistory(store, cursor = "", limit = 20) {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("History page size must be 1–50");
	const tasks = store.listDocumentIds("task-index:").map((id) => store.readDocument(id).value).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
	const all = store.listDocumentIds("usage-index:").map((id) => store.readDocument(id).value);
	const groups = /* @__PURE__ */ new Map(), byTask = /* @__PURE__ */ new Map(), totals = empty();
	for (const row of all) {
		add(totals, row);
		const own = byTask.get(row.taskId) ?? empty();
		add(own, row);
		byTask.set(row.taskId, own);
		const key = JSON.stringify([
			row.role,
			row.provider,
			row.model,
			row.purpose
		]);
		const group = groups.get(key) ?? {
			role: row.role,
			provider: row.provider,
			model: row.model,
			purpose: row.purpose,
			...empty()
		};
		add(group, row);
		groups.set(key, group);
	}
	const takeovers = {
		total: 0,
		tasks: 0,
		reasons: {}
	}, takeoversByTask = /* @__PURE__ */ new Map();
	for (const id of store.listDocumentIds("lead-takeover:")) {
		const row = store.readDocument(id).value;
		takeovers.total++;
		takeovers.reasons[row.reason] = (takeovers.reasons[row.reason] ?? 0) + 1;
		takeoversByTask.set(row.taskId, (takeoversByTask.get(row.taskId) ?? 0) + 1);
	}
	takeovers.tasks = takeoversByTask.size;
	const start = cursor ? tasks.findIndex((task) => task.id === cursor) + 1 : 0;
	if (cursor && start === 0) throw new Error("History cursor is no longer available");
	const page = tasks.slice(start, start + limit);
	return {
		observedAt: (/* @__PURE__ */ new Date()).toISOString(),
		totalTasks: tasks.length,
		tasks: page.map((task) => ({
			...task,
			usage: byTask.get(task.id) ?? empty(),
			takeovers: takeoversByTask.get(task.id) ?? 0
		})),
		nextCursor: start + limit < tasks.length ? page.at(-1).id : null,
		takeovers,
		totals,
		groups: [...groups.values()].sort((a, b) => b.calls - a.calls),
		actualBilledUsd: null,
		savingsPercent: null,
		upstreamHttpCalls: null
	};
}
//#endregion
//#region src/host/native-selection.ts
const FUSION_PROVIDER = "dsh-model-fusion";
const FUSION_MODEL = "auto";
const isFusionSelection = (route) => route?.provider === "dsh-model-fusion" && route.model === "auto";
/** Catalog-only local adapter; the native request is physically routed before dispatch. */
var FusionCatalogAdapter = class extends LlmAdapter {
	providerInfo(provider) {
		return {
			id: provider,
			name: "Fusion"
		};
	}
	async listModels(provider) {
		return [{
			provider,
			id: FUSION_MODEL,
			name: "Fusion · 自动",
			description: "Lead 与 Worker 协作。在设置 → Fusion 中配置模型。",
			inputModalities: ["text"]
		}];
	}
	async resolveModel(provider, model) {
		if (provider !== "dsh-model-fusion" || model !== "auto") throw new Error("Unknown local Fusion selection");
		return (await this.listModels(provider))[0];
	}
	async *stream(_options) {
		throw new Error("Fusion 尚未就绪。请前往设置 → Fusion 配置 Lead 和 Worker。");
	}
};
/** Public native lifecycle integration. No model-menu replacement or Host patch. */
function installNativeFusionSelection(ctx, input) {
	const pending = /* @__PURE__ */ new Map();
	const failures = /* @__PURE__ */ new Map();
	const desired = /* @__PURE__ */ new Map();
	const selection = (agent) => desired.get(agent.id) ?? input.selection(agent);
	const selected = (agent) => input.coordinator()?.bindings.read(agent.id)?.binding.selected === true;
	const change = (agent) => {
		if (agent.session.header.parentSession || pending.has(agent.id)) return;
		const coordinator = input.coordinator(), profile = input.profile(), route = selection(agent);
		if (!coordinator) return;
		if (isFusionSelection(route)) {
			if (!selected(agent) && profile) coordinator.selectBeforeAssembly(agent, profile);
			if (selected(agent)) {
				if (!isFusionSelection(agent.session.snapshotEvents().findLast((event) => event.type === "model/selection")?.data)) agent.session.append("model/selection", {
					provider: FUSION_PROVIDER,
					model: FUSION_MODEL
				});
				failures.delete(agent.id);
			}
			return;
		}
		if (!selected(agent)) return;
		const transition = (async () => {
			if (agent.status !== "idle") await coordinator.pause(agent);
			await coordinator.clear(agent);
			failures.delete(agent.id);
		})().catch((error) => {
			failures.set(agent.id, String(error));
		}).finally(() => {
			pending.delete(agent.id);
		});
		pending.set(agent.id, transition);
	};
	const disposers = [
		ctx.on("session/event", (session, event) => {
			if (event.type !== "model/selection") return;
			desired.set(session.id, event.data);
			const agent = ctx.agents.get(SessionId$1(session.id));
			if (agent && (agent.status === "idle" || !isFusionSelection(event.data))) change(agent);
			else if (agent && !selected(agent)) agent.cancel({
				kind: "hook",
				reason: "Fusion selection takes effect after this turn settles"
			}, { keepInbox: true });
		}),
		ctx.on("agent/status", ({ agent, status }) => {
			if (status !== "running" || agent.session.header.parentSession) return;
			if (pending.has(agent.id) && selected(agent)) {
				agent.cancel({
					kind: "hook",
					reason: "Model switch is draining the previous Fusion task"
				}, { keepInbox: true });
				return;
			}
			try {
				change(agent);
			} catch (error) {
				failures.set(agent.id, String(error));
			}
		}),
		ctx.on("agent/request", async (payload, next) => {
			const config = await next(), agent = payload.agent;
			if (agent.session.header.parentSession) return config;
			const route = selection(agent);
			if (pending.has(agent.id) && selected(agent) || failures.has(agent.id)) throw new Error(failures.get(agent.id) ?? "Fusion 正在完成模型切换，请稍后继续");
			if (isFusionSelection(route)) {
				if (!selected(agent)) throw new Error("请先在设置 → Fusion 配置 Lead 和 Worker，再继续此会话。");
			} else if (selected(agent)) throw new Error("先停止当前 Fusion 任务，再切换模型。");
			return config;
		}, { prepend: true })
	];
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
//#endregion
//#region src/profile/keepalive.ts
/** No provider-name heuristic can establish cache support for a DSH route. */
function keepaliveChoice(value) {
	if (value === void 0) return void 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cache keepalive selection");
	const raw = value;
	const valid = (item) => typeof item === "boolean" || item === "auto";
	if (Object.keys(raw).some((key) => key !== "lead" && key !== "worker") || !valid(raw.lead) || !valid(raw.worker)) throw new Error("Cache keepalive requires explicit Lead and Worker choices (true, false or \"auto\")");
	return {
		lead: raw.lead,
		worker: raw.worker
	};
}
//#endregion
//#region src/profile/compactor.ts
/** A separate summary model is never inferred from a provider name or enabled by default. */
function compactorChoice(value) {
	if (value === void 0) return void 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(bi("压缩模型配置无效", "Invalid compaction model setting"));
	const raw = value, route = raw.route;
	if (Object.keys(raw).some((key) => key !== "route" && key !== "maxOutputTokens") || !route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).some((key) => ![
		"provider",
		"model",
		"reasoningEffort"
	].includes(key)) || typeof route.provider !== "string" || !route.provider.trim() || typeof route.model !== "string" || !route.model.trim() || route.reasoningEffort !== void 0 && (typeof route.reasoningEffort !== "string" || !route.reasoningEffort.trim()) || !Number.isSafeInteger(raw.maxOutputTokens) || Number(raw.maxOutputTokens) < 1 || Number(raw.maxOutputTokens) > 128e3) throw new Error(bi("请选择压缩模型，并设置 1–128000 的输出 Token 上限", "Choose a compaction model and an output limit of 1–128000 tokens"));
	return {
		route: {
			provider: route.provider,
			model: route.model,
			...route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort }
		},
		maxOutputTokens: Number(raw.maxOutputTokens)
	};
}
/** All physical routes in a frozen configuration share the same explicit spending authorization. */
function profileRoutes(profile) {
	return [
		profile.lead,
		profile.worker,
		...profile.compactor ? [profile.compactor.route] : []
	];
}
//#endregion
//#region src/host/settings.ts
/** Configuration chooses registered physical models; it cannot create adapters. */
function validatePairChoice(value, catalog) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(bi("请选择 Lead 和 Worker", "Choose a Lead and a Sidekick"));
	const raw = value;
	const route = (role, candidate) => {
		const item = candidate;
		if (!item || typeof item.provider !== "string" || typeof item.model !== "string") throw new Error(bi(`请选择 ${role} 模型`, `Choose the ${role} model`));
		if (item.provider === "dsh-model-fusion") throw new Error(bi("Fusion 必须选择真实模型", "Fusion needs real models, not Fusion itself"));
		const model = catalog.groups.find((group) => group.id === item.provider)?.models.find((model) => model.id === item.model);
		if (!model) throw new Error(bi(`${role} 模型已不可用，请刷新后重选`, `The ${role} model is no longer available; refresh and choose again`));
		if (item.reasoningEffort !== void 0 && (typeof item.reasoningEffort !== "string" || !model.reasoning?.efforts.some((effort) => effort.id === item.reasoningEffort))) throw new Error(bi(`${role} 不支持所选推理强度`, `${role} does not support the selected reasoning level`));
		return {
			provider: item.provider,
			model: item.model,
			...item.reasoningEffort === void 0 ? {} : { reasoningEffort: item.reasoningEffort }
		};
	};
	const cacheKeepalive = keepaliveChoice(raw.cacheKeepalive);
	const compactor = compactorChoice(raw.compactor);
	let outputTokens;
	if (raw.outputTokens !== void 0) {
		const value = raw.outputTokens;
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([role, tokens]) => !["lead", "worker"].includes(role) || !Number.isSafeInteger(tokens) || Number(tokens) < 1 || Number(tokens) > 128e3)) throw new Error(bi("每次响应上限必须是 1–128000 的整数 Token 数", "The per-response limit must be an integer of 1–128000 tokens"));
		outputTokens = { ...value };
	}
	return {
		lead: route("lead", raw.lead),
		worker: route("worker", raw.worker),
		...outputTokens === void 0 ? {} : { outputTokens },
		...cacheKeepalive === void 0 ? {} : { cacheKeepalive },
		...compactor === void 0 ? {} : { compactor: {
			...compactor,
			route: route("压缩 · Compaction", compactor.route)
		} }
	};
}
function profileFromChoice(pair) {
	const { outputTokens, ...routes } = pair;
	return {
		schemaVersion: 1,
		id: "fusion-auto",
		version: outputTokens?.worker === 128e3 ? "0.1.0-worker-128k" : "0.1.0-faithful",
		enabled: true,
		quality: "experimental",
		...routes,
		workerUpgradePath: [],
		dataPolicyId: "native-host-workspace-policy",
		evidenceCampaignIds: [],
		...outputTokens === void 0 ? {} : { context: Object.fromEntries(Object.entries(outputTokens).map(([role, reserveOutputTokens]) => [role, { reserveOutputTokens }])) }
	};
}
/** Product defaults; explicit legacy/benchmark profiles retain their old contract. */
function modelProfileFromChoice(pair) {
	const { outputTokens: _output, ...native } = pair;
	return {
		...profileFromChoice(native),
		version: "0.2.0-enforced-v3",
		interactionMode: "model-like",
		workflowPolicy: "enforced-v3"
	};
}
/** Keep existing default settings stable; expose explicit larger/smaller limits on reload. */
function choiceFromProfile(profile) {
	const outputTokens = Object.fromEntries(["lead", "worker"].filter((role) => profile.context[role].reserveOutputTokens !== 8e3).map((role) => [role, profile.context[role].reserveOutputTokens]));
	return {
		lead: profile.lead,
		worker: profile.worker,
		...profile.interactionMode !== "model-like" && Object.keys(outputTokens).length ? { outputTokens } : {},
		...profile.compactor === void 0 ? {} : { compactor: profile.compactor },
		...profile.cacheKeepalive === void 0 ? {} : { cacheKeepalive: profile.cacheKeepalive }
	};
}
//#endregion
//#region src/host/cache-defaults.ts
/**
* Default prompt-cache behaviour for the models most people pair in Fusion, from each provider's official
* documentation. Matching uses the model id (stable across DSH setups), never the route name, except for the
* routes of this project's own OAuth plugins, whose billing we know. Everything here is a default: the user's
* per-model setting always wins, and the runtime can shorten an interval it observes to be too long.
*/
const CACHE_DEFAULTS_CHECKED = "2026-09-27";
const CACHE_FAMILIES = [
	{
		id: "openai",
		label: "OpenAI",
		match: /^(gpt-|o\d|codex|chatgpt)/i,
		discount: "1/10",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "空闲 5–10 分钟，最长 1 小时；部分新模型至少 30 分钟（订阅通道实测更短）",
			en: "5–10 min idle, up to 1 h; some newer models ≥ 30 min (shorter observed via subscriptions)"
		},
		docs: "https://developers.openai.com/api/docs/guides/prompt-caching"
	},
	{
		id: "anthropic",
		label: "Anthropic",
		match: /^claude/i,
		discount: "1/10",
		keepalive: "auto",
		intervalSeconds: 270,
		lifetime: {
			zh: "5 分钟，每次命中重新计时（可选 1 小时）",
			en: "5 min, refreshed on each hit (1 h option)"
		},
		docs: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
	},
	{
		id: "google",
		label: "Google",
		match: /^gemini/i,
		discount: "1/10",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "隐式缓存自动，时长未公布",
			en: "implicit, lifetime not published"
		},
		docs: "https://ai.google.dev/gemini-api/docs/caching"
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		match: /^deepseek/i,
		discount: "1/10–1/50",
		keepalive: "off",
		intervalSeconds: 285,
		lifetime: {
			zh: "硬盘缓存，通常保留几小时到几天（等待期间不会过期，无需保活）",
			en: "disk cache, hours to days (no keepalive needed)"
		},
		docs: "https://api-docs.deepseek.com/guides/kv_cache/"
	},
	{
		id: "xai",
		label: "xAI",
		match: /^grok/i,
		discount: "≈1/6",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "自动，时长未公布，内存紧张时可能被清除",
			en: "automatic, lifetime not published, evicted under memory pressure"
		},
		docs: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching"
	},
	{
		id: "zhipu",
		label: "Z.AI / 智谱",
		match: /^glm/i,
		discount: "≈1/5",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "自动，时长未公布",
			en: "automatic, lifetime not published"
		},
		docs: "https://docs.bigmodel.cn/cn/guide/capabilities/cache"
	},
	{
		id: "moonshot",
		label: "Moonshot / Kimi",
		match: /^kimi|^moonshot/i,
		discount: "1/10",
		keepalive: "auto",
		intervalSeconds: 270,
		lifetime: {
			zh: "默认 5 分钟，每次命中重新计时（可选 1 小时）",
			en: "5 min default, refreshed on each hit (1 h tier)"
		},
		docs: "https://platform.moonshot.ai/docs/pricing/chat-k3"
	},
	{
		id: "alibaba",
		label: "Alibaba / Qwen",
		match: /^qwen/i,
		discount: "1/5",
		keepalive: "auto",
		intervalSeconds: 270,
		lifetime: {
			zh: "隐式缓存由系统管理；显式缓存 5 分钟",
			en: "implicit cache system-managed; explicit cache 5 min"
		},
		docs: "https://help.aliyun.com/zh/model-studio/context-cache"
	},
	{
		id: "xiaomi",
		label: "Xiaomi MiMo",
		match: /^mimo/i,
		discount: "≈1/120",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "自动，时长未公布",
			en: "automatic, lifetime not published"
		},
		docs: "https://mimo.mi.com/docs/en-US/price/pay-as-you-go"
	},
	{
		id: "stepfun",
		label: "StepFun",
		match: /^step/i,
		discount: "1/5",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "自动，时长未公布",
			en: "automatic, lifetime not published"
		},
		docs: "https://platform.stepfun.com/docs/guide/prompt_cache"
	},
	{
		id: "meta",
		label: "Meta Muse",
		match: /^muse/i,
		discount: "≈1/8",
		keepalive: "auto",
		intervalSeconds: 285,
		lifetime: {
			zh: "自动；可申请 24 小时保留但不保证",
			en: "automatic; 24 h retention is a hint, not a guarantee"
		},
		docs: "https://dev.meta.ai/docs/pricing-rate-limits"
	},
	{
		id: "minimax",
		label: "MiniMax",
		match: /^minimax/i,
		discount: "1/5",
		keepalive: "auto",
		intervalSeconds: 270,
		lifetime: {
			zh: "5 分钟，每次命中重新计时",
			en: "5 min, refreshed on each hit"
		},
		docs: "https://platform.minimax.io/docs/api-reference/text-prompt-caching"
	}
];
const OWN_ROUTES = [
	{
		match: /^pi-zai-coding/,
		label: "GLM Coding Plan",
		keepalive: "off",
		reason: {
			zh: "按请求次数计额度，保活会占用次数",
			en: "quota counts requests; keepalive pings would use it"
		}
	},
	{
		match: /^pi-kimi-coding/,
		label: "Kimi Code",
		keepalive: "off",
		reason: {
			zh: "订阅按请求次数计额度",
			en: "subscription quota counts requests"
		}
	},
	{
		match: /^pi-github-copilot/,
		label: "GitHub Copilot",
		keepalive: "off",
		reason: {
			zh: "每次请求都算一次高级请求",
			en: "every request counts as a premium request"
		}
	},
	{
		match: /^agy-/,
		label: "Antigravity",
		keepalive: "off",
		reason: {
			zh: "按请求次数限额",
			en: "request-count limits"
		}
	},
	...[
		[/^pi-openai-codex/, "ChatGPT (Codex)"],
		[/^pi-anthropic/, "Claude"],
		[/^pi-xai/, "xAI"],
		[/^pi-openrouter/, "OpenRouter"]
	].map(([match, label]) => ({
		match,
		label,
		keepalive: "auto",
		reason: {
			zh: "按用量计，缓存命中能省额度",
			en: "usage-based; cache hits save quota"
		}
	}))
];
/** Defaults for one physical route; the model id selects the family, our own routes set the billing mode. */
function cacheDefaults(provider, model) {
	const family = CACHE_FAMILIES.find((item) => item.match.test(model));
	const route = OWN_ROUTES.find((item) => item.match.test(provider));
	if (route) return {
		keepalive: route.keepalive,
		intervalSeconds: family?.intervalSeconds ?? 285,
		source: "route",
		family,
		route
	};
	if (family) return {
		keepalive: family.keepalive,
		intervalSeconds: family.intervalSeconds,
		source: "family",
		family
	};
	return {
		keepalive: "auto",
		intervalSeconds: 285,
		source: "generic"
	};
}
const MIN_INTERVAL = 60, MAX_INTERVAL = 3540;
/** A request reused its prefix when most of its input came from the cache. */
const cacheHit = (cacheRead, input) => cacheRead > 0 && cacheRead / (cacheRead + input) >= .5;
const key = (provider, model) => `${provider}\u0001${model}`;
const clampInterval = (seconds) => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(seconds)));
var CachePolicy = class {
	store;
	constructor(store) {
		this.store = store;
	}
	setting(provider, model) {
		return this.store.readDocument(`cache-setting:${key(provider, model)}`)?.value;
	}
	/** Save or clear (null) the user's choice; invalid values are refused, not coerced. */
	save(provider, model, setting) {
		const id = `cache-setting:${key(provider, model)}`, prior = this.store.readDocument(id);
		if (setting === null) {
			if (prior) this.store.writeDocument(id, prior.revision, {});
			return;
		}
		if (setting.mode !== void 0 && ![
			"auto",
			"on",
			"off"
		].includes(setting.mode)) throw new Error("Keepalive mode must be auto, on or off");
		if (setting.intervalSeconds !== void 0 && (!Number.isFinite(setting.intervalSeconds) || setting.intervalSeconds < MIN_INTERVAL || setting.intervalSeconds > MAX_INTERVAL)) throw new Error(`Keepalive interval must be ${MIN_INTERVAL}–${MAX_INTERVAL} seconds`);
		this.store.writeDocument(id, prior?.revision ?? 0, {
			...setting.mode ? { mode: setting.mode } : {},
			...setting.intervalSeconds ? { intervalSeconds: Math.round(setting.intervalSeconds) } : {}
		});
	}
	stats(provider, model) {
		return this.store.readDocument(`cache-stats:${key(provider, model)}`)?.value;
	}
	/**
	* Record a request that followed a wait (or any keepalive ping). Pings that keep missing at the current
	* interval shorten it by a quarter: a too-long interval wastes every ping, a too-short one only costs extra
	* cheap reads, so the rule only ever moves toward safety. Lengthening is left to the user (see suggestion).
	*/
	observe(provider, model, sample, currentIntervalSeconds) {
		if (!sample.ping && sample.gapSeconds < 120) return;
		const id = `cache-stats:${key(provider, model)}`, prior = this.store.readDocument(id);
		const stats = prior?.value ?? {
			schemaVersion: 1,
			provider,
			model,
			samples: [],
			totals: {
				waits: 0,
				waitHits: 0,
				pings: 0,
				pingHits: 0,
				pingTokens: 0,
				keptWarmTokens: 0,
				resentTokens: 0
			},
			updatedAt: ""
		};
		const row = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			...sample
		};
		stats.samples = [...stats.samples, row].slice(-60);
		const totals = stats.totals;
		if (row.ping) {
			totals.pings++;
			totals.pingTokens += row.cacheRead + row.input;
			if (row.hit) totals.pingHits++;
			const recent = stats.samples.filter((item) => item.ping && Math.abs(item.gapSeconds - currentIntervalSeconds) <= currentIntervalSeconds * .25).slice(-5);
			if (recent.filter((item) => !item.hit).length >= 2 && recent.length >= 3) {
				stats.learnedIntervalSeconds = clampInterval(currentIntervalSeconds * .75);
				stats.samples = stats.samples.filter((item) => !item.ping);
			}
		} else {
			totals.waits++;
			if (row.hit) {
				totals.waitHits++;
				totals.keptWarmTokens += row.cacheRead;
			} else totals.resentTokens += row.input;
		}
		stats.updatedAt = row.at;
		this.store.writeDocument(id, prior?.revision ?? 0, stats);
	}
	/**
	* User setting > pair profile (older explicit choice) > learned interval > our own route's billing default >
	* model family default > generic. The Worker defaults to off: it rarely waits long enough to need pings.
	*/
	resolve(provider, model, role, pairChoice) {
		const defaults = cacheDefaults(provider, model);
		const user = this.setting(provider, model) ?? {};
		const learned = this.stats(provider, model)?.learnedIntervalSeconds;
		let mode, modeSource;
		if (user.mode) {
			mode = user.mode;
			modeSource = "user";
		} else if (typeof pairChoice === "boolean") {
			mode = pairChoice ? "on" : "off";
			modeSource = "pair";
		} else if (role === "worker") {
			mode = "off";
			modeSource = "role";
		} else {
			mode = defaults.keepalive;
			modeSource = defaults.source;
		}
		const intervalSeconds = user.intervalSeconds ?? learned ?? defaults.intervalSeconds;
		const intervalSource = user.intervalSeconds ? "user" : learned ? "learned" : defaults.source;
		return {
			mode,
			intervalSeconds,
			modeSource,
			intervalSource,
			defaults
		};
	}
	/** Suggest a longer interval only on repeated evidence: real waits that still hit well beyond the interval. */
	suggestion(provider, model, intervalSeconds) {
		const long = (this.stats(provider, model)?.samples ?? []).filter((item) => !item.ping && item.hit && item.gapSeconds >= intervalSeconds * 1.5);
		if (long.length < 3) return void 0;
		return clampInterval(Math.floor(Math.min(...long.map((item) => item.gapSeconds)) / 30) * 30);
	}
	/** Every route the plugin has evidence or a setting for, plus the given routes (the configured pair). */
	routes(extra = []) {
		const ids = [...this.store.listDocumentIds("cache-stats:"), ...this.store.listDocumentIds("cache-setting:")].map((id) => id.slice(id.indexOf(":") + 1).split(""));
		const all = [...extra.map((item) => [item.provider, item.model]), ...ids];
		const seen = /* @__PURE__ */ new Set();
		return all.filter(([provider, model]) => provider && model && !seen.has(key(provider, model)) && seen.add(key(provider, model))).map(([provider, model]) => ({
			provider,
			model
		}));
	}
};
/** One row of the settings page: what applies, why, what the defaults say, and what was observed. */
function cacheView(policy, pair, pairChoice) {
	const same = (a, provider, model) => a?.provider === provider && a.model === model;
	return policy.routes(pair ? [pair.lead, pair.worker] : []).map(({ provider, model }) => {
		const role = same(pair?.lead, provider, model) ? "lead" : same(pair?.worker, provider, model) ? "worker" : void 0;
		const effective = policy.resolve(provider, model, role ?? "lead", role ? pairChoice?.[role] : void 0);
		const stats = policy.stats(provider, model), { family, route } = effective.defaults;
		return {
			provider,
			model,
			role,
			mode: effective.mode,
			intervalSeconds: effective.intervalSeconds,
			modeSource: effective.modeSource,
			intervalSource: effective.intervalSource,
			setting: policy.setting(provider, model) ?? {},
			defaults: {
				mode: effective.defaults.keepalive,
				intervalSeconds: effective.defaults.intervalSeconds,
				source: effective.defaults.source,
				...family ? { family: {
					label: family.label,
					lifetime: family.lifetime,
					discount: family.discount,
					docs: family.docs
				} } : {},
				...route ? { route: {
					label: route.label,
					reason: route.reason
				} } : {}
			},
			totals: stats?.totals ?? null,
			learnedIntervalSeconds: stats?.learnedIntervalSeconds ?? null,
			suggestion: policy.suggestion(provider, model, effective.intervalSeconds) ?? null,
			recent: (stats?.samples ?? []).slice(-8).map((item) => ({
				gapSeconds: Math.round(item.gapSeconds),
				ping: item.ping,
				hit: item.hit
			}))
		};
	});
}
//#endregion
//#region src/profile/resolve.ts
const PLACEHOLDERS = new Set([
	"__AUTHORIZED_PROVIDER__",
	"__EXACT_MODEL_ID__",
	"__EXACT_WORKER_ID__",
	"__EXISTING_PROJECT_POLICY__"
]);
function isPlaceholder(route) {
	return PLACEHOLDERS.has(route.provider) || PLACEHOLDERS.has(route.model);
}
function asPolicy(raw, fallback) {
	const policy = {
		targetInputTokens: raw?.targetInputTokens ?? fallback.targetInputTokens,
		reserveOutputTokens: raw?.reserveOutputTokens ?? fallback.reserveOutputTokens,
		minSafetyTokens: raw?.minSafetyTokens ?? fallback.minSafetyTokens,
		safetyFraction: raw?.safetyFraction ?? fallback.safetyFraction,
		compactToFraction: raw?.compactToFraction ?? fallback.compactToFraction,
		evidenceReadTokens: raw?.evidenceReadTokens ?? fallback.evidenceReadTokens,
		maxToolVisibleTokens: raw?.maxToolVisibleTokens ?? fallback.maxToolVisibleTokens
	};
	for (const key of [
		"targetInputTokens",
		"reserveOutputTokens",
		"evidenceReadTokens",
		"maxToolVisibleTokens"
	]) if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new FusionError(PROFILE_UNAVAILABLE, `Invalid context policy: ${key}`);
	if (!Number.isSafeInteger(policy.minSafetyTokens) || policy.minSafetyTokens < 0 || !Number.isFinite(policy.safetyFraction) || policy.safetyFraction < 0 || policy.safetyFraction >= 1 || !Number.isFinite(policy.compactToFraction) || policy.compactToFraction <= 0 || policy.compactToFraction >= 1) throw new FusionError(PROFILE_UNAVAILABLE, "Invalid context safety or compaction policy");
	return policy;
}
const LEAD_DEFAULT = {
	targetInputTokens: Number.MAX_SAFE_INTEGER,
	reserveOutputTokens: 8e3,
	minSafetyTokens: 2048,
	safetyFraction: .05,
	compactToFraction: .5,
	evidenceReadTokens: 4e3,
	maxToolVisibleTokens: 6e3
};
const WORKER_DEFAULT = {
	...LEAD_DEFAULT,
	compactToFraction: .55,
	evidenceReadTokens: 8e3,
	maxToolVisibleTokens: 8e3
};
function promptDigests(prompts) {
	return {
		lead: sha256Hex(prompts.lead),
		worker: sha256Hex(prompts.worker),
		compact: sha256Hex(prompts.compact)
	};
}
function completeProfile(raw, prompts) {
	const lead = raw.lead;
	const worker = raw.worker;
	const context = raw.context ?? {};
	const promptHash = promptDigests(prompts);
	const cacheKeepalive = keepaliveChoice(raw.cacheKeepalive);
	const compactor = compactorChoice(raw.compactor);
	if (raw.interactionMode !== void 0 && raw.interactionMode !== "model-like") throw new Error("Unknown Fusion interaction mode");
	if (raw.workflowPolicy !== void 0 && (![
		"enforced-v1",
		"enforced-v2",
		"enforced-v3"
	].includes(String(raw.workflowPolicy)) || raw.interactionMode !== "model-like")) throw new Error("Unknown Fusion workflow policy");
	const profile = {
		schemaVersion: 1,
		id: String(raw.id),
		version: String(raw.version),
		digest: "",
		enabled: raw.enabled === true,
		quality: raw.quality ?? "experimental",
		...raw.interactionMode === "model-like" ? { interactionMode: "model-like" } : {},
		...raw.workflowPolicy === "enforced-v1" || raw.workflowPolicy === "enforced-v2" || raw.workflowPolicy === "enforced-v3" ? { workflowPolicy: raw.workflowPolicy } : {},
		lead,
		worker,
		workerUpgradePath: raw.workerUpgradePath ?? [],
		promptDigests: promptHash,
		context: {
			lead: asPolicy(context.lead, LEAD_DEFAULT),
			worker: asPolicy(context.worker, WORKER_DEFAULT)
		},
		dataPolicyId: String(raw.dataPolicyId ?? ""),
		evidenceCampaignIds: raw.evidenceCampaignIds ?? [],
		...cacheKeepalive === void 0 ? {} : { cacheKeepalive },
		...compactor === void 0 ? {} : { compactor }
	};
	return {
		...profile,
		digest: digestOf(profile)
	};
}
function resolveProfile(raw, prompts, catalog) {
	const profile = completeProfile(raw, prompts);
	if (!profile.enabled) throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} is disabled`);
	if (profileRoutes(profile).some(isPlaceholder) || PLACEHOLDERS.has(profile.dataPolicyId)) throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} still has placeholder routes`);
	const authorized = (route) => catalog.authorizedRoutes.some((item) => item.provider === route.provider && item.model === route.model);
	if (!profileRoutes(profile).every(authorized)) throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} routes are not authorized on this Host`);
	return {
		profile,
		prompts
	};
}
function loadJsonObject(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
//#endregion
//#region src/prompts.ts
const here = dirname(fileURLToPath(import.meta.url));
function defaultPromptDir() {
	return join(here, "..", "prompts");
}
function loadPromptBundle(dir = defaultPromptDir()) {
	return {
		lead: readFileSync(join(dir, "lead.md"), "utf8"),
		worker: readFileSync(join(dir, "worker.md"), "utf8"),
		compact: readFileSync(join(dir, "compact.md"), "utf8")
	};
}
function loadModelPromptBundle(dir = defaultPromptDir()) {
	return {
		lead: readFileSync(join(dir, "model-lead.md"), "utf8"),
		worker: readFileSync(join(dir, "model-worker.md"), "utf8"),
		compact: readFileSync(join(dir, "compact.md"), "utf8")
	};
}
function promptManifest(dir = defaultPromptDir()) {
	const prompts = loadPromptBundle(dir);
	return {
		prompts,
		digests: promptDigests(prompts)
	};
}
//#endregion
//#region src/contracts.ts
function asBrand(raw) {
	if (!raw || raw.includes("\0")) throw new TypeError("empty branded id");
	return raw;
}
const TaskId = (raw) => asBrand(raw);
const SessionId = (raw) => asBrand(raw);
const WorkOrderId = (raw) => asBrand(raw);
const OperationId = (raw) => asBrand(raw);
const ArtifactId = (raw) => asBrand(raw);
const SnapshotId = (raw) => asBrand(raw);
const EpochId = (raw) => asBrand(raw);
const UsdDecimal = (raw) => raw;
const TERMINAL_PHASES = new Set([
	"COMPLETED",
	"CANCELLED",
	"FAILED"
]);
//#endregion
//#region src/review/protocol.ts
const VALID_DECISIONS = new Set([
	"approve",
	"accept",
	"rework",
	"needs-decision"
]);
const SUCCESS_REASONS = new Set([
	"stop",
	"end_turn",
	"end-turn",
	"tool_calls",
	"tool_call",
	"completed",
	"success"
]);
const TRUNCATED_REASONS = new Set([
	"length",
	"max_tokens",
	"max_token"
]);
const ABORTED_REASONS = new Set([
	"aborted",
	"abort",
	"cancelled",
	"canceled",
	"cancel"
]);
const ERROR_REASONS = new Set([
	"error",
	"internal_error",
	"server_error"
]);
const FILTERED_REASONS = new Set([
	"content_filter",
	"content-filter",
	"filtered",
	"contentfilter"
]);
function normalizeFinishReason(finishReason) {
	if (finishReason === null || finishReason === void 0) return null;
	const trimmed = finishReason.trim().toLowerCase();
	return trimmed.length ? trimmed : null;
}
function terminationFromFinishReason(finishReason) {
	if (finishReason === null) return null;
	if (SUCCESS_REASONS.has(finishReason)) return "success";
	if (TRUNCATED_REASONS.has(finishReason)) return "truncated";
	if (ABORTED_REASONS.has(finishReason)) return "aborted";
	if (ERROR_REASONS.has(finishReason)) return "error";
	if (FILTERED_REASONS.has(finishReason)) return "filtered";
	return "unknown";
}
function normalizeTermination(input) {
	const fromFinish = terminationFromFinishReason(normalizeFinishReason(input.finishReason));
	if (input.termination && fromFinish && input.termination !== fromFinish) return "unknown";
	if (input.termination) return input.termination;
	if (fromFinish) return fromFinish;
	return input.completeEvidence === true ? "success" : "unknown";
}
function parsedDecision(parsed) {
	if (!parsed || typeof parsed !== "object") return void 0;
	const decision = parsed.decision;
	return typeof decision === "string" ? decision.trim().toLowerCase() : void 0;
}
function incomplete(reasons, termination, reviewStatus = "incomplete") {
	return {
		reviewStatus,
		decision: "REVIEW_INCOMPLETE",
		protocolComplete: false,
		fallbackUsed: false,
		fallbackRequired: true,
		termination,
		reasons
	};
}
/**
* Lead review is fail-closed. Only an explicit success termination plus a
* versioned accept/rework/needs-decision structure can complete the protocol.
* DIRECT skips review.
*/
function classifyReview(input) {
	if (input.executionPath === "direct") return {
		reviewStatus: "not_required",
		decision: "not_required",
		protocolComplete: true,
		fallbackUsed: false,
		fallbackRequired: false,
		termination: "success",
		reasons: ["direct path does not require Lead review"]
	};
	const reasons = [];
	const termination = normalizeTermination(input);
	if (termination === "truncated") reasons.push(`finish_reason=${normalizeFinishReason(input.finishReason) ?? "truncated"}`);
	if (termination === "aborted") reasons.push("termination=aborted");
	if (termination === "error") reasons.push("termination=error");
	if (termination === "filtered") reasons.push("termination=filtered");
	if (termination === "unknown") reasons.push("termination=unknown; parsed text is not success evidence");
	if (!(input.rawText ?? "").trim()) reasons.push("empty review output");
	const decision = parsedDecision(input.parsed);
	if (input.parsed !== void 0 && input.parsed !== null && !decision) reasons.push("illegal review structure");
	else if (decision && !VALID_DECISIONS.has(decision)) reasons.push(`illegal review decision ${decision}`);
	if (termination === "truncated" || termination === "unknown") return incomplete(reasons.length ? reasons : [`termination=${termination}`], termination);
	if (termination === "aborted" || termination === "error" || termination === "filtered") return incomplete(reasons, termination, "failed");
	if (reasons.length) return incomplete(reasons, termination);
	if (decision === "rework") return {
		reviewStatus: "complete",
		decision: "rework",
		protocolComplete: true,
		fallbackUsed: false,
		fallbackRequired: false,
		termination,
		reasons: []
	};
	if (decision === "needs-decision") return {
		reviewStatus: "complete",
		decision: "needs-decision",
		protocolComplete: true,
		fallbackUsed: false,
		fallbackRequired: false,
		termination,
		reasons: []
	};
	if (decision === "approve" || decision === "accept") return {
		reviewStatus: "complete",
		decision: "approve",
		protocolComplete: true,
		fallbackUsed: false,
		fallbackRequired: false,
		termination,
		reasons: []
	};
	return incomplete(["review decision missing"], termination);
}
/** Map classifier output onto the reducer event decision. */
function toReducerReviewDecision(classification) {
	if (classification.decision === "approve") return "accept";
	if (classification.decision === "rework") return "rework";
	if (classification.decision === "needs-decision") return "needs-decision";
	return "REVIEW_INCOMPLETE";
}
function reviewAttemptFields(input) {
	const deliveredArtifactSource = input.deliveredArtifactSource ?? null;
	return {
		artifactPass: input.artifactPass,
		executionPath: input.executionPath,
		leadReviewStatus: input.classification.reviewStatus,
		finishReason: input.finishReason ?? null,
		protocolComplete: input.classification.protocolComplete,
		fallbackUsed: Boolean(deliveredArtifactSource) && (input.classification.fallbackRequired || input.classification.fallbackUsed),
		deliveredArtifactSource
	};
}
//#endregion
//#region src/review/ticket.ts
function requireThat$2(value, code) {
	if (!value) throw new FusionError(EVENT_CONFLICT, code);
}
function freeze(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function reportSubject(taskId, report) {
	const reportDigest = digestOf(report);
	return {
		taskId,
		workOrderId: report.workOrderId,
		revision: report.revision,
		reportId: `report:${reportDigest}`,
		reportDigest,
		snapshot: report.snapshot
	};
}
function sameSubject(left, right) {
	return digestOf(left) === digestOf(right);
}
function reviewReadinessReceipt(subject) {
	const receipt = {
		subject,
		receiptId: `ready:${subject.reportDigest}`,
		verdict: "review-ready",
		receiptDigest: ""
	};
	return {
		...receipt,
		receiptDigest: digestOf({
			subject,
			receiptId: receipt.receiptId,
			verdict: receipt.verdict
		})
	};
}
function captureTicket(ticket) {
	requireThat$2(ticket.id && ticket.requestId && Number.isSafeInteger(ticket.generation), "INVALID_TICKET");
	requireThat$2(ticket.workOrderDigest, "WORK_ORDER_DIGEST_REQUIRED");
	return freeze(structuredClone(ticket));
}
function createReviewTicket(state, ids) {
	const receipt = state.validatedReceipt;
	const workOrder = state.currentWorkOrder;
	if (!receipt) throw new FusionError(EVENT_CONFLICT, "review ticket requires a validated report");
	if (!workOrder) throw new FusionError(EVENT_CONFLICT, "review ticket requires a current work order");
	return captureTicket({
		id: ids.ticketId,
		requestId: ids.requestId,
		generation: state.reviewGeneration + 1,
		subject: receipt.subject,
		validationDigest: digestOf(receipt),
		workOrderDigest: digestOf(workOrder)
	});
}
function reviewRequestedEvent(state, seq, ids, extras = {}) {
	return {
		schemaVersion: 1,
		id: extras.id ?? `review-requested-${ids.requestId}`,
		taskId: state.taskId,
		seq,
		revision: extras.revision ?? state.revision,
		type: "review/requested",
		createdAt: extras.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
		causeId: extras.causeId ?? ids.requestId,
		payload: { ticket: createReviewTicket(state, ids) }
	};
}
function reviewOutboxRow(ticket, payloadRef) {
	requireThat$2(payloadRef.length > 0, "REVIEW_PAYLOAD_REF_REQUIRED");
	return {
		operationId: OperationId(`review:${ticket.requestId}`),
		taskId: ticket.subject.taskId,
		kind: "review-request",
		state: "prepared",
		payloadRef,
		requestId: ticket.requestId,
		ticket: structuredClone(ticket)
	};
}
/** Callback constructor. No TaskState argument: the producer cannot rebind to the latest task. */
function resultFromCapturedTicket(ticket, outcome, envelope) {
	requireThat$2(outcome.requestId === ticket.requestId, "REVIEW_REQUEST_MISMATCH");
	requireThat$2(outcome.terminalEvidenceRef.length > 0, "TERMINAL_EVIDENCE_REQUIRED");
	requireThat$2(envelope.eventId && Number.isSafeInteger(envelope.seq) && envelope.seq > 0, "INVALID_EVENT_ENVELOPE");
	const classification = outcome.classification;
	requireThat$2(classification.decision !== "not_required", "DIRECT_IS_NOT_A_REVIEW_RESULT");
	const protocolValid = classification.reviewStatus === "complete" && classification.protocolComplete && classification.termination === "success";
	const decision = protocolValid ? toReducerReviewDecision(classification) : "REVIEW_INCOMPLETE";
	const binding = {
		ticketId: ticket.id,
		requestId: ticket.requestId,
		generation: ticket.generation,
		subject: structuredClone(ticket.subject),
		terminalEvidenceRef: outcome.terminalEvidenceRef,
		decision,
		protocolValid
	};
	return {
		schemaVersion: 1,
		id: envelope.eventId,
		taskId: ticket.subject.taskId,
		seq: envelope.seq,
		revision: ticket.subject.revision,
		type: "review/completed",
		createdAt: envelope.createdAt,
		causeId: ticket.requestId,
		payload: {
			decision,
			binding
		}
	};
}
/** Call at review dispatch AND immediately before committing verified completion. */
function assertCurrentSubject(state, ticket, actualSnapshot) {
	const workOrder = state.currentWorkOrder;
	requireThat$2(workOrder, "CURRENT_WORK_ORDER_REQUIRED");
	requireThat$2(workOrder.taskId === state.taskId && workOrder.id === ticket.subject.workOrderId, "WORK_ORDER_CHANGED");
	requireThat$2(state.revision === workOrder.revision && workOrder.revision === ticket.subject.revision, "REVISION_CHANGED");
	requireThat$2(digestOf(workOrder) === ticket.workOrderDigest, "WORK_ORDER_CHANGED");
	requireThat$2(state.candidateReport && state.validatedReport && state.validatedReceipt, "VALIDATED_CANDIDATE_REQUIRED");
	requireThat$2(digestOf(reportSubject(state.taskId, state.candidateReport)) === digestOf(ticket.subject), "CANDIDATE_CHANGED");
	requireThat$2(digestOf(reportSubject(state.taskId, state.validatedReport)) === digestOf(ticket.subject), "VALIDATED_REPORT_CHANGED");
	requireThat$2(digestOf(state.validatedReceipt.subject) === digestOf(ticket.subject), "READINESS_SUBJECT_CHANGED");
	requireThat$2(digestOf(state.validatedReceipt) === ticket.validationDigest, "READINESS_CHANGED");
	requireThat$2(actualSnapshot === ticket.subject.snapshot, "WORKSPACE_CHANGED");
}
//#endregion
//#region src/task/reducer.ts
const WAITING = new Set([
	"WAITING_APPROVAL",
	"WAITING_USER",
	"WAITING_BUDGET",
	"RECOVERING",
	"PAUSED",
	"STOPPING",
	"NEEDS_DECISION"
]);
function initialControl() {
	return {
		mode: "running",
		pendingApprovalIds: [],
		budgetBlocked: false,
		recovering: false,
		outcomeUnknown: false
	};
}
function waiting(state, phase) {
	return {
		...state,
		resumePhase: WAITING.has(state.phase) ? state.resumePhase : state.phase,
		phase
	};
}
function resume(state, fallback) {
	return {
		...state,
		phase: state.resumePhase ?? fallback,
		resumePhase: void 0
	};
}
function patchControl(state, patch) {
	return {
		...state.control,
		...patch
	};
}
/** Releasing one gate never releases another; late review results remain actionable. */
function projectReleasedControl(state) {
	const control = state.control;
	if (control.mode !== "running") return state;
	if (control.pendingApprovalIds.length) return {
		...state,
		phase: "WAITING_APPROVAL"
	};
	if (control.outcomeUnknown || state.outcomeUnknown) return {
		...state,
		phase: "NEEDS_DECISION"
	};
	if (control.recovering) return {
		...state,
		phase: "RECOVERING"
	};
	if (control.budgetBlocked) return {
		...state,
		phase: "WAITING_BUDGET"
	};
	if (state.reviewResult) {
		const decision = state.reviewResult.decision;
		return {
			...state,
			resumePhase: void 0,
			phase: decision === "rework" ? "REWORK" : decision === "accept" && state.reviewResult.protocolValid ? "REVIEWING" : "NEEDS_DECISION"
		};
	}
	return resume(state, state.intent === "DIRECT" ? "DIRECT" : "PLANNING");
}
function requireReconciliation(state, evidenceRef) {
	if (!evidenceRef.trim() || writerBusy(state)) throw new FusionError(CONTROL_BLOCKED, "reconciliation requires evidence and a quiescent writer");
}
function applyPayload(state, event) {
	switch (event.type) {
		case "task/created":
			if (state) throw new FusionError(EVENT_CONFLICT, "task already exists");
			if (event.seq !== 1) throw new FusionError(EVENT_CONFLICT, "task/created must be seq 1");
			return {
				schemaVersion: 1,
				taskId: event.taskId,
				revision: event.revision,
				seq: event.seq,
				phase: "READY",
				parent: event.payload.parent,
				selection: event.payload.selection,
				verification: "unverified",
				pendingApprovalIds: [],
				pendingApprovals: {},
				control: initialControl(),
				outcomeUnknown: false,
				reviewGeneration: 0,
				ignoredReviewResults: [],
				staleValidations: [],
				appliedEventIds: [event.id]
			};
		case "requirements/revised": return resetReviewForNewSubject({
			...need(state, event),
			revision: event.revision,
			phase: state.phase === "READY" ? "PLANNING" : state.phase
		});
		case "profile/frozen": return applyProfileFrozen(state, event);
		case "intent/chosen": return {
			...need(state, event),
			intent: event.payload.intent,
			phase: event.payload.intent === "DIRECT" ? "DIRECT" : "PLANNING"
		};
		case "work-order/prepared": return applyWorkOrderPrepared(state, event);
		case "work-order/acceptance-amended": {
			const next = need(state, event), order = next.currentWorkOrder;
			if (!order || order.mode === "explore" || order.id !== event.payload.workOrderId || next.lease) throw new FusionError(WORK_ORDER_CONFLICT, "Acceptance amendment requires the current quiescent implementation work order");
			return resetReviewForNewSubject({
				...next,
				currentWorkOrder: {
					...order,
					acceptance: event.payload.acceptance
				}
			});
		}
		case "work-order/scope-expanded": {
			const next = need(state, event), order = next.currentWorkOrder;
			if (!order || order.mode === "explore" || order.mode === "text" || order.id !== event.payload.workOrderId || next.lease || order.allowedPaths.some((path) => !event.payload.allowedPaths.includes(path))) throw new FusionError(WORK_ORDER_CONFLICT, "Scope expansion requires the current quiescent implementation work order and keeps every allowed path");
			return resetReviewForNewSubject({
				...next,
				currentWorkOrder: {
					...order,
					allowedPaths: event.payload.allowedPaths
				}
			});
		}
		case "child/accepted": return {
			...need(state, event),
			exploration: state?.currentWorkOrder?.mode === "explore" ? void 0 : state?.exploration,
			acceptedChild: event.payload.child,
			acceptedMessageId: event.payload.messageId,
			phase: "WORKER_RUNNING"
		};
		case "child/claimed": return {
			...need(state, event),
			phase: "WORKER_RUNNING"
		};
		case "exploration/recorded": {
			const next = need(state, event), report = event.payload.report, order = next.currentWorkOrder;
			assertControlAllowsExecution(next);
			if (order?.mode !== "explore" || order.id !== report.workOrderId || order.revision !== report.revision || next.revision !== report.revision || order.baseSnapshot !== report.snapshot || next.lease) throw new FusionError(EVENT_CONFLICT, "Exploration requires the current read-only work order and unchanged snapshot");
			return {
				...next,
				exploration: report,
				phase: "PLANNING",
				lastSnapshot: report.snapshot
			};
		}
		case "report/submitted": return applySubmittedReport(state, event);
		case "report/validated": return applyValidatedReport(state, event);
		case "review/requested": return applyReviewRequested(state, event);
		case "review/completed": return applyReviewCompleted(state, event);
		case "lease/acquired": return {
			...need(state, event),
			lease: event.payload.lease
		};
		case "lease/released": return {
			...need(state, event),
			lease: void 0
		};
		case "approval/pending": return applyApprovalPending(state, event);
		case "approval/answered": return applyApprovalAnswered(state, event);
		case "budget/blocked": return {
			...waiting(need(state, event), "WAITING_BUDGET"),
			control: patchControl(need(state, event), { budgetBlocked: true })
		};
		case "budget/unblocked": {
			const next = need(state, event);
			if (!event.payload.authorizationId.trim()) throw new FusionError(CONTROL_BLOCKED, "budget authorization is required");
			return projectReleasedControl({
				...next,
				control: patchControl(next, { budgetBlocked: false })
			});
		}
		case "checkpoint/committed": return {
			...need(state, event),
			lastSnapshot: event.payload.checkpoint.snapshot
		};
		case "recovery/needed": return {
			...waiting(need(state, event), "RECOVERING"),
			control: patchControl(need(state, event), { recovering: true })
		};
		case "recovery/reconciled": {
			const next = need(state, event);
			requireReconciliation(next, event.payload.evidenceRef);
			return projectReleasedControl({
				...next,
				lastSnapshot: event.payload.snapshot,
				control: patchControl(next, { recovering: false })
			});
		}
		case "effect/outcome-unknown": return {
			...waiting(need(state, event), "NEEDS_DECISION"),
			outcomeUnknown: true,
			control: patchControl(need(state, event), { outcomeUnknown: true })
		};
		case "effects/reconciled": {
			const next = need(state, event);
			requireReconciliation(next, event.payload.evidenceRef);
			if (event.payload.quiescent !== true) throw new FusionError(CONTROL_BLOCKED, "effects are not quiescent");
			return projectReleasedControl({
				...next,
				outcomeUnknown: false,
				lastSnapshot: event.payload.snapshot,
				control: patchControl(next, { outcomeUnknown: false })
			});
		}
		case "task/stop-requested": return {
			...waiting(need(state, event), "STOPPING"),
			control: patchControl(need(state, event), { mode: "stop-requested" })
		};
		case "task/paused": return {
			...waiting(need(state, event), "PAUSED"),
			control: patchControl(need(state, event), { mode: "paused" })
		};
		case "task/resumed": {
			const next = need(state, event);
			if (next.control.mode !== "paused" || writerBusy(next)) throw new FusionError(CONTROL_BLOCKED, "only a quiescent paused task can resume");
			return projectReleasedControl({
				...next,
				control: patchControl(next, { mode: "running" })
			});
		}
		case "task/completed": return complete(need(state, event), event);
		case "task/cancelled": return {
			...need(state, event),
			phase: "CANCELLED",
			control: patchControl(need(state, event), { mode: "cancelled" })
		};
		default: return assertNever(event);
	}
}
function need(state, event) {
	if (!state) throw new FusionError(EVENT_CONFLICT, `${event.type} requires an existing task`);
	if (state.taskId !== event.taskId) throw new FusionError(EVENT_CONFLICT, "taskId mismatch");
	if (event.seq !== state.seq + 1) throw new FusionError(EVENT_CONFLICT, `expected seq ${state.seq + 1}, got ${event.seq}`);
	if (event.revision < 1) throw new FusionError(EVENT_CONFLICT, "revision must be >= 1");
	if (TERMINAL_PHASES.has(state.phase) && event.type !== "task/cancelled") throw new FusionError(EVENT_CONFLICT, `terminal phase ${state.phase} rejects ${event.type}`);
	return {
		...state,
		seq: event.seq,
		revision: Math.max(state.revision, event.revision),
		appliedEventIds: [...state.appliedEventIds, event.id]
	};
}
function rejectStaleReport(state, reportRevision) {
	if (state && reportRevision < state.revision) throw new FusionError(REVISION_STALE, `report revision ${reportRevision} cannot advance task revision ${state.revision}`);
}
function reportDigest(report) {
	return digestOf(report);
}
function blockingGate(gate) {
	return gate !== void 0 && gate.terminalStatus !== "accepting";
}
function resetReviewForNewSubject(state) {
	return {
		...state,
		candidateReport: void 0,
		validatedReport: void 0,
		validatedReceipt: void 0,
		activeReviewTicket: void 0,
		reviewResult: void 0,
		reviewResultDigest: void 0,
		acceptedReview: void 0,
		lastReport: void 0,
		reviewGate: void 0,
		reviewGeneration: state.reviewGeneration + 1
	};
}
function applyProfileFrozen(state, event) {
	const next = need(state, event);
	const updated = {
		...next,
		profileDigest: event.payload.digest,
		phase: next.phase === "READY" ? "PLANNING" : next.phase
	};
	if (next.candidateReport || next.validatedReport || next.activeReviewTicket || next.acceptedReview) return resetReviewForNewSubject(updated);
	return updated;
}
function applyWorkOrderPrepared(state, event) {
	const next = need(state, event);
	const incoming = event.payload.order;
	const current = next.currentWorkOrder;
	if (current && current.taskId === incoming.taskId && current.id === incoming.id && current.revision === incoming.revision) {
		if (digestOf(current) !== digestOf(incoming)) throw new FusionError(WORK_ORDER_CONFLICT, "same work-order identity cannot change its frozen digest");
		return {
			...next,
			currentWorkOrder: incoming,
			reservedChild: event.payload.reservedChild,
			phase: "PLANNING"
		};
	}
	return {
		...current || next.candidateReport || next.validatedReport || next.activeReviewTicket || next.acceptedReview ? resetReviewForNewSubject(next) : next,
		currentWorkOrder: incoming,
		reservedChild: event.payload.reservedChild,
		phase: "PLANNING"
	};
}
function applySubmittedReport(state, event) {
	rejectStaleReport(state, event.payload.report.revision);
	const next = need(state, event);
	const incoming = event.payload.report;
	if (next.currentWorkOrder?.mode === "explore") throw new FusionError(EVENT_CONFLICT, "Exploration cannot submit an implementation report");
	if (next.candidateReport && reportDigest(next.candidateReport) === reportDigest(incoming)) return {
		...next,
		candidateReport: incoming,
		lastReport: next.validatedReport ?? incoming
	};
	return {
		...resetReviewForNewSubject(next),
		candidateReport: incoming,
		lastReport: incoming,
		phase: next.phase === "WORKER_RUNNING" || next.phase === "REVIEWING" || next.phase === "REWORK" ? "WORKER_RUNNING" : next.phase
	};
}
function applyValidatedReport(state, event) {
	rejectStaleReport(state, event.payload.report.revision);
	const next = need(state, event);
	const incoming = event.payload.report;
	const digest = reportDigest(incoming);
	const receipt = reviewReadinessReceipt(reportSubject(next.taskId, incoming));
	const sameValidated = next.validatedReport !== void 0 && reportDigest(next.validatedReport) === digest;
	const sameCandidate = next.candidateReport !== void 0 && reportDigest(next.candidateReport) === digest;
	const sameWork = next.currentWorkOrder && incoming.workOrderId === next.currentWorkOrder.id && incoming.revision === next.currentWorkOrder.revision;
	if (!sameCandidate || !sameWork) return {
		...next,
		staleValidations: [...next.staleValidations, {
			reportDigest: digest,
			reason: "stale-validation"
		}]
	};
	if (sameValidated && blockingGate(next.reviewGate)) return {
		...next,
		lastReport: incoming,
		validatedReport: incoming,
		validatedReceipt: receipt
	};
	return {
		...next,
		lastReport: incoming,
		validatedReport: incoming,
		validatedReceipt: receipt,
		phase: businessPhaseForReview(next)
	};
}
function businessPhaseForReview(state) {
	if (state.control.mode !== "running") return state.phase;
	if (state.control.pendingApprovalIds.length) return "WAITING_APPROVAL";
	if (state.control.budgetBlocked) return "WAITING_BUDGET";
	if (state.control.recovering) return "RECOVERING";
	if (state.control.outcomeUnknown) return "NEEDS_DECISION";
	return "REVIEWING";
}
function applyReviewRequested(state, event) {
	const next = need(state, event);
	assertControlAllowsExecution(next);
	const receipt = next.validatedReceipt;
	if (!receipt || !next.validatedReport) throw new FusionError(EVENT_CONFLICT, "review/requested requires a validated report");
	const ticket = event.payload.ticket;
	assertCurrentSubject(next, ticket, next.lastSnapshot ?? ticket.subject.snapshot);
	if (!sameSubject(ticket.subject, receipt.subject)) throw new FusionError(EVENT_CONFLICT, "review ticket subject does not match the validated report");
	if (ticket.validationDigest !== digestOf(receipt)) throw new FusionError(EVENT_CONFLICT, "review ticket validation digest does not match readiness receipt");
	if (ticket.generation !== next.reviewGeneration + 1 && next.activeReviewTicket && digestOf(next.activeReviewTicket) === digestOf(ticket)) return next;
	if (ticket.generation !== next.reviewGeneration + 1) throw new FusionError(EVENT_CONFLICT, `review ticket generation ${ticket.generation} is not the next generation ${next.reviewGeneration + 1}`);
	return {
		...next,
		activeReviewTicket: ticket,
		reviewGeneration: ticket.generation,
		reviewResult: void 0,
		reviewResultDigest: void 0,
		acceptedReview: void 0,
		reviewGate: void 0,
		phase: "REVIEWING"
	};
}
function applyReviewCompleted(state, event) {
	const next = need(state, event);
	const binding = event.payload.binding;
	if (!binding) return applyLegacyReviewDecision(next, event);
	return applyBoundReviewResult(next, binding, event);
}
function applyLegacyReviewDecision(state, event) {
	const decision = event.payload.decision;
	if (decision === "accept") return {
		...state,
		reviewGate: state.lastReport ? {
			taskId: state.taskId,
			workOrderId: state.currentWorkOrder?.id ?? state.lastReport.workOrderId,
			revision: state.lastReport.revision,
			reportDigest: reportDigest(state.lastReport),
			snapshot: state.lastReport.snapshot,
			reviewAttemptId: event.id,
			decision,
			terminalStatus: "legacy-unbound"
		} : state.reviewGate
	};
	if (!state.lastReport) throw new FusionError(EVENT_CONFLICT, "review/completed requires a validated report");
	const gate = {
		taskId: state.taskId,
		workOrderId: state.currentWorkOrder?.id ?? state.lastReport.workOrderId,
		revision: state.lastReport.revision,
		reportDigest: reportDigest(state.lastReport),
		snapshot: state.lastReport.snapshot,
		reviewAttemptId: event.id,
		decision,
		terminalStatus: decision === "rework" ? "rework" : decision === "REVIEW_INCOMPLETE" ? "incomplete" : "needs-decision"
	};
	if (decision === "rework") return {
		...state,
		reviewGate: gate,
		phase: "REWORK"
	};
	return {
		...state,
		reviewGate: gate,
		phase: "NEEDS_DECISION"
	};
}
function applyBoundReviewResult(state, result, event) {
	const ticket = state.activeReviewTicket;
	if (!ticket || ticket.id !== result.ticketId || ticket.requestId !== result.requestId || ticket.generation !== result.generation || !sameSubject(ticket.subject, result.subject)) return {
		...state,
		ignoredReviewResults: [...state.ignoredReviewResults, result]
	};
	const resultDigest = digestOf(result);
	if (state.reviewResultDigest) {
		if (state.reviewResultDigest !== resultDigest) throw new FusionError(REVIEW_RESULT_CONFLICT, "conflicting review result for the same ticket");
		return state;
	}
	const accepts = result.protocolValid && result.decision === "accept";
	const gate = {
		taskId: state.taskId,
		workOrderId: ticket.subject.workOrderId,
		revision: ticket.subject.revision,
		reportDigest: ticket.subject.reportDigest,
		snapshot: ticket.subject.snapshot,
		reviewAttemptId: event.id,
		decision: result.decision,
		terminalStatus: accepts ? "accepting" : result.decision === "rework" ? "rework" : result.decision === "REVIEW_INCOMPLETE" ? "incomplete" : "needs-decision"
	};
	const recorded = {
		...state,
		reviewResult: result,
		reviewResultDigest: resultDigest,
		acceptedReview: accepts ? {
			ticket,
			resultDigest
		} : void 0,
		reviewGate: gate
	};
	if (state.control.mode !== "running" || state.control.pendingApprovalIds.length || state.control.budgetBlocked || state.control.recovering || state.control.outcomeUnknown) return recorded;
	if (result.decision === "rework") return {
		...recorded,
		phase: "REWORK"
	};
	if (result.decision === "needs-decision" || result.decision === "REVIEW_INCOMPLETE") return {
		...recorded,
		phase: "NEEDS_DECISION"
	};
	return {
		...recorded,
		phase: "REVIEWING"
	};
}
function applyApprovalPending(state, event) {
	const next = need(state, event);
	const approval = event.payload.approval;
	const pendingApprovalIds = [...new Set([...next.pendingApprovalIds, approval.id])];
	return {
		...waiting(next, "WAITING_APPROVAL"),
		pendingApprovalIds,
		pendingApprovals: {
			...next.pendingApprovals,
			[approval.id]: approval
		},
		control: patchControl(next, { pendingApprovalIds })
	};
}
function applyApprovalAnswered(state, event) {
	const next = need(state, event);
	if (!next.pendingApprovals[event.payload.approvalId] || !next.pendingApprovalIds.includes(event.payload.approvalId)) throw new FusionError(EVENT_CONFLICT, `approval ${event.payload.approvalId} is not pending`);
	const pendingApprovalIds = next.pendingApprovalIds.filter((id) => id !== event.payload.approvalId);
	const pendingApprovals = { ...next.pendingApprovals };
	delete pendingApprovals[event.payload.approvalId];
	const control = patchControl(next, { pendingApprovalIds });
	if (event.payload.state !== "approved") return {
		...next,
		pendingApprovalIds,
		pendingApprovals,
		control: {
			...control,
			mode: "paused"
		},
		phase: pendingApprovalIds.length ? "WAITING_APPROVAL" : "NEEDS_DECISION"
	};
	return projectReleasedControl({
		...next,
		pendingApprovalIds,
		pendingApprovals,
		control
	});
}
function currentSnapshot(state) {
	return state.lastSnapshot ?? state.validatedReport?.snapshot ?? state.candidateReport?.snapshot ?? state.lastReport?.snapshot;
}
function writerBusy(state) {
	return Boolean(state.lease && state.lease.activeOperationIds.length > 0);
}
function assertControlAllowsExecution(state) {
	if (state.control.mode !== "running") throw new FusionError(CONTROL_BLOCKED, `control mode ${state.control.mode} blocks execution`);
	if (state.control.pendingApprovalIds.length) throw new FusionError(CONTROL_BLOCKED, "pending human approval blocks execution");
	if (state.control.outcomeUnknown || state.outcomeUnknown) throw new FusionError(EVENT_CONFLICT, "cannot complete while an effect is OUTCOME_UNKNOWN");
	if (state.control.budgetBlocked || state.control.recovering) throw new FusionError(CONTROL_BLOCKED, "budget or recovery gate is still set");
	if (writerBusy(state)) throw new FusionError(CONTROL_BLOCKED, "an active write lease blocks execution");
}
function assertAcceptingReview(state, event) {
	if (state.intent === "DIRECT") return;
	if (event.payload.verification !== "verified") throw new FusionError(EVENT_CONFLICT, "delegated downgrade must not use ordinary verified completion");
	const accepted = state.acceptedReview;
	const ticket = state.activeReviewTicket;
	const validated = state.validatedReport;
	const candidate = state.candidateReport;
	const receipt = state.validatedReceipt;
	if (!accepted || !ticket || !validated || !candidate || !receipt) throw new FusionError(REVIEW_TICKET_REQUIRED, "delegated task cannot complete before a bound accepting review");
	const actualSnapshot = state.lastSnapshot ?? accepted.ticket.subject.snapshot;
	assertCurrentSubject(state, accepted.ticket, actualSnapshot);
	if (digestOf(accepted.ticket) !== digestOf(ticket) || accepted.ticket.generation !== state.reviewGeneration) throw new FusionError(EVENT_CONFLICT, "accepting review is stale for the current generation");
	if (!sameSubject(accepted.ticket.subject, reportSubject(state.taskId, candidate))) throw new FusionError(EVENT_CONFLICT, "accepting review does not match the current candidate");
	if (!sameSubject(accepted.ticket.subject, reportSubject(state.taskId, validated))) throw new FusionError(EVENT_CONFLICT, "accepting review does not match the current validated report");
	if (accepted.ticket.validationDigest !== digestOf(receipt)) throw new FusionError(EVENT_CONFLICT, "accepting review validation receipt changed");
	if (!state.reviewResult || digestOf(state.reviewResult) !== accepted.resultDigest) throw new FusionError(EVENT_CONFLICT, "accepting review result changed");
	if (!state.reviewResult.protocolValid || state.reviewResult.decision !== "accept") throw new FusionError(EVENT_CONFLICT, "review result is not an accepting decision");
	const snapshot = currentSnapshot(state);
	if (!snapshot || accepted.ticket.subject.snapshot !== snapshot) throw new FusionError(EVENT_CONFLICT, "accepting review snapshot is not the current workspace snapshot");
	if (event.payload.snapshot !== snapshot) throw new FusionError(EVENT_CONFLICT, "completion snapshot is not the current workspace snapshot");
}
function complete(state, event) {
	if (event.revision < state.revision) throw new FusionError(REVISION_STALE, "old revision cannot complete a newer task");
	assertControlAllowsExecution(state);
	if (state.outcomeUnknown || state.control.outcomeUnknown) throw new FusionError(EVENT_CONFLICT, "cannot complete while an effect is OUTCOME_UNKNOWN");
	if (state.phase !== "REVIEWING" && state.phase !== "DIRECT") throw new FusionError(EVENT_CONFLICT, `cannot complete from ${state.phase}`);
	if (event.payload.verification === "verified") assertAcceptingReview(state, event);
	else if (state.intent !== "DIRECT") throw new FusionError(EVENT_CONFLICT, "delegated downgrade must use an explicit fallback event, not ordinary completion");
	return {
		...state,
		phase: "COMPLETED",
		verification: event.payload.verification,
		lastSnapshot: event.payload.snapshot,
		control: patchControl(state, { mode: "completed" })
	};
}
function assertNever(event) {
	throw new FusionError(EVENT_CONFLICT, `unknown event ${event.type}`);
}
function reduce(state, event) {
	if (event.schemaVersion !== 1) throw new FusionError(EVENT_CONFLICT, `unsupported schemaVersion ${event.schemaVersion}`);
	if (state?.appliedEventIds.includes(event.id)) return state;
	return applyPayload(state, event);
}
function reduceAll(events) {
	let state;
	for (const event of events) state = reduce(state, event);
	if (!state) throw new FusionError(EVENT_CONFLICT, "no events");
	return state;
}
//#endregion
//#region src/task/store.ts
const nodeIo = {
	existsSync,
	mkdirSync: (path) => mkdirSync(path, { recursive: true }),
	readFileSync: (path) => readFileSync(path, "utf8"),
	writeFileSync: (path, data) => writeFileSync(path, data),
	renameSync,
	rmSync: (path) => rmSync(path, { force: true })
};
const STORE_PROJECTION_VERSION = 2;
var FileFusionStore = class {
	root;
	io;
	#memory = /* @__PURE__ */ new Map();
	constructor(root, io = nodeIo) {
		this.root = root;
		this.io = io;
	}
	load(taskId) {
		return this.#read(taskId)?.persisted.state;
	}
	replay(taskId) {
		return reduceAll(this.#require(taskId).persisted.events);
	}
	create(event) {
		if (this.load(event.taskId)) throw new FusionError(EVENT_CONFLICT, "task exists");
		const state = reduce(void 0, event);
		this.#persist(event.taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: {
				state,
				events: [event],
				outbox: []
			},
			artifacts: []
		});
		return this.#require(event.taskId).persisted.state;
	}
	transact(taskId, expectedSeq, mutate) {
		const current = this.#require(taskId);
		if (current.persisted.state.seq !== expectedSeq) throw new FusionError(EVENT_CONFLICT, `expected seq ${expectedSeq}, have ${current.persisted.state.seq}`);
		const patch = mutate(current.persisted);
		let state = current.persisted.state;
		const nextEvents = [...current.persisted.events];
		for (const event of patch.events ?? []) {
			if (state.appliedEventIds.includes(event.id)) continue;
			state = reduce(state, event);
			nextEvents.push(event);
		}
		this.#persist(taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: {
				state,
				events: nextEvents,
				outbox: patch.outbox ?? current.persisted.outbox
			},
			artifacts: current.artifacts
		});
		return this.#require(taskId).persisted.state;
	}
	append(taskId, expectedRevision, events) {
		const current = this.#require(taskId);
		if (current.persisted.state.revision !== expectedRevision) throw new FusionError(REVISION_CONFLICT, `expected revision ${expectedRevision}, have ${current.persisted.state.revision}`);
		let state = current.persisted.state;
		const nextEvents = [...current.persisted.events];
		for (const event of events) {
			if (state.appliedEventIds.includes(event.id)) continue;
			state = reduce(state, event);
			nextEvents.push(event);
		}
		this.#persist(taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: {
				state,
				events: nextEvents,
				outbox: current.persisted.outbox
			},
			artifacts: current.artifacts
		});
		return this.#require(taskId).persisted.state;
	}
	putArtifact(taskId, bytes, mediaType) {
		const current = this.#require(taskId);
		const digest = sha256Hex(bytes);
		const dir = this.#taskDir(taskId);
		this.io.mkdirSync(join(dir, "artifacts"));
		const finalPath = join(dir, "artifacts", digest);
		const partPath = `${finalPath}.part`;
		this.io.writeFileSync(partPath, bytes);
		this.io.renameSync(partPath, finalPath);
		const record = {
			id: ArtifactId(digest),
			digest,
			ownerTaskId: taskId,
			mediaType,
			bytes: bytes.byteLength,
			storageRef: finalPath
		};
		this.#persist(taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: current.persisted,
			artifacts: [...current.artifacts.filter((item) => item.digest !== digest), record]
		});
		return record;
	}
	prepareOutbox(row) {
		const current = this.#require(row.taskId);
		const existing = current.persisted.outbox.find((item) => item.operationId === row.operationId);
		if (existing) return existing;
		this.#persist(row.taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: {
				...current.persisted,
				outbox: [...current.persisted.outbox, {
					...row,
					state: "prepared"
				}]
			},
			artifacts: current.artifacts
		});
		return this.outbox(row.taskId).find((item) => item.operationId === row.operationId);
	}
	advanceOutbox(taskId, operationId, from, to, patch = {}) {
		const current = this.#require(taskId);
		const next = current.persisted.outbox.map((row) => {
			if (row.operationId !== operationId) return row;
			if (row.state !== from) throw new FusionError(EVENT_CONFLICT, `outbox ${operationId} is ${row.state}, not ${from}`);
			return {
				...row,
				...patch,
				state: to
			};
		});
		if (!next.some((row) => row.operationId === operationId)) throw new FusionError(EVENT_CONFLICT, `outbox ${operationId} missing`);
		this.#persist(taskId, {
			projectionVersion: 2,
			checksum: "",
			persisted: {
				...current.persisted,
				outbox: next
			},
			artifacts: current.artifacts
		});
		return this.outbox(taskId).find((row) => row.operationId === operationId);
	}
	outbox(taskId) {
		return this.#require(taskId).persisted.outbox;
	}
	artifacts(taskId) {
		return this.#require(taskId).artifacts;
	}
	#taskDir(taskId) {
		return join(this.root, "tasks", taskId);
	}
	#read(taskId) {
		const cached = this.#memory.get(taskId);
		if (cached) return cached;
		const path = join(this.#taskDir(taskId), "snapshot.json");
		if (!this.io.existsSync(path)) return void 0;
		const parsed = decodeStoreSnapshot(this.io.readFileSync(path), taskId);
		this.#memory.set(taskId, parsed);
		return parsed;
	}
	#require(taskId) {
		const snap = this.#read(taskId);
		if (!snap) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`);
		return snap;
	}
	#persist(taskId, next) {
		const checksum = digestOf({
			persisted: next.persisted,
			artifacts: next.artifacts
		});
		const snapshot = {
			...next,
			projectionVersion: 2,
			checksum
		};
		const dir = this.#taskDir(taskId);
		this.io.mkdirSync(dir);
		const finalPath = join(dir, "snapshot.json");
		const tmpPath = `${finalPath}.tmp`;
		try {
			this.io.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`);
			this.io.renameSync(tmpPath, finalPath);
		} catch (error) {
			try {
				this.io.rmSync(tmpPath);
			} catch {}
			throw new FusionError(FLUSH_FAILED, error instanceof Error ? error.message : "flush failed");
		}
		this.#memory.set(taskId, snapshot);
	}
};
/** Validate before either backend admits a persisted execution projection. */
function decodeStoreSnapshot(raw, taskId) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} is not a JSON store document`);
	}
	if (!parsed || typeof parsed !== "object" || !parsed.persisted) throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} is not a store document`);
	if (parsed.checksum !== digestOf({
		persisted: parsed.persisted,
		artifacts: parsed.artifacts
	})) throw new FusionError(CHECKSUM_MISMATCH, `corrupt snapshot for ${taskId}`);
	requireStorageProjectionVersion(parsed);
	const state = parsed.persisted.state;
	const control = state?.control;
	if (!control || ![
		"running",
		"paused",
		"stop-requested",
		"cancelled",
		"completed"
	].includes(control.mode) || !Array.isArray(control.pendingApprovalIds) || !control.pendingApprovalIds.every((id) => typeof id === "string") || typeof control.budgetBlocked !== "boolean" || typeof control.recovering !== "boolean" || typeof control.outcomeUnknown !== "boolean" || !Array.isArray(state.pendingApprovalIds) || !state.pendingApprovals || !Array.isArray(state.appliedEventIds) || !Array.isArray(state.ignoredReviewResults) || !Array.isArray(state.staleValidations) || !Number.isSafeInteger(state.reviewGeneration) || !Array.isArray(parsed.persisted.events) || !Array.isArray(parsed.persisted.outbox) || !Array.isArray(parsed.artifacts) || state.taskId !== taskId) throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} has an incomplete execution projection`);
	return parsed;
}
function requireStorageProjectionVersion(raw) {
	if (!raw || typeof raw !== "object") throw new FusionError(STORE_MIGRATION_REQUIRED, "INVALID_STORE_DOCUMENT");
	if (raw.projectionVersion !== 2) throw new FusionError(STORE_MIGRATION_REQUIRED, "STORE_MIGRATION_REQUIRED");
}
function failingRenameIo(base, failOnce = true) {
	let failed = false;
	return {
		...base,
		renameSync(from, to) {
			if (dirname(to).endsWith("artifacts")) {
				base.renameSync(from, to);
				return;
			}
			if (!failed || !failOnce) {
				failed = true;
				throw new Error("injected flush failure");
			}
			base.renameSync(from, to);
		}
	};
}
//#endregion
//#region src/task/sqlite-store.ts
/** Durable Host backend. Every read is fresh; CAS and outbox writes share one transaction. */
var SqliteFusionStore = class {
	filename;
	#db;
	constructor(filename) {
		this.filename = filename;
		if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
		this.#db = new DatabaseSync(filename);
		try {
			this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
			const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== 1) throw new FusionError(STORE_MIGRATION_REQUIRED, "unknown Fusion database version");
			if (version === 0) {
				if (this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.n !== 0) throw new FusionError(STORE_MIGRATION_REQUIRED, "unversioned nonempty Fusion database");
				this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
          CREATE TABLE artifacts (task_id TEXT NOT NULL REFERENCES tasks(id), digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(task_id, digest));
          CREATE TABLE documents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, checksum TEXT NOT NULL);
          PRAGMA user_version = 1;
          COMMIT;`);
			}
			this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}
	close() {
		this.#db.close();
	}
	listTaskIds() {
		return this.#db.prepare("SELECT id FROM tasks ORDER BY id").all().map((row) => {
			if (typeof row.id !== "string") throw new FusionError(STORE_MIGRATION_REQUIRED, "invalid task identity");
			return row.id;
		});
	}
	listDocumentIds(prefix) {
		return this.#db.prepare("SELECT id FROM documents WHERE substr(id, 1, ?) = ? ORDER BY id").all(prefix.length, prefix).map((row) => {
			if (typeof row.id !== "string") throw new FusionError(STORE_MIGRATION_REQUIRED, "invalid document identity");
			return row.id;
		});
	}
	load(taskId) {
		return this.#read(taskId)?.persisted.state;
	}
	events(taskId) {
		return this.#require(taskId).persisted.events;
	}
	replay(taskId) {
		return reduceAll(this.#require(taskId).persisted.events);
	}
	create(event) {
		return this.#transaction(() => {
			if (this.#read(event.taskId)) throw new FusionError(EVENT_CONFLICT, "task exists");
			const state = reduce(void 0, event);
			this.#write(event.taskId, {
				state,
				events: [event],
				outbox: []
			}, []);
			return state;
		});
	}
	transact(taskId, expectedSeq, mutate) {
		return this.#transaction(() => {
			const current = this.#require(taskId);
			if (current.persisted.state.seq !== expectedSeq) throw new FusionError(EVENT_CONFLICT, "task sequence changed");
			const patch = mutate(structuredClone(current.persisted));
			return this.#apply(taskId, current, patch.events ?? [], patch.outbox ?? current.persisted.outbox);
		});
	}
	append(taskId, expectedRevision, events) {
		return this.#transaction(() => {
			const current = this.#require(taskId);
			if (current.persisted.state.revision !== expectedRevision) throw new FusionError(REVISION_CONFLICT, "task revision changed");
			return this.#apply(taskId, current, events, current.persisted.outbox);
		});
	}
	putArtifact(taskId, bytes, mediaType) {
		return this.putArtifacts(taskId, [{
			bytes,
			mediaType
		}])[0];
	}
	/** One atomic metadata update for a bounded workspace evidence batch. */
	putArtifacts(taskId, inputs) {
		return this.#transaction(() => {
			const current = this.#require(taskId);
			const records = new Map(current.artifacts.map((record) => [record.digest, record]));
			const insert = this.#db.prepare("INSERT OR IGNORE INTO artifacts(task_id, digest, bytes) VALUES (?, ?, ?)");
			const result = inputs.map(({ bytes, mediaType }) => {
				const digest = sha256Hex(bytes);
				const record = {
					id: ArtifactId(digest),
					digest,
					ownerTaskId: taskId,
					mediaType,
					bytes: bytes.byteLength,
					storageRef: `sqlite:${taskId}:${digest}`
				};
				insert.run(taskId, digest, bytes);
				records.set(digest, record);
				return record;
			});
			this.#write(taskId, current.persisted, [...records.values()]);
			return result;
		});
	}
	/** Load owned evidence bytes and verify content before trusting the reference. */
	readArtifact(taskId, digest) {
		return this.readArtifacts(taskId, [digest])[0];
	}
	readArtifacts(taskId, digests) {
		const records = new Map(this.artifacts(taskId).map((record) => [record.digest, record]));
		const select = this.#db.prepare("SELECT bytes FROM artifacts WHERE task_id = ? AND digest = ?");
		return digests.map((digest) => {
			const record = records.get(digest), row = select.get(taskId, digest);
			if (!record || !(row?.bytes instanceof Uint8Array)) throw new FusionError(EVENT_CONFLICT, "artifact not owned by task");
			if (sha256Hex(row.bytes) !== digest || row.bytes.byteLength !== record.bytes) throw new FusionError(CHECKSUM_MISMATCH, "corrupt artifact");
			return row.bytes;
		});
	}
	prepareOutbox(row) {
		return this.#transaction(() => {
			const current = this.#require(row.taskId);
			const existing = current.persisted.outbox.find((item) => item.operationId === row.operationId);
			if (existing) return existing;
			const prepared = {
				...row,
				state: "prepared"
			};
			this.#write(row.taskId, {
				...current.persisted,
				outbox: [...current.persisted.outbox, prepared]
			}, current.artifacts);
			return prepared;
		});
	}
	advanceOutbox(taskId, operationId, from, to, patch = {}) {
		return this.#transaction(() => {
			const current = this.#require(taskId);
			const prior = current.persisted.outbox.find((item) => item.operationId === operationId);
			if (!prior || prior.state !== from) throw new FusionError(EVENT_CONFLICT, "outbox state changed or missing");
			if (patch.operationId !== void 0 && patch.operationId !== prior.operationId || patch.taskId !== void 0 && patch.taskId !== prior.taskId) throw new FusionError(EVENT_CONFLICT, "outbox identity is immutable");
			const next = {
				...prior,
				...patch,
				state: to
			};
			this.#write(taskId, {
				...current.persisted,
				outbox: current.persisted.outbox.map((item) => item.operationId === operationId ? next : item)
			}, current.artifacts);
			return next;
		});
	}
	outbox(taskId) {
		return this.#require(taskId).persisted.outbox;
	}
	artifacts(taskId) {
		return this.#require(taskId).artifacts;
	}
	/** Host binding / usage documents require caller-side schema validation after loading. */
	readDocument(id) {
		const row = this.#db.prepare("SELECT revision, json, checksum FROM documents WHERE id = ?").get(id);
		if (!row) return void 0;
		if (typeof row.json !== "string" || typeof row.revision !== "number") throw new FusionError(STORE_MIGRATION_REQUIRED, "invalid Host document");
		if (sha256Hex(Buffer.from(row.json)) !== row.checksum) throw new FusionError(CHECKSUM_MISMATCH, "corrupt Host document");
		return {
			revision: row.revision,
			value: JSON.parse(row.json)
		};
	}
	/** Compare-and-swap prevents an old Host instance overwriting a newer selection or bill. */
	writeDocument(id, expectedRevision, value) {
		return this.#transaction(() => this.#writeDocument(id, expectedRevision, value));
	}
	writeDocuments(rows) {
		return this.#transaction(() => rows.map((row) => this.#writeDocument(row.id, row.expectedRevision, row.value)));
	}
	#writeDocument(id, expectedRevision, value) {
		if ((this.readDocument(id)?.revision ?? 0) !== expectedRevision) throw new FusionError(REVISION_CONFLICT, "Host document revision changed");
		const json = JSON.stringify(value);
		if (json === void 0) throw new Error("Host document must be JSON serializable");
		const revision = expectedRevision + 1;
		this.#db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, json=excluded.json, checksum=excluded.checksum").run(id, revision, json, sha256Hex(Buffer.from(json)));
		return revision;
	}
	#apply(taskId, current, events, outbox) {
		let state = current.persisted.state;
		const nextEvents = [...current.persisted.events];
		for (const event of events) {
			if (state.appliedEventIds.includes(event.id)) continue;
			state = reduce(state, event);
			nextEvents.push(event);
		}
		this.#write(taskId, {
			state,
			events: nextEvents,
			outbox
		}, current.artifacts);
		return state;
	}
	#read(taskId) {
		const row = this.#db.prepare("SELECT snapshot FROM tasks WHERE id = ?").get(taskId);
		if (!row) return void 0;
		if (typeof row.snapshot !== "string") throw new FusionError(STORE_MIGRATION_REQUIRED, "invalid task snapshot");
		return decodeStoreSnapshot(row.snapshot, taskId);
	}
	#require(taskId) {
		const current = this.#read(taskId);
		if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`);
		return current;
	}
	#write(taskId, persisted, artifacts) {
		const snapshot = {
			projectionVersion: 2,
			persisted,
			artifacts,
			checksum: digestOf({
				persisted,
				artifacts
			})
		};
		this.#db.prepare("INSERT INTO tasks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot").run(taskId, JSON.stringify(snapshot));
		const indexId = `task-index:${taskId}`;
		const prior = this.readDocument(indexId), summary = taskSummary(persisted.state, persisted.events[0].createdAt, persisted.events.at(-1).createdAt);
		const priorTitle = (prior?.value)?.title;
		if (!persisted.state.currentWorkOrder && typeof priorTitle === "string") summary.title = priorTitle;
		this.#writeDocument(indexId, prior?.revision ?? 0, summary);
	}
	#transaction(body) {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}
};
//#endregion
//#region src/host/bindings.ts
function object(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Fusion session binding");
	return value;
}
function readBinding(value, sessionId) {
	const row = object(value);
	if (row.schemaVersion !== 1 || row.sessionId !== sessionId || typeof row.taskId !== "string" || typeof row.selected !== "boolean") throw new Error("Fusion binding migration or reconciliation required");
	const prompt = object(row.prompts);
	if (row.workerId !== void 0 && (typeof row.workerId !== "string" || !row.workerId || row.workerId.includes("\0"))) throw new Error("Invalid persistent Fusion Worker identity");
	if (typeof prompt.lead !== "string" || typeof prompt.worker !== "string" || typeof prompt.compact !== "string") throw new Error("Frozen Fusion prompts are missing");
	const prompts = {
		lead: prompt.lead,
		worker: prompt.worker,
		compact: prompt.compact
	};
	const profile = completeProfile(object(row.profile), prompts);
	if (digestOf(profile) !== digestOf(row.profile)) throw new Error("Frozen Fusion profile or prompt digest changed");
	return {
		schemaVersion: 1,
		sessionId,
		taskId: TaskId(row.taskId),
		selected: row.selected,
		profile,
		prompts,
		...row.workerId === void 0 ? {} : { workerId: row.workerId }
	};
}
/** Selection is durable and scoped by the native Lead identity, never a global default. */
var BindingRepository = class {
	store;
	constructor(store) {
		this.store = store;
	}
	read(sessionId) {
		const document = this.store.readDocument(`binding:${sessionId}`);
		return document ? {
			revision: document.revision,
			binding: readBinding(document.value, sessionId)
		} : void 0;
	}
	select(sessionId, id, resolved) {
		const prior = this.read(sessionId);
		if (prior?.binding.selected) throw new Error("Fusion is already selected for this session");
		const binding = {
			schemaVersion: 1,
			sessionId,
			taskId: id,
			selected: true,
			profile: structuredClone(resolved.profile),
			prompts: structuredClone(resolved.prompts)
		};
		readBinding(binding, sessionId);
		this.store.writeDocument(`binding:${sessionId}`, prior?.revision ?? 0, binding);
		return binding;
	}
	clear(sessionId) {
		const prior = this.read(sessionId);
		if (!prior || !prior.binding.selected) return;
		this.store.writeDocument(`binding:${sessionId}`, prior.revision, {
			...prior.binding,
			selected: false
		});
	}
	/** Reserve identity before native dispatch; an existing selection cannot swap workers. */
	assignWorker(sessionId, expectedTask, workerId) {
		const prior = this.read(sessionId);
		if (!prior?.binding.selected || prior.binding.taskId !== expectedTask) throw new Error("Fusion binding changed before Worker dispatch");
		if (prior.binding.workerId && prior.binding.workerId !== workerId) throw new Error("Persistent Worker identity cannot change within a Fusion selection");
		const binding = {
			...prior.binding,
			workerId
		};
		readBinding(binding, sessionId);
		this.store.writeDocument(`binding:${sessionId}`, prior.revision, binding);
	}
	/** A new native user turn starts a new task while preserving the frozen pair. */
	rollover(sessionId, expectedTask, nextTask) {
		const prior = this.read(sessionId);
		if (!prior?.binding.selected || prior.binding.taskId !== expectedTask) throw new Error("Fusion binding changed during task rollover");
		const binding = {
			...prior.binding,
			taskId: nextTask
		};
		this.store.writeDocument(`binding:${sessionId}`, prior.revision, binding);
		return binding;
	}
	selected() {
		return this.store.listDocumentIds("binding:").map((id) => this.read(id.slice(8)).binding).filter((row) => row.selected);
	}
};
//#endregion
//#region src/host/native-worker-notices.ts
/** Reduce only our Worker's runtime closing notice, never its structured report. */
var NativeWorkerNotices = class {
	store;
	constructor(store) {
		this.store = store;
	}
	project(agent, binding, original) {
		const source = original.source;
		if (agent.id !== binding.sessionId || source?.kind !== "subagent-settled") return original;
		const child = this.store.readDocument(`child:${source.senderSessionId}`)?.value;
		const task = child?.taskId && this.store.load(child.taskId);
		if (child?.parent !== agent.id || !task || task.parent !== String(agent.id) || task.acceptedChild !== String(source.senderSessionId) && task.reservedChild !== String(source.senderSessionId)) return original;
		const originalDigest = digestOf(original);
		const id = `worker-notice:${binding.taskId}:${digestOf({
			parent: agent.id,
			message: original.id
		})}`;
		const saved = this.store.readDocument(id)?.value;
		if (saved) {
			if (saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.parentId !== agent.id || saved.childId !== source.senderSessionId || saved.originalDigest !== originalDigest) throw new Error("Fusion Worker notice identity requires reconciliation");
			this.store.readArtifact(binding.taskId, saved.artifact.id);
			return saved.message;
		}
		const artifact = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify(original)), "application/vnd.dsh-fusion.worker-notice+json");
		const message = createUserMessage({
			source: {
				kind: "plugin:dsh-model-fusion",
				form: "notice",
				summary: source.summary
			},
			content: [{
				type: "text",
				text: `${source.summary}\nThis is a Worker activation notice, not task acceptance. Use the structured Fusion report and check evidence; use fusion_wait if they have not been collected. Closing transcript is archived rather than repeated here. For missing failure details use fusion_read_evidence with id ${artifact.id}.\n${JSON.stringify({
					childId: source.senderSessionId,
					originalMessageId: original.id,
					artifact
				})}`
			}]
		});
		this.store.writeDocument(id, 0, {
			schemaVersion: 1,
			taskId: binding.taskId,
			parentId: agent.id,
			childId: source.senderSessionId,
			originalMessageId: original.id,
			originalDigest,
			artifact,
			message
		});
		return message;
	}
	/** Replace retained legacy notices before the native compactor reads history.
	* Public surface replacement preserves the original append-only event and
	* cites it. Already compacted prose cannot be safely reverse-transformed.
	*/
	projectHistory(agent, binding) {
		for (const seq of [...agent.session.surface.nodes]) {
			const event = agent.session.eventAt(seq);
			if (event?.type !== "user/message") continue;
			const message = this.project(agent, binding, event.data);
			if (message === event.data) continue;
			agent.session.append("user/message", message, {
				surfaceOp: {
					op: "replace",
					startSeq: seq,
					endSeq: seq
				},
				sourceEventSeqs: [seq]
			});
		}
	}
};
//#endregion
//#region src/execution/write-lease.ts
function canonicalWorkspace(cwd) {
	return fs.realpathSync.native(cwd);
}
const DURABLE_LEASE_ROOT = path.join(os.homedir(), ".local", "state", "dsh-model-fusion", "leases");
function leasePath(workspaceId, root = DURABLE_LEASE_ROOT) {
	const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
	return path.join(root, `${key}.lock`);
}
var WorkspaceWriteLease = class {
	root;
	constructor(root = DURABLE_LEASE_ROOT) {
		this.root = root;
		if (!path.isAbsolute(root)) throw new TypeError("lease registry directory must be absolute");
	}
	acquire(input) {
		const workspaceId = canonicalWorkspace(input.cwd);
		return this.#transaction(workspaceId, (db) => {
			const row = this.#row(db);
			const prior = this.#record(row, workspaceId);
			if (prior) throw new FusionError(LEASE_BUSY, `workspace is held by ${prior.holder}; reconcile before handoff`);
			if (row.generation === Number.MAX_SAFE_INTEGER) throw new FusionError(LEASE_GENERATION, "lease generation exhausted");
			const refs = [...new Set([process.pid, ...input.liveProcessRefs ?? []])];
			if (refs.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new FusionError(LEASE_BUSY, "invalid process reference");
			const record = {
				workspaceId,
				holder: input.holder,
				taskId: input.taskId,
				generation: row.generation + 1,
				activeOperationIds: [input.operationId],
				owner: `${process.pid}:${randomUUID()}`,
				pid: process.pid,
				acquiredAt: (/* @__PURE__ */ new Date()).toISOString(),
				liveProcessRefs: refs
			};
			db.prepare("UPDATE lease SET generation=?, record=? WHERE id=1").run(record.generation, JSON.stringify(record));
			return record;
		});
	}
	assertGeneration(lease, generation) {
		const current = this.current(lease.workspaceId);
		if (lease.generation !== generation || current?.generation !== generation || current.holder !== lease.holder || current.taskId !== lease.taskId) throw new FusionError(LEASE_GENERATION, `stale write generation ${generation}`);
	}
	stillHeld(lease) {
		const current = this.current(lease.workspaceId);
		return current?.owner === lease.owner && current.generation === lease.generation;
	}
	/** Caller must prove native Worker/tool quiescence before releasing. */
	release(lease) {
		this.#transaction(lease.workspaceId, (db) => {
			const current = this.#record(this.#row(db), lease.workspaceId);
			if (current?.owner === lease.owner && current.generation === lease.generation) db.prepare("UPDATE lease SET record=NULL WHERE id=1 AND generation=?").run(lease.generation);
		});
	}
	/** Trusted recovery inspection. A dead PID by itself never authorizes stealing. */
	current(cwd) {
		const workspaceId = canonicalWorkspace(cwd);
		return this.#transaction(workspaceId, (db) => this.#record(this.#row(db), workspaceId));
	}
	#row(db) {
		const row = db.prepare("SELECT generation, record FROM lease WHERE id=1").get();
		if (!row || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new FusionError(LEASE_BUSY, "durable lease generation is corrupt");
		return {
			generation: row.generation,
			record: row.record
		};
	}
	#record(row, workspaceId) {
		if (row.record === null) return void 0;
		if (typeof row.record !== "string") throw new FusionError(LEASE_BUSY, "invalid durable lease record");
		const value = JSON.parse(row.record);
		if (value.workspaceId !== workspaceId || value.generation !== row.generation || typeof value.owner !== "string" || typeof value.holder !== "string" || typeof value.taskId !== "string" || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.acquiredAt !== "string" || !Array.isArray(value.activeOperationIds) || !Array.isArray(value.liveProcessRefs)) throw new FusionError(LEASE_BUSY, "durable lease requires reconciliation");
		return value;
	}
	/** Atomic publication/CAS; generations survive release and process restart. */
	#transaction(workspaceId, body) {
		const legacy = leasePath(workspaceId, this.root);
		fs.mkdirSync(path.dirname(legacy), {
			recursive: true,
			mode: 448
		});
		const oldTemporary = leasePath(workspaceId, path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "dsh-model-fusion-leases"));
		for (const lock of new Set([legacy, oldTemporary])) try {
			fs.lstatSync(lock);
			throw new FusionError(LEASE_BUSY, "legacy writer lock requires explicit reconciliation");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const db = new DatabaseSync(`${legacy}.sqlite`);
		let transaction = false;
		try {
			db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
			transaction = true;
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== 1) throw new FusionError(LEASE_BUSY, "unknown lease database version");
			if (version === 0) {
				if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n !== 0) throw new FusionError(LEASE_BUSY, "unversioned nonempty lease database");
				db.exec("CREATE TABLE lease (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, record TEXT); INSERT INTO lease VALUES (1, 0, NULL); PRAGMA user_version=1;");
			}
			const result = body(db);
			db.exec("COMMIT");
			transaction = false;
			return result;
		} catch (error) {
			if (transaction) db.exec("ROLLBACK");
			throw error;
		} finally {
			db.close();
		}
	}
};
function classifyEffect(kind) {
	if (kind === "read-tool") return "read";
	return "write";
}
//#endregion
//#region src/review/dispatch.ts
/**
* Offline producer: persist the captured ticket and outbox row before any adapter send.
* The model callback may read the latest TaskState only for seq/CAS.
*/
function persistReviewRequest(store, taskId, ids, payloadRef) {
	const current = store.load(taskId);
	if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`);
	const ticket = captureTicket(createReviewTicket(current, ids));
	const requested = reviewRequestedEvent(current, current.seq + 1, ids);
	store.transact(taskId, current.seq, (persisted) => ({
		events: [requested],
		outbox: [...persisted.outbox, reviewOutboxRow(ticket, payloadRef)]
	}));
	return ticket;
}
function loadReviewOutboxByRequestId(store, taskId, requestId) {
	const row = store.outbox(taskId).find((item) => item.requestId === requestId || item.ticket?.requestId === requestId);
	if (!row?.ticket) throw new FusionError(EVENT_CONFLICT, `review outbox missing for ${requestId}`);
	return {
		row,
		ticket: captureTicket(row.ticket)
	};
}
function appendCapturedReviewResult(store, taskId, ticket, outcome) {
	const current = store.load(taskId);
	if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`);
	const event = resultFromCapturedTicket(ticket, outcome, {
		eventId: `review-completed-${ticket.requestId}-${current.seq + 1}`,
		seq: current.seq + 1,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	return store.append(taskId, current.revision, [event]);
}
//#endregion
//#region src/evidence/receipts.ts
function memoryVerificationRegistry(plans, receipts) {
	const planById = new Map(plans.map((plan) => [plan.id, freezePlan(plan)]));
	const receiptById = new Map(receipts.map((receipt) => [receipt.id, structuredClone(receipt)]));
	return {
		getPlan: (id) => planById.get(id),
		getReceipt: (id) => {
			const receipt = receiptById.get(id);
			return receipt === void 0 ? void 0 : structuredClone(receipt);
		}
	};
}
function freezePlan(plan) {
	return Object.freeze(structuredClone(plan));
}
function requireThat$1(value, code) {
	if (!value) throw new FusionError(EVENT_CONFLICT, code);
}
function assertPlannedCheck(workOrder, criterionId, plan, receipt, actualSnapshot) {
	requireThat$1(plan.taskId === workOrder.taskId && plan.workOrderId === workOrder.id && plan.revision === workOrder.revision, "PLAN_SCOPE_MISMATCH");
	requireThat$1(plan.criterionId === criterionId, "CRITERION_SCOPE_MISMATCH");
	requireThat$1(receipt.planDigest === digestOf(plan), "PLAN_DIGEST_MISMATCH");
	if (plan.snapshotBinding === void 0) requireThat$1(plan.snapshot === actualSnapshot, "PLAN_SNAPSHOT_MISMATCH");
	else {
		requireThat$1(plan.snapshotBinding === "candidate" && plan.version === 2, "UNSUPPORTED_SNAPSHOT_BINDING");
		requireThat$1(plan.snapshot === workOrder.baseSnapshot, "PLAN_BASE_SNAPSHOT_MISMATCH");
	}
	const criterion = workOrder.acceptance.find((item) => item.id === criterionId);
	requireThat$1(criterion && criterion.verificationKind === plan.kind, "VERIFIER_KIND_MISMATCH");
	requireThat$1(criterion.planId === plan.id && criterion.planDigest === digestOf(plan), "PLAN_NOT_FROZEN_IN_WORK_ORDER");
	requireThat$1(plan.kind === "test" || plan.kind === "static-check", "USE_TYPED_HUMAN_OR_REVIEW_RECEIPT");
	requireThat$1(plan.cwdDigest && plan.argvDigest, "EXACT_VERIFIER_CONTEXT_REQUIRED");
	const evidence = receipt.evidence;
	requireThat$1(evidence.taskId === workOrder.taskId && evidence.cwdDigest === plan.cwdDigest && evidence.argvDigest === plan.argvDigest, "INVOCATION_SCOPE_MISMATCH");
	const knownOnly = plan.kind === "test" && plan.allowedFailures !== void 0 && receipt.counts?.failed === 0 && (receipt.counts.knownFailures ?? []).every((id) => plan.allowedFailures.includes(id));
	requireThat$1(evidence.state === "completed" && evidence.endedAt !== null && (evidence.exitCode === 0 || knownOnly && evidence.exitCode !== null && (receipt.counts?.knownFailures?.length ?? 0) > 0), "CHECK_NOT_SUCCESSFUL");
	requireThat$1(evidence.inputSnapshot === actualSnapshot && evidence.outputSnapshot === actualSnapshot, "CHECK_SNAPSHOT_MISMATCH");
	if (plan.kind === "test") {
		const counts = receipt.counts;
		requireThat$1(counts && [
			counts.executed,
			counts.passed,
			counts.failed
		].every((value) => Number.isSafeInteger(value) && value >= 0), "TEST_COUNTS_REQUIRED");
		requireThat$1(counts.executed >= (plan.minExecutedTests ?? 1) && counts.failed === 0 && counts.passed === counts.executed, "TEST_SUITE_NOT_PASSED");
	}
}
function invocationHeader(record, extras = {}) {
	return {
		taskId: record.taskId,
		operationId: record.operationId,
		actor: record.actor,
		nativeToolCallId: record.nativeToolCallId,
		argvDigest: record.argvDigest,
		cwdDigest: record.cwdDigest,
		inputSnapshot: record.inputSnapshot,
		startedAt: record.startedAt,
		...extras
	};
}
function sameInvocationHeader(left, right) {
	return digestOf(left) === digestOf(right);
}
function artifactFingerprint(ref) {
	return digestOf({
		id: ref.id,
		digest: ref.digest,
		bytes: ref.bytes,
		ownerTaskId: ref.ownerTaskId,
		mediaType: ref.mediaType
	});
}
function resolveInvocation(records) {
	if (!records.length) throw new FusionError(EVENT_CONFLICT, "NO_INVOCATION");
	const header = invocationHeader(records[0]);
	for (const record of records) if (!sameInvocationHeader(header, invocationHeader(record))) throw new FusionError(EVENT_CONFLICT, "IMMUTABLE_INVOCATION_CHANGED");
	const terminals = records.filter((record) => record.state !== "started");
	if (!terminals.length) return records[0];
	const first = terminals[0];
	for (const terminal of terminals) if (digestOf({
		...first,
		id: void 0
	}) !== digestOf({
		...terminal,
		id: void 0
	})) throw new FusionError(EVENT_CONFLICT, "EVIDENCE_TERMINAL_CONFLICT");
	if (first.endedAt === null) throw new FusionError(EVENT_CONFLICT, "TERMINAL_END_REQUIRED");
	if (first.state === "completed" && (first.exitCode === null || !Number.isSafeInteger(first.exitCode))) throw new FusionError(EVENT_CONFLICT, "EXIT_STATUS_REQUIRED");
	return first;
}
function checkPlanDigest(plan) {
	return digestOf(plan);
}
//#endregion
//#region src/evidence/gate.ts
const DEFAULT_TEST_VERIFIERS = [{
	id: "pytest",
	kind: "test",
	argvDigests: [sha256Hex("python -m pytest")]
}, {
	id: "npm-test",
	kind: "test",
	argvDigests: [sha256Hex("npm test")]
}];
function sameIdentity(left, right) {
	return left.operationId === right.operationId && left.taskId === right.taskId && left.nativeToolCallId === right.nativeToolCallId;
}
function sameContent(left, right) {
	return sameIdentity(left, right) && sameInvocationHeader(invocationHeader(left), invocationHeader(right)) && left.argvDigest === right.argvDigest && left.cwdDigest === right.cwdDigest && left.actor === right.actor && left.state === right.state && left.exitCode === right.exitCode && left.inputSnapshot === right.inputSnapshot && left.outputSnapshot === right.outputSnapshot && left.endedAt === right.endedAt && left.startedAt === right.startedAt && artifactFingerprint(left.stdout) === artifactFingerprint(right.stdout) && artifactFingerprint(left.stderr) === artifactFingerprint(right.stderr) && (left.kind ?? "tool") === (right.kind ?? "tool");
}
function isLifecycleUpgrade(existing, incoming) {
	return sameIdentity(existing, incoming) && sameInvocationHeader(invocationHeader(existing), invocationHeader(incoming)) && existing.state === "started" && incoming.state === "completed";
}
function addAlias(byId, ambiguous, id, item) {
	const existing = byId.get(id);
	if (!existing) {
		byId.set(id, item);
		return;
	}
	if (sameContent(existing, item)) return;
	if (isLifecycleUpgrade(existing, item)) {
		byId.set(id, item);
		return;
	}
	if (isLifecycleUpgrade(item, existing)) return;
	ambiguous.add(id);
}
function indexRegistry(registry) {
	const byId = /* @__PURE__ */ new Map();
	const ambiguous = /* @__PURE__ */ new Set();
	const add = (item, explicitId) => {
		if (explicitId) addAlias(byId, ambiguous, explicitId, item);
		addAlias(byId, ambiguous, item.operationId, item);
		addAlias(byId, ambiguous, item.stdout.id, item);
		addAlias(byId, ambiguous, item.stderr.id, item);
	};
	if (registry instanceof Map) for (const [id, item] of registry) add(item, id);
	else if (Array.isArray(registry)) for (const item of registry) add(item);
	else for (const [id, item] of Object.entries(registry)) add(item, id);
	return {
		byId,
		ambiguous
	};
}
function eligibilityFailure(item, taskId, currentSnapshot) {
	if (item.taskId !== taskId) return `evidence ${item.operationId} belongs to task ${item.taskId}, not ${taskId}`;
	if (item.state !== "completed") return `evidence ${item.operationId} is ${item.state}, not completed`;
	if (item.endedAt === null) return `evidence ${item.operationId} has no endedAt`;
	if (item.exitCode !== 0) return `evidence ${item.operationId} exited ${item.exitCode}`;
	if (item.inputSnapshot !== currentSnapshot) return `evidence ${item.operationId} input snapshot ${item.inputSnapshot} is not current ${currentSnapshot}`;
	if (item.outputSnapshot !== currentSnapshot) return `evidence ${item.operationId} output snapshot ${item.outputSnapshot ?? "missing"} is not current ${currentSnapshot}`;
}
function plannedCheckFailure(workOrder, criterion, evidenceId, registry, actualSnapshot) {
	if (criterion.verificationKind === "human" || criterion.verificationKind === "review") return void 0;
	if (!registry || !criterion.planId || !criterion.planDigest) return `criterion ${criterion.id} has no frozen CheckPlan; allowedPaths are not a verification cwd`;
	const plan = registry.getPlan(criterion.planId);
	if (!plan) return `criterion ${criterion.id} cites unknown plan ${criterion.planId}`;
	if (criterion.planDigest !== checkPlanDigest(plan)) return `criterion ${criterion.id} plan digest does not match the frozen work-order plan`;
	const receipt = registry.getReceipt(evidenceId);
	if (!receipt) return `criterion ${criterion.id} cites legacy evidence ${evidenceId} without a planned receipt`;
	try {
		assertPlannedCheck(workOrder, criterion.id, plan, receipt, actualSnapshot);
		return;
	} catch (error) {
		return `criterion ${criterion.id}: ${error.message}`;
	}
}
function relevanceFailure(criterion, record, verifiers) {
	const kind = record.kind ?? "tool";
	if (criterion.verificationKind === "human") {
		if (kind !== "human-decision") return `human criterion ${criterion.id} cannot be fulfilled by a tool exit`;
		return;
	}
	if (criterion.verificationKind === "review") {
		if (kind !== "review-accept") return `review criterion ${criterion.id} needs an accepting review record`;
		return;
	}
	if (!verifiers.filter((verifier) => {
		if (verifier.kind !== criterion.verificationKind) return false;
		if (criterion.verifierId && verifier.id !== criterion.verifierId) return false;
		return true;
	}).some((verifier) => verifier.argvDigests?.includes(record.argvDigest))) return `criterion ${criterion.id} evidence argv is not a registered ${criterion.verificationKind} verifier`;
}
/**
* Score only the current work order's mandatory criteria and the evidence those
* claims actually cite. Historical failures stay in the registry for audit.
* Authenticity and relevance are independent checks.
*/
function evaluateReport(workOrder, report, trustedRegistry, currentSnapshot, options) {
	const trust = [];
	if (report.workOrderId !== workOrder.id) trust.push(`report workOrderId ${report.workOrderId} does not match frozen work order ${workOrder.id}`);
	if (report.revision !== workOrder.revision) trust.push(`report revision ${report.revision} does not match frozen work order revision ${workOrder.revision}`);
	if (report.snapshot !== currentSnapshot) trust.push("snapshot drift: report snapshot is not the current workspace snapshot");
	const acceptanceById = new Map(workOrder.acceptance.map((criterion) => [criterion.id, criterion]));
	const seenClaims = /* @__PURE__ */ new Set();
	const index = indexRegistry(trustedRegistry);
	const verifiers = options?.verifiers ?? DEFAULT_TEST_VERIFIERS;
	const satisfied = /* @__PURE__ */ new Set();
	for (const claim of report.coverage) {
		if (seenClaims.has(claim.criterionId)) {
			trust.push(`duplicate criterion ${claim.criterionId}`);
			continue;
		}
		seenClaims.add(claim.criterionId);
		if (!acceptanceById.has(claim.criterionId)) {
			trust.push(`unknown criterion ${claim.criterionId}`);
			continue;
		}
		if (claim.state !== "satisfied") continue;
		if (claim.evidenceIds.length === 0) {
			trust.push(`criterion ${claim.criterionId} claimed satisfied without evidence`);
			continue;
		}
		const criterion = acceptanceById.get(claim.criterionId);
		const cited = /* @__PURE__ */ new Set();
		let claimOk = true;
		for (const evidenceId of claim.evidenceIds) {
			if (cited.has(evidenceId)) continue;
			cited.add(evidenceId);
			if (index.ambiguous.has(evidenceId)) {
				trust.push(`criterion ${claim.criterionId} cites ambiguous evidence id ${evidenceId}`);
				claimOk = false;
				continue;
			}
			if (criterion.verificationKind === "test" || criterion.verificationKind === "static-check") {
				const planned = plannedCheckFailure(workOrder, criterion, evidenceId, options?.registry, currentSnapshot);
				if (planned) {
					trust.push(planned.startsWith("criterion ") ? planned : `criterion ${claim.criterionId}: ${planned}`);
					claimOk = false;
				}
				continue;
			}
			const record = index.byId.get(evidenceId);
			if (!record) {
				trust.push(`criterion ${claim.criterionId} cites unknown evidence id ${evidenceId}`);
				claimOk = false;
				continue;
			}
			const why = eligibilityFailure(record, workOrder.taskId, currentSnapshot) ?? relevanceFailure(criterion, record, verifiers);
			if (why) {
				trust.push(`criterion ${claim.criterionId}: ${why}`);
				claimOk = false;
			}
		}
		if (claimOk) satisfied.add(claim.criterionId);
	}
	if (trust.length) return {
		verification: "unverified",
		reasons: trust
	};
	const coverage = [];
	if (report.status !== "completed") coverage.push(`report status is ${report.status}`);
	if (report.unresolved.length) coverage.push(`${report.unresolved.length} unresolved item(s) remain`);
	for (const criterion of workOrder.acceptance) {
		if (!criterion.mandatory) continue;
		if (!satisfied.has(criterion.id)) coverage.push(`mandatory criterion ${criterion.id} is not satisfied by current trusted evidence`);
	}
	if (coverage.length) return {
		verification: "partial",
		reasons: coverage
	};
	return {
		verification: "verified",
		reasons: []
	};
}
//#endregion
//#region src/host/workspace.ts
const SNAPSHOT_EXCLUSIONS = [
	".git",
	"node_modules",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache"
];
const FALLBACK_EXCLUSIONS = [
	...SNAPSHOT_EXCLUSIONS,
	".venv",
	"venv",
	".tox",
	".nox",
	".eggs",
	".gradle",
	".next",
	".turbo",
	".cache"
];
function workspacePath(root, path) {
	if (!path || isAbsolute(path) || path.includes("\0")) throw new Error("Workspace paths must be nonempty relative paths");
	const absolute = resolve(root, path);
	const rel = relative(root, absolute);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes the workspace");
	let current = root;
	for (const part of rel.split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error("Workspace path traverses a symlink");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	return absolute;
}
const MAX_ENTRIES = 2e5;
const LARGE_FILE = 16 * 1024 * 1024;
/**
* Source files git would consider (tracked plus untracked, minus the repository's ignore rules), relative
* to root; undefined outside a git work tree or without git. Ignore rules are the project's own statement
* of what is not source (virtualenvs, build output, caches), so no per-ecosystem list has to guess.
*/
function gitSourceFiles(root) {
	try {
		const out = execFileSync("git", [
			"-C",
			root,
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard"
		], {
			encoding: "buffer",
			maxBuffer: 512 * 1024 * 1024,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0"
			}
		});
		return [...new Set(out.toString("utf8").split("\0").filter(Boolean))].sort();
	} catch {
		return;
	}
}
function snapshotWorkspace(cwd) {
	const root = realpathSync.native(cwd);
	const entries = [];
	const excluded = (path) => path.split("/").some((part) => SNAPSHOT_EXCLUSIONS.includes(part));
	function add(full, path, stat) {
		if (stat.isSymbolicLink()) entries.push({
			path,
			kind: "symlink",
			digest: sha256Hex(readlinkSync(full)),
			executable: false
		});
		else if (stat.isFile()) {
			const contents = stat.size > LARGE_FILE ? void 0 : readFileSync(full);
			const after = lstatSync(full);
			if (after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.size !== (contents?.length ?? stat.size)) throw new Error("Workspace changed while taking the snapshot");
			entries.push({
				path,
				kind: "file",
				digest: contents ? sha256Hex(contents) : sha256Hex(`large:${stat.size}:${stat.mtimeMs}`),
				executable: Boolean(stat.mode & 73)
			});
		} else if (!stat.isDirectory()) throw new Error(`Unsupported source file type: ${path}`);
		if (entries.length > MAX_ENTRIES) throw new Error("Workspace exceeds the bounded file manifest; choose a smaller project root");
	}
	function visit(directory) {
		for (const name of readdirSync(directory).sort()) {
			const full = join(directory, name);
			const stat = lstatSync(full);
			if (stat.isDirectory()) {
				if (!FALLBACK_EXCLUSIONS.includes(name)) visit(full);
				continue;
			}
			add(full, relative(root, full).split(sep).join("/"), stat);
		}
	}
	const listed = gitSourceFiles(root);
	if (listed) for (const path of listed) {
		if (excluded(path)) continue;
		const full = join(root, ...path.split("/"));
		let stat;
		try {
			stat = lstatSync(full);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (!stat.isDirectory()) add(full, path, stat);
	}
	else visit(root);
	const manifest = {
		schemaVersion: 1,
		root,
		excludedDirectoryNames: listed ? SNAPSHOT_EXCLUSIONS : FALLBACK_EXCLUSIONS,
		...listed ? { ignoreRules: "git-exclude-standard" } : {},
		entries
	};
	return {
		...manifest,
		id: SnapshotId(`source:${digestOf(manifest)}`)
	};
}
function changedPaths(before, after) {
	if (before.root !== after.root) throw new Error("Workspace root changed");
	const old = new Map(before.entries.map((entry) => [entry.path, digestOf(entry)]));
	const now = new Map(after.entries.map((entry) => [entry.path, digestOf(entry)]));
	return [...new Set([...old.keys(), ...now.keys()])].filter((path) => old.get(path) !== now.get(path)).sort();
}
/**
* Workspace-relative allowlist check. `/` always separates segments; `\` is a
* separator only on Windows — on POSIX it is a legal filename character, so
* `src\file.ts` must not match a `src` grant there. `.`/`..` segments then
* resolve lexically, so `src/../outside` (and its backslash form on Windows)
* never matches a `src` grant. workspacePath only bounds a path to the
* workspace root; membership in allowedPaths is decided here. Absolute paths
* (`/x`, `C:\x`, drive-relative `C:x`, UNC), empty paths and NUL are not
* workspace-relative and never normalize.
*/
function normalizeRelativePath(path) {
	if (!path || path.includes("\0") || isAbsolute(path) || process.platform === "win32" && /^[a-z]:/i.test(path)) return void 0;
	const segments = [];
	for (const segment of path.split(process.platform === "win32" ? /[\\/]+/ : /\//)) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (!segments.pop()) return void 0;
		} else segments.push(segment);
	}
	return segments.join("/");
}
function pathAllowed(path, allowed) {
	const normalized = normalizeRelativePath(path);
	if (normalized === void 0) return false;
	return allowed.some((raw) => {
		const prefix = normalizeRelativePath(raw);
		return prefix !== void 0 && (prefix === "" || normalized === prefix || normalized.startsWith(`${prefix}/`));
	});
}
//#endregion
//#region src/host/shell.ts
/**
* The native shell tool the Host mounts on this platform. cordis.patch.yml
* disables tool-bash on win32 and mounts tool-pwsh instead; elsewhere the
* bash tool is the native shell. Safety gates must apply to whichever shell
* tool issued the call, so checks use {@link isShellTool}, while defaults
* and probes use {@link nativeShellTool} — the tool that actually exists.
*/
const nativeShellTool = process.platform === "win32" ? "pwsh" : "bash";
const isShellTool = (name) => name === "bash" || name === "pwsh";
process.platform;
//#endregion
//#region src/host/native-checks.ts
/** Parsers that name each failing test, which baseline-relative checks need. */
const BASELINE_PARSERS = ["pytest"];
const TEST_PARSERS = [
	"unittest",
	"pytest",
	"vitest",
	"jest",
	"mocha",
	"tap",
	"go",
	"cargo"
];
const MAX_CHECK_SECONDS = 3600;
/** Shell setup failures need a corrected check, rather than an implementation repair. */
function checkCommandUnavailable(exitCode, stderr, platform = process.platform) {
	if (exitCode === null || exitCode === 0) return false;
	if (exitCode === 126 || exitCode === 127) return true;
	if (platform !== "win32") return false;
	const text = stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
	return /\bCommandNotFoundException\b/.test(text) || /\bThe term ['"][^'"]+['"] is not recognized as (?:the |a )?name of a cmdlet, function, script file, or (?:executable|operable) program\b/i.test(text);
}
function definitionDigest(root, definition) {
	return digestOf({
		definition,
		files: definition.definitionPaths.map((path) => ({
			path,
			digest: sha256Hex(readFileSync(workspacePath(root, path)))
		}))
	});
}
function freezeChecks(order, root, definitions) {
	if (definitions.length > 12) throw new Error("Delegate accepts at most 12 acceptance checks");
	const ids = /* @__PURE__ */ new Set();
	return definitions.map((definition) => {
		if (!/^[a-zA-Z0-9._-]{1,80}$/.test(definition.id) || ids.has(definition.id)) throw new Error("Acceptance check ids must be unique");
		ids.add(definition.id);
		if (!definition.description.trim() || !definition.command.trim() || definition.command.length > 8e3) throw new Error("Invalid acceptance command");
		if (definition.kind === "test" && !TEST_PARSERS.includes(definition.parser)) throw new Error(`Test checks need a count parser (${TEST_PARSERS.join(", ")}); a runner without one is a static-check with the exit-code parser`);
		if (definition.timeoutSeconds !== void 0 && (!Number.isSafeInteger(definition.timeoutSeconds) || definition.timeoutSeconds < 1 || definition.timeoutSeconds > 3600)) throw new Error(`timeoutSeconds must be 1–${MAX_CHECK_SECONDS}`);
		if (definition.kind === "static-check" && definition.parser !== "exit-code") throw new Error("Static checks use the exit-code parser");
		if (definition.baseline !== void 0 && (definition.baseline !== "no-new-failures" || definition.kind !== "test" || !BASELINE_PARSERS.includes(definition.parser))) throw new Error(`Acceptance check ${definition.id}: baseline "no-new-failures" needs a test check with a parser that names failing tests (${BASELINE_PARSERS.join(", ")})`);
		for (const path of definition.definitionPaths) if (!lstatSync(workspacePath(root, path), { throwIfNoEntry: false })?.isFile()) throw new Error(`Acceptance check ${definition.id}: definitionPaths must name existing regular files whose bytes stay unchanged; ${JSON.stringify(path)} is not one. Keep existing acceptance files here; new regression tests belong in allowedPaths and can still run through the acceptance command. Retry fusion_delegate with corrected definitionPaths; do not create placeholders or finish the task to release a lease.`);
		return {
			definition: structuredClone(definition),
			plan: {
				id: `check:${order.id}:${definition.id}`,
				version: 2,
				taskId: order.taskId,
				workOrderId: order.id,
				revision: order.revision,
				criterionId: definition.id,
				kind: definition.kind,
				snapshot: order.baseSnapshot,
				snapshotBinding: "candidate",
				cwdDigest: digestOf(root),
				argvDigest: digestOf(definition.command),
				definitionDigest: definitionDigest(root, definition),
				policyDigest: digestOf(order.policy),
				...definition.kind === "test" ? { minExecutedTests: 1 } : {}
			}
		};
	});
}
/**
* Counts passed tests from a runner's summary. A suite passes when nothing failed or errored and at
* least one test ran; skipped, deselected, pending, ignored and expected-failure tests were not
* executed and do not veto the result (real projects routinely skip optional-dependency tests; study
* 2026-09-26: "799 passed, 86 skipped" blocked an otherwise verified acceptance).
*/
function parseTestCounts(parser, text) {
	const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
	let count;
	if (parser === "unittest") {
		const ok = [...clean.matchAll(/(?:^|\n)OK(?: \(([^)\n]*)\))?\s*(?:\n|$)/g)].at(-1);
		if (ok && !/unexpected successes=/.test(ok[1] ?? "")) count = Number([...clean.matchAll(/Ran (\d+) tests? in /g)].at(-1)?.[1]) - Number(ok[1]?.match(/skipped=(\d+)/)?.[1] ?? 0) || void 0;
	} else if (parser === "pytest") {
		const summary = [...clean.matchAll(/(?:^|\n)[=\s]*((?:\d+ \w+(?:, )?)+) in [\d.]+s/g)].at(-1)?.[1] ?? "";
		if (!/\b\d+ (?:failed|errors?)\b/.test(summary)) count = Number(summary.match(/\b(\d+) passed\b/)?.[1]);
	} else if (parser === "vitest") {
		const last = [...clean.matchAll(/(?:^|\n)\s*Tests\s+([^\n]*?)\s*\((\d+)\)/g)].at(-1);
		if (last && !/\bfailed\b/.test(last[1])) count = Number(last[1].match(/(\d+) passed/)?.[1]);
	} else if (parser === "jest") {
		const last = [...clean.matchAll(/(?:^|\n)\s*Tests:\s+([^\n]*)/g)].at(-1)?.[1];
		if (last && !/\bfailed\b/.test(last)) count = Number(last.match(/(\d+) passed/)?.[1]);
	} else if (parser === "mocha" && !/\b\d+ failing\b/.test(clean)) count = Number([...clean.matchAll(/(?:^|\n)\s*(\d+) passing\b/g)].at(-1)?.[1]);
	else if (parser === "go" && !/(?:^|\n)\s*--- FAIL:|(?:^|\n)FAIL\b/.test(clean)) {
		const passed = [...clean.matchAll(/(?:^|\n)\s*--- PASS: /g)].length;
		if (passed) count = passed;
	} else if (parser === "cargo") {
		const results = [...clean.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed;/g)];
		if (results.length && results.every((match) => match[1] === "ok" && match[3] === "0")) count = results.reduce((sum, match) => sum + Number(match[2]), 0);
	} else if (parser === "tap" && !/(?:^|\n)not ok\b(?![^\n]*#\s*SKIP)/i.test(clean)) {
		const plan = [...clean.matchAll(/(?:^|\n)1\.\.(\d+)\s*(?:\n|$)/g)].at(-1);
		const ok = [...clean.matchAll(/(?:^|\n)ok\s+\d+\b(?![^\n]*#\s*SKIP)/gi)].length;
		const skipped = [...clean.matchAll(/(?:^|\n)(?:not )?ok\s+\d+\b[^\n]*#\s*SKIP/gi)].length;
		if (plan && Number(plan[1]) === ok + skipped) count = ok;
	}
	return count && Number.isSafeInteger(count) && count > 0 ? {
		executed: count,
		passed: count,
		failed: 0
	} : void 0;
}
/**
* Passed count and the ids of failing tests, only when the output names every failure the summary counts.
* pytest prints `FAILED <id>` / `ERROR <id>` in its short summary by default (`-r fE`).
*/
function parseTestFailures(parser, text) {
	const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
	if (parser !== "pytest") return void 0;
	const summary = [...clean.matchAll(/(?:^|\n)[=\s]*((?:\d+ \w+(?:, )?)+) in [\d.]+s/g)].at(-1)?.[1];
	if (!summary) return void 0;
	const count = (word) => Number(summary.match(word)?.[1] ?? 0);
	const failed = count(/\b(\d+) failed\b/) + count(/\b(\d+) errors?\b/);
	const ids = [...new Set([...clean.matchAll(/(?:^|\n)(?:FAILED|ERROR) (\S+)/g)].map((match) => match[1]))].sort();
	if (ids.length !== failed) return void 0;
	return {
		passed: count(/\b(\d+) passed\b/),
		failedIds: ids
	};
}
function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
const execFileAsync = promisify(execFile);
const WRAPPERS = new Set([
	"env",
	"exec",
	"time",
	"nohup",
	"command",
	"nice"
]);
const WRAPPER_VALUE_OPTIONS = {
	env: [
		"-u",
		"--unset",
		"-C",
		"--chdir",
		"-S",
		"--split-string"
	],
	nice: ["-n", "--adjustment"],
	time: [
		"-f",
		"--format",
		"-o",
		"--output"
	]
};
const PWSH_KEYWORDS = new Set([
	"exit",
	"return",
	"throw",
	"break",
	"continue",
	"if",
	"else",
	"elseif",
	"switch",
	"for",
	"foreach",
	"while",
	"do",
	"until",
	"try",
	"catch",
	"finally",
	"trap",
	"function",
	"filter",
	"param",
	"begin",
	"process",
	"end",
	"dynamicparam",
	"class",
	"enum",
	"data",
	"using"
]);
/**
* Bare program names each simple command segment starts with. Paths are left
* out because an earlier `cd` in the same command changes where they resolve;
* anything this cannot parse is simply not probed.
*/
function checkPrograms(command, platform = process.platform) {
	const programs = /* @__PURE__ */ new Set();
	const unquoted = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " QUOTED ").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " QUOTED ");
	if (/(^|[\s;&|(])(export\s+)?PATH=/.test(unquoted)) return [];
	for (const segment of unquoted.split(/&&|\|\||[;|\n&()]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		let index = 0, wrapper;
		while (index < words.length) {
			const word = words[index];
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index++;
			else if (WRAPPERS.has(word)) {
				wrapper = word;
				index++;
			} else if (wrapper && word.startsWith("-")) index += WRAPPER_VALUE_OPTIONS[wrapper]?.includes(word) ? 2 : 1;
			else break;
		}
		const word = words[index];
		if (word && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(word) && /[A-Za-z]/.test(word) && !/^[0-9a-f]{16,}$/i.test(word) && !(platform === "win32" && PWSH_KEYWORDS.has(word.toLowerCase()))) programs.add(word);
	}
	return [...programs];
}
/**
* Resolves program names the way the native bash tool will: `bash -c` with the
* Host's own PATH (its subprocess scrub removes only credential-shaped and
* DSH_* names). Running here instead of through the tool keeps this read-only
* probe out of the user's approval flow. Returns undefined when inconclusive,
* for example without bash; the recorded check result is then the fallback.
*/
async function probeMissingPrograms(root, programs) {
	const variants = (name) => [`${name}3`, ...name === "python" || name === "python3" ? ["py"] : []].filter((item) => item !== name);
	const names = [...new Set(programs.flatMap((name) => [name, ...variants(name)]))];
	const script = process.platform === "win32" ? `foreach ($p in @(${names.map((name) => `'${name}'`).join(",")})) { if (Get-Command $p -ErrorAction SilentlyContinue) { Write-Output "FOUND $p" } }; Write-Output 'PROBE-DONE'` : `for p in ${names.map((name) => `'${name}'`).join(" ")}; do command -v -- "$p" >/dev/null 2>&1 && printf 'FOUND %s\\n' "$p"; done; printf 'PROBE-DONE\\n'`;
	const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== void 0 && !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && !key.toUpperCase().startsWith("DSH_")));
	const [shell, args] = process.platform === "win32" ? ["pwsh", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script
	]] : ["bash", ["-c", script]];
	let text;
	try {
		text = (await execFileAsync(shell, args, {
			cwd: root,
			env,
			timeout: process.platform === "win32" ? 15e3 : 5e3
		})).stdout;
	} catch {
		return;
	}
	if (!text.includes("PROBE-DONE")) return void 0;
	const found = new Set([...text.matchAll(/^FOUND (\S+)$/gm)].map((match) => match[1]));
	const missing = programs.filter((name) => !found.has(name));
	return {
		missing,
		alternatives: Object.fromEntries(missing.map((name) => [name, variants(name).filter((item) => found.has(item))])),
		locations: Object.fromEntries(missing.map((name) => [name, programLocations(name)]))
	};
}
/**
* Where a program missing from the Host PATH is installed anyway. A desktop app started from the Dock gets only
* the system PATH, so Homebrew, version-manager and per-user tools are invisible to bash there; naming the
* absolute path lets the Lead retry once instead of searching.
*/
function programLocations(name, home = homedir()) {
	const windows = process.platform === "win32";
	const dirs = windows ? [
		join(home, ".bun/bin"),
		join(home, ".deno/bin"),
		join(home, ".cargo/bin"),
		join(home, "scoop/shims"),
		join(home, "AppData/Roaming/npm"),
		join(home, "AppData/Local/Programs"),
		join(home, "AppData/Local/Microsoft/WinGet/Links")
	] : [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".local/bin"),
		join(home, ".cargo/bin"),
		join(home, ".bun/bin"),
		join(home, ".deno/bin"),
		join(home, ".volta/bin"),
		join(home, ".local/share/mise/shims"),
		join(home, ".asdf/shims")
	];
	try {
		const nvm = join(home, ".nvm/versions/node");
		dirs.push(...readdirSync(nvm).sort((a, b) => b.localeCompare(a, void 0, { numeric: true })).map((version) => join(nvm, version, "bin")));
	} catch {}
	const candidates = windows ? (name.includes(".") ? [name] : []).concat((process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").map((ext) => `${name}${ext.toLowerCase()}`)) : [name];
	return dirs.flatMap((dir) => candidates.map((file) => join(dir, file))).filter((path) => {
		try {
			accessSync(path, windows ? constants.F_OK : constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}).slice(0, 3);
}
/** One frozen command through the native bash tool, recorded as invocation evidence. */
async function invokeCheck(input, check) {
	const { ctx, store, exec, root, order } = input;
	if (definitionDigest(root, check.definition) !== check.plan.definitionDigest) throw new Error(`Frozen acceptance definition changed: ${check.definition.id}`);
	const before = snapshotWorkspace(root);
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	const callId = ToolCallId(`fusion-check-${randomUUID()}`);
	const operationId = OperationId(callId);
	const empty = store.putArtifact(order.taskId, Buffer.from(""), "text/plain");
	const started = {
		schemaVersion: 1,
		taskId: order.taskId,
		operationId,
		actor: SessionId(exec.agent.id),
		nativeToolCallId: callId,
		argvDigest: check.plan.argvDigest,
		cwdDigest: check.plan.cwdDigest,
		inputSnapshot: before.id,
		exitCode: null,
		startedAt,
		endedAt: null,
		stdout: empty,
		stderr: empty,
		state: "started"
	};
	const key = `check-invocation:${order.taskId}:${callId}`;
	store.writeDocument(key, 0, {
		check,
		evidence: started
	});
	const remove = input.authorizeNested(callId);
	let result;
	try {
		result = await ctx.tools.execute({
			callId,
			rootCallId: exec.rootCallId,
			parent: exec.token,
			name: nativeShellTool,
			arguments: {
				command: check.definition.command,
				description: check.definition.description,
				workdir: root,
				...input.nativeTimeout && check.definition.timeoutSeconds === void 0 ? {} : { timeoutMs: (check.definition.timeoutSeconds ?? order.policy.commandMaxSeconds) * 1e3 },
				run_in_background: false
			},
			agent: exec.agent,
			signal: exec.signal
		});
	} catch (error) {
		const evidence = {
			...started,
			state: "outcome-unknown",
			endedAt: (/* @__PURE__ */ new Date()).toISOString(),
			stderr: store.putArtifact(order.taskId, Buffer.from(String(error)), "text/plain")
		};
		store.writeDocument(key, 1, {
			check,
			evidence
		});
		input.uncertain?.(evidence);
		throw error;
	} finally {
		remove();
	}
	for (const context of result.additionalContexts ?? []) exec.deferContext(context);
	const raw = record(result.value);
	const stdout = record(raw?.stdout), stderr = record(raw?.stderr);
	const completed = !result.isError && raw?.kind === "foreground" && raw.aborted === false && raw.timedOut === false && raw.signal === null && typeof raw.exitCode === "number";
	const outText = typeof stdout?.text === "string" ? stdout.text : "";
	const errText = typeof stderr?.text === "string" ? stderr.text : JSON.stringify(result.content);
	const after = snapshotWorkspace(root);
	return {
		key,
		evidence: {
			...started,
			outputSnapshot: after.id,
			exitCode: completed ? Number(raw.exitCode) : null,
			endedAt: (/* @__PURE__ */ new Date()).toISOString(),
			stdout: store.putArtifact(order.taskId, Buffer.from(outText), "text/plain"),
			stderr: store.putArtifact(order.taskId, Buffer.from(errText), "text/plain"),
			state: completed ? "completed" : exec.signal.aborted ? "cancelled" : "outcome-unknown"
		},
		text: `${outText}\n${errText}`,
		truncated: Boolean(stdout?.truncated || stderr?.truncated),
		before,
		after
	};
}
/** Counts for a receipt; a baseline-relative check discounts failures frozen from the untouched workspace. */
function receiptCounts(check, text) {
	const allowed = check.plan.allowedFailures;
	if (!allowed) return parseTestCounts(check.definition.parser, text);
	const parsed = parseTestFailures(check.definition.parser, text);
	if (!parsed) return void 0;
	const known = parsed.failedIds.filter((id) => allowed.includes(id));
	const fresh = parsed.failedIds.filter((id) => !allowed.includes(id));
	return {
		executed: parsed.passed + fresh.length,
		passed: parsed.passed,
		failed: fresh.length,
		...known.length ? { knownFailures: known } : {},
		...fresh.length ? { newFailures: fresh } : {}
	};
}
/**
* Runs every baseline-relative check on the untouched workspace before the Worker starts and freezes the
* failing test ids into its plan. An unreadable baseline refuses the delegation: guessing would let a
* candidate hide new failures.
*/
async function runBaselineChecks(input) {
	const out = [];
	for (const check of input.checks) {
		if (check.definition.baseline !== "no-new-failures") {
			out.push(check);
			continue;
		}
		input.exec.signal.throwIfAborted();
		const run = await invokeCheck(input, check);
		input.store.writeDocument(run.key, 1, {
			check,
			evidence: run.evidence,
			baseline: true
		});
		if (run.evidence.state === "outcome-unknown") {
			input.uncertain?.(run.evidence);
			throw new Error("Baseline command outcome is unknown; inspect the recorded effects before delegating");
		}
		if (run.before.id !== run.after.id) throw new Error(`Baseline run of ${check.definition.id} changed the source snapshot; use a command that does not write source files`);
		const parsed = run.evidence.state === "completed" && !run.truncated ? parseTestFailures(check.definition.parser, run.text) : void 0;
		if (!parsed) throw new Error(`Baseline run of ${check.definition.id} could not be read (exit ${run.evidence.exitCode}, state ${run.evidence.state}). It needs a completed pytest run whose summary counts match the listed FAILED/ERROR ids. Retry fusion_delegate with a runnable command, or drop baseline to require every test to pass. Output tail: ${run.text.slice(-600)}`);
		out.push({
			definition: check.definition,
			plan: {
				...check.plan,
				allowedFailures: parsed.failedIds
			}
		});
	}
	return out;
}
async function runNativeChecks(input) {
	const { store, exec, root, order, checks } = input;
	if (order.mode === "text" && checks.length) throw new Error("Text assignments cannot run workspace checks");
	const receipts = [];
	for (const check of checks) {
		exec.signal.throwIfAborted();
		const run = await invokeCheck(input, check);
		const counts = run.truncated ? void 0 : receiptCounts(check, run.text);
		const receipt = {
			id: `receipt:${run.evidence.nativeToolCallId}`,
			planDigest: digestOf(check.plan),
			evidence: run.evidence,
			...counts ? { counts } : {}
		};
		store.writeDocument(run.key, 1, {
			check,
			evidence: run.evidence,
			receipt
		});
		if (run.evidence.state === "outcome-unknown") {
			input.uncertain?.(run.evidence);
			throw new Error("Acceptance command outcome is unknown; inspect the recorded effects before continuing");
		}
		receipts.push(receipt);
		if (run.before.id !== run.after.id) throw new Error("Acceptance command changed the source snapshot; rework is required");
	}
	const report = {
		...input.report,
		verification: receipts.flatMap((receipt) => [receipt.evidence.stdout, receipt.evidence.stderr]),
		coverage: checks.map((check, index) => {
			const receipt = receipts[index];
			let state = "satisfied";
			let explanation = "The frozen acceptance check passed on this exact candidate.";
			try {
				assertPlannedCheck(order, check.definition.id, check.plan, receipt, input.report.snapshot);
			} catch (error) {
				state = receipt.evidence.state === "completed" && receipt.evidence.exitCode !== 0 ? "not-satisfied" : "not-verified";
				explanation = `Native check does not prove this criterion: ${String(error)}`;
			}
			return {
				criterionId: check.definition.id,
				state,
				evidenceIds: [ArtifactId(receipt.id)],
				explanation
			};
		})
	};
	const registry = memoryVerificationRegistry(checks.map((check) => check.plan), receipts);
	if (order.mode === "text" && checks.length) throw new Error("Text work cannot run filesystem checks");
	return {
		report,
		receipts,
		verdict: evaluateReport(order, report, [], order.mode === "text" ? report.snapshot : snapshotWorkspace(root).id, { registry })
	};
}
//#endregion
//#region src/host/native-review.ts
/** Capture before the Lead request starts; later tool callbacks cannot bind to a newer report. */
function captureNativeReviewRequest(store, agent, turn, step, ticket) {
	const id = `review-request:${agent.id}:${turn}:${step}`;
	const prior = store.readDocument(id);
	const next = {
		schemaVersion: 1,
		sessionId: agent.id,
		turn,
		step,
		ticket: captureTicket(ticket)
	};
	if (prior) {
		if (digestOf(prior.value) !== digestOf(next)) throw new Error("Native review request was already bound to another ticket");
		return;
	}
	store.writeDocument(id, 0, next);
}
function nativeReviewProof(store, taskId, exec) {
	const agent = exec.agent;
	if (!agent || exec.signal.aborted) throw new Error("Review requires a live, uncancelled Lead tool execution");
	const message = agent.session.snapshotEvents().findLast((event) => event.type === "assistant/message" && event.data.message.content.some((block) => block.type === "tool-call" && block.id === exec.rootCallId));
	if (!message || message.type !== "assistant/message" || message.data.interrupted) throw new Error("Review has no complete native assistant message");
	const terminals = message.data.stream.filter((record) => record.type === "chunk" && record.chunk.type === "finish");
	const terminal = terminals.at(-1);
	if (terminals.length !== 1 || terminal?.type !== "chunk" || terminal.chunk.type !== "finish" || !["stop", "tool-calls"].includes(terminal.chunk.reason.kind)) throw new Error("Review assistant stream did not terminate successfully");
	const sourceCall = message.data.message.content.find((block) => block.type === "tool-call" && block.id === exec.rootCallId);
	if (!sourceCall || sourceCall.type !== "tool-call") throw new Error("Native review tool call missing");
	if (!exec.parent && (sourceCall.name !== exec.name || digestOf(JSON.parse(sourceCall.arguments)) !== digestOf(exec.arguments))) throw new Error("Review arguments differ from the native model call");
	if (exec.parent && sourceCall.name !== "run_code") throw new Error("Unsupported nested review transport");
	const row = store.readDocument(`review-request:${agent.id}:${message.data.turn}:${message.data.step}`)?.value;
	if (row?.schemaVersion !== 1 || row.sessionId !== agent.id || row.turn !== message.data.turn || row.step !== message.data.step || row.ticket?.subject.taskId !== taskId) throw new Error("No captured review ticket for this native request");
	const ticket = captureTicket(row.ticket);
	return {
		ticket,
		terminalEvidenceRef: store.putArtifact(taskId, Buffer.from(JSON.stringify({
			schemaVersion: 1,
			sessionId: agent.id,
			eventSeq: message.seq,
			nativeRootCallId: exec.rootCallId,
			nativeCallId: exec.callId,
			arguments: exec.arguments,
			assistantCall: sourceCall,
			terminal,
			ticket
		})), "application/vnd.dsh-fusion.native-review+json").id,
		finishReason: terminal.chunk.reason.kind === "tool-calls" ? "tool_calls" : "stop"
	};
}
//#endregion
//#region src/context/guard.ts
function safetyTokens(contextWindow, policy, quality) {
	const fromFraction = Math.ceil(contextWindow * policy.safetyFraction);
	const base = Math.max(policy.minSafetyTokens, fromFraction);
	if (quality === "heuristic") return Math.max(base, Math.ceil(base * 1.25));
	return base;
}
/** Output reservation that fits the disclosed window. Leaves half the usable window for input. */
function fittedOutputReservation(contextWindow) {
	if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) throw new Error("The configured model does not disclose a usable context window");
	const usable = contextWindow - Math.max(2048, Math.ceil(contextWindow * .05));
	if (usable < 2) throw new Error("The configured model context window cannot reserve output");
	return Math.floor(usable / 2);
}
function requestOutputReservation(contextWindow, requested, adapterDefault, testedCap, fallback = 8e3) {
	const fitted = fittedOutputReservation(contextWindow);
	for (const limit of [
		requested,
		adapterDefault,
		testedCap,
		fallback
	]) if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid model output token limit");
	return Math.min(requested ?? adapterDefault ?? testedCap ?? fallback, adapterDefault ?? Infinity, testedCap ?? Infinity, fitted);
}
function inputBudget(policy, contextWindow, maxOutput, quality = "exact") {
	const safety = safetyTokens(contextWindow, policy, quality);
	const hard = contextWindow - maxOutput - safety;
	return Math.max(0, Math.min(policy.targetInputTokens, hard));
}
function measureRequest(parts, policy) {
	return {
		inputTokens: parts.systemTokens + parts.messageTokens + parts.toolSchemaTokens + parts.cacheReadTokens,
		reservedOutputTokens: parts.reservedOutputTokens,
		contextWindow: parts.contextWindow,
		safetyTokens: safetyTokens(parts.contextWindow, policy, parts.quality),
		quality: parts.quality,
		requestDigest: digestOf(parts)
	};
}
function assertFinalBudget(measurement, policy) {
	const budget = inputBudget(policy, measurement.contextWindow, measurement.reservedOutputTokens, measurement.quality);
	if (measurement.inputTokens > budget) throw new FusionError(FUSION_CONTEXT_BUDGET, `final request ${measurement.inputTokens} exceeds budget ${budget} (${measurement.quality})`);
}
function boundedOverflowRecovery(attempts) {
	if (attempts.length > 2) return "needs-decision";
	if (attempts.length === 2 && attempts[1].projectionTokens >= attempts[0].projectionTokens) return "needs-decision";
	return "continue";
}
//#endregion
//#region src/host/native-scopes.ts
/** Physical routing, prompt and tools live in the exact native Agent scope. */
var NativeFusionScopes = class {
	callbacks;
	#entries = /* @__PURE__ */ new Map();
	constructor(callbacks) {
		this.callbacks = callbacks;
	}
	get(agent) {
		const entry = this.#entries.get(agent.id);
		return entry?.agent === agent ? {
			binding: entry.binding,
			role: entry.role
		} : void 0;
	}
	assertReady(agent) {
		const entry = this.#entries.get(agent.id);
		if (!entry || entry.agent !== agent || !entry.ready) throw new Error("Fusion Agent scope is not ready; execution is blocked");
		const reason = (this.callbacks.canAccess ?? this.callbacks.canRequest)(agent, entry.binding, entry.role);
		if (reason) throw new Error(reason);
	}
	install(agent, binding, role) {
		const old = this.#entries.get(agent.id);
		if (old) {
			if (old.agent === agent && old.binding.taskId === binding.taskId && old.role === role && old.ready) return;
			if (old.agent !== agent && old.agent.status === "idle") this.detach(old.agent);
			else throw new Error("An existing Fusion scope must settle and detach before replacement");
		}
		const entry = {
			agent,
			binding: structuredClone(binding),
			role,
			dispose: [],
			ready: false,
			refreshTools: () => {}
		};
		this.#entries.set(agent.id, entry);
		const policy = entry.binding.profile.context[role];
		const scope = agent.ctx;
		let readOnlyTools;
		let presentationKey;
		const stageDisposers = [];
		const clearStage = () => {
			for (const dispose of stageDisposers.splice(0).reverse()) dispose();
		};
		entry.dispose.push(clearStage);
		entry.refreshTools = () => {
			const tools = this.callbacks.readOnlyTools?.(agent, entry.binding, role);
			const key = JSON.stringify(tools ?? null);
			if (key === presentationKey) return;
			clearStage();
			readOnlyTools = tools;
			if (tools !== void 0) {
				if (role === "worker") stageDisposers.push(scope.tools.restrict({ allow: tools }));
				stageDisposers.push(scope.tools.presentAs("native"));
			}
			presentationKey = key;
		};
		entry.dispose.push(scope.tools.guard((exec) => {
			if (!entry.ready) return "Fusion scope initialization failed";
			return this.callbacks.canExecute(exec, entry.binding, role);
		}));
		entry.dispose.push(scope.on("session/event", (session, event) => {
			if (session !== agent.session || event.type !== "turn/start" || !entry.ready || !this.callbacks.beforeTurn) return;
			try {
				const nextBinding = this.callbacks.beforeTurn(agent, entry.binding, role, event.data.turn);
				if (nextBinding.sessionId !== entry.binding.sessionId || digestOf(nextBinding.profile) !== digestOf(entry.binding.profile) || digestOf(nextBinding.prompts) !== digestOf(entry.binding.prompts)) throw new Error("Task rollover must preserve the frozen route and prompts");
				entry.binding = structuredClone(nextBinding);
				entry.refreshTools();
			} catch (error) {
				entry.ready = false;
				throw error;
			}
		}));
		entry.dispose.push(scope.on("agent/pre-step", async (payload, next) => {
			if (payload.agent !== agent || !entry.ready || this.callbacks.canRequest(agent, entry.binding, role)) return { kind: "reject" };
			this.callbacks.beforeStep?.(agent, entry.binding, role);
			const decision = await next();
			if (decision.kind === "reject") return decision;
			const taskContext = this.callbacks.taskContext?.(agent, entry.binding, role);
			return {
				...decision,
				messages: [...decision.messages.filter((message) => !(message.source?.kind === "model-selection" && message.source.form === "notice" && message.source.summary.endsWith("dsh-model-fusion/auto"))).map((message) => this.callbacks.projectMessage?.(agent, entry.binding, role, message) ?? message), ...taskContext ? [taskContext] : []]
			};
		}, { prepend: true }));
		entry.dispose.push(scope.systemPrompt.section({
			name: "fusion-role",
			order: 90,
			text: entry.binding.prompts[role]
		}));
		entry.dispose.push(scope.on("system-prompt/assemble", async (_assembly, _context, next) => {
			entry.refreshTools();
			const assembled = await next();
			const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role];
			return {
				...assembled,
				variables: {
					...assembled.variables,
					provider: route.provider,
					model: route.model
				},
				...readOnlyTools === void 0 ? {} : { tools: assembled.tools.filter((tool) => readOnlyTools?.includes(tool.name) || role === "worker" && [
					"fusion_read_state",
					"fusion_read_evidence",
					"fusion_submit_result"
				].includes(tool.name)) }
			};
		}, { prepend: true }));
		entry.dispose.push(scope.on("agent/request", async ({ agent: requesting, turn, step }, next) => {
			this.assertReady(requesting);
			const reason = this.callbacks.canRequest(requesting, entry.binding, role);
			if (reason) throw new Error(reason);
			const config = await next();
			const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role];
			this.callbacks.beforeRequest(agent, turn, step, entry.binding, role);
			const { reasoningEffort: _prior, ...rest } = config;
			if (entry.binding.profile.interactionMode === "model-like") {
				const { maxTokens, ...native } = rest;
				return {
					...native,
					...role === "lead" && maxTokens !== void 0 ? { maxTokens } : {},
					provider: route.provider,
					model: route.model,
					...route.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }
				};
			}
			const disclosed = this.callbacks.modelLimits ? await this.callbacks.modelLimits(route.provider, route.model) : void 0;
			const requested = role === "lead" ? config.maxTokens : void 0;
			const maxTokens = disclosed ? requestOutputReservation(disclosed.contextWindow, requested, disclosed.defaultMaxTokens, disclosed.testedOutputCap, policy.reserveOutputTokens) : Math.min(requested ?? policy.reserveOutputTokens, policy.reserveOutputTokens);
			return {
				...rest,
				provider: route.provider,
				model: route.model,
				maxTokens,
				...route.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }
			};
		}, { prepend: true }));
		entry.refreshTools();
		entry.dispose.push(...this.callbacks.installTools(scope, agent, entry.binding, role));
		entry.ready = true;
	}
	/** Refresh at the persisted state transition, before native prompt providers run. */
	refreshTools(agent) {
		const entry = this.#entries.get(agent.id);
		if (entry?.agent !== agent || !entry.ready) return;
		try {
			entry.refreshTools();
		} catch (error) {
			entry.ready = false;
			throw error;
		}
	}
	/**
	* Caller owns quiescence and the original session-controller model selection.
	* Removing these listeners reveals that existing selection; it does not mutate
	* a request header or fabricate a replacement global default.
	*/
	detach(agent) {
		const entry = this.#entries.get(agent.id);
		if (!entry || entry.agent !== agent) return;
		if (agent.status !== "idle") throw new Error("Cannot detach Fusion while the native Agent is running");
		entry.ready = false;
		for (const dispose of entry.dispose.reverse()) dispose();
		this.#entries.delete(agent.id);
	}
};
//#endregion
//#region src/host/native-request.ts
/** Auxiliary native calls may carry a session without an active Agent turn. */
function nativeRequestAgent(ctx, request) {
	const initiator = ctx.agents.currentInitiator();
	return (request.sessionId === void 0 ? void 0 : ctx.agents.get(request.sessionId)) ?? initiator;
}
//#endregion
//#region src/context/handoff.ts
/**
* Upper bound on recent conversation text carried into a Sidekick brief after compaction: about 10k tokens,
* enough for the latest exchanges while leaving most of the Sidekick's context for the task itself.
*/
const HANDOFF_CONTENT_BYTES = 4e4;
/** Content bytes only: envelopes and independently retained task facts are extra. */
function recentHandoffSuffix(records) {
	const lengths = records.map((record) => Buffer.byteLength(record.content, "utf8"));
	let first = records.length, remaining = HANDOFF_CONTENT_BYTES;
	for (let index = records.length - 1; index >= 0; index--) {
		const bytes = lengths[index];
		if (index !== records.length - 1 && bytes > remaining) break;
		first = index;
		remaining = Math.max(0, remaining - bytes);
	}
	return {
		policy: "recent-whole-records-utf8-v1",
		contentByteBudget: HANDOFF_CONTENT_BYTES,
		totalRecords: records.length,
		omittedRecords: first,
		totalContentBytes: lengths.reduce((sum, bytes) => sum + bytes, 0),
		retainedContentBytes: lengths.slice(first).reduce((sum, bytes) => sum + bytes, 0),
		records: records.slice(first)
	};
}
//#endregion
//#region src/host/native-worker-brief.ts
/** Durable Lead-authored refinements survive native compaction and request races. */
function workerBriefs(store, taskId) {
	const revision = (store.readDocument(`runtime:${taskId}`)?.value)?.briefRevision ?? 0;
	if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Worker brief revision requires reconciliation");
	const rows = store.listDocumentIds(`worker-delivery:${taskId}:`).flatMap((id) => {
		const row = store.readDocument(id).value;
		if (row.workOrderId && row.workOrderId !== store.load(taskId)?.currentWorkOrder?.id) return [];
		if (row.state === "not-applied-after-interruption") return [];
		if (row.briefRevision > revision) return [];
		if (row.schemaVersion !== 1 || row.taskId !== taskId || !Number.isSafeInteger(row.briefRevision) || row.briefRevision < 1 || !row.payloadRef || !row.causeId) throw new Error("Worker brief journal requires reconciliation");
		return [{
			revision: row.briefRevision,
			deliveryId: id,
			source: "lead-tool-feedback",
			nativeCallId: row.causeId,
			payloadRef: row.payloadRef,
			feedback: Buffer.from(store.readArtifact(taskId, row.payloadRef)).toString("utf8")
		}];
	}).sort((left, right) => left.revision - right.revision);
	if (rows.length !== revision || rows.some((row, index) => row.revision !== index + 1)) throw new Error("Worker brief history is missing or conflicting");
	return rows;
}
/**
* Pin a bounded projection, including the first handoff, on both native roles.
* The complete owned outbox, journal and artifact bytes remain durable. Original
* user input and the frozen work order are retained separately by NativeTaskContext.
*/
function workerHandoffProjection(store, taskId) {
	const state = store.load(taskId);
	if (!state) throw new Error("Worker handoff task is missing");
	const records = [];
	const order = state.currentWorkOrder;
	if (order) {
		const rows = store.outbox(taskId).filter((row) => row.kind === "native-worker" && row.operationId === order.operationId);
		const row = rows[0], childId = state.acceptedChild ?? state.reservedChild;
		if (rows.length !== 1 || !row || row.taskId !== taskId || !childId || row.reservedChild !== childId || !row.payloadRef) throw new Error("Initial Worker handoff requires reconciliation");
		records.push({
			revision: 0,
			source: "lead-tool-handoff",
			sourceId: row.operationId,
			payloadRef: row.payloadRef,
			content: Buffer.from(store.readArtifact(taskId, row.payloadRef)).toString("utf8")
		});
	}
	const briefs = workerBriefs(store, taskId);
	for (const brief of briefs) records.push({
		revision: brief.revision,
		source: brief.source,
		sourceId: brief.deliveryId,
		payloadRef: brief.payloadRef,
		content: brief.feedback
	});
	return {
		schemaVersion: 1,
		...recentHandoffSuffix(records),
		latestBriefRevision: briefs.at(-1)?.revision ?? 0,
		historyDigest: digestOf(records)
	};
}
/** Brief bodies already arrive as native messages; the snapshot pins only their identity and digests. */
function compactHandoffs(projection) {
	const { records, ...rest } = projection;
	return {
		...rest,
		records: records.map(({ content, ...record }) => ({
			...record,
			contentDigest: digestOf(content)
		}))
	};
}
function assertWorkerBriefRequest(store, taskId, request) {
	if (!isAgentLoopRequest(request) || request.purpose !== void 0) return;
	const expected = workerHandoffProjection(store, taskId);
	if (!expected.totalRecords) return;
	if (!request.messages.some((message) => message.source?.kind === "plugin:dsh-model-fusion" && message.source.form === "snapshot" && message.source.sections.some((section) => {
		if (section.name !== "fusion:task") return false;
		try {
			const seen = digestOf(JSON.parse(section.text.slice(section.text.indexOf("\n") + 1)).facts.workerHandoffs);
			return seen === digestOf(expected) || seen === digestOf(compactHandoffs(expected));
		} catch {
			return false;
		}
	}))) throw new Error("Worker request predates the latest Lead brief; do not dispatch a stale generation");
}
/** Bind model-generated tools to the brief that their exact native request saw. */
function captureWorkerBrief(store, taskId, agent, turn, step, revision) {
	const id = `worker-request:${agent.id}:${turn}:${step}`;
	const value = {
		schemaVersion: 1,
		taskId,
		sessionId: agent.id,
		turn,
		step,
		briefRevision: revision,
		workOrderId: store.load(taskId)?.currentWorkOrder?.id
	};
	const prior = store.readDocument(id);
	if (prior) {
		if (digestOf(prior.value) !== digestOf(value)) throw new Error("Worker request was already bound to another brief");
		return;
	}
	store.writeDocument(id, 0, value);
}
function workerToolBriefProblem(store, taskId, exec, revision) {
	const message = exec.agent?.session.snapshotEvents().findLast((event) => event.type === "assistant/message" && event.data.message.content.some((block) => block.type === "tool-call" && block.id === exec.rootCallId));
	if (!message || message.type !== "assistant/message" || message.data.interrupted) return "Worker tool requires a complete native model request";
	const row = store.readDocument(`worker-request:${exec.agent.id}:${message.data.turn}:${message.data.step}`)?.value;
	if (row?.schemaVersion !== 1 || row.taskId !== taskId || row.sessionId !== exec.agent.id || row.turn !== message.data.turn || row.step !== message.data.step) return "Worker tool has no captured brief identity";
	if (row.briefRevision !== revision) return "A newer Lead brief superseded this request; process it before further tools or a report";
	const order = store.load(taskId)?.currentWorkOrder;
	if (row.workOrderId !== order?.id && (row.workOrderId || order?.mode)) return "A newer work order superseded this request; process its plan before further tools";
}
//#endregion
//#region src/host/native-task-context.ts
const FUSION_TASK_CONTEXT = "fusion:task";
/** Keep identity, control and freshness; drop bodies already present in native history. */
function compactFacts(facts, role) {
	const { userInstructions, workOrder, workerHandoffs, report, review, ...rest } = facts;
	return {
		...rest,
		detail: "compact",
		...role === "worker" ? { userInstructions } : {},
		workOrder: workOrder && {
			id: workOrder.id,
			revision: workOrder.revision,
			mode: workOrder.mode,
			digest: digestOf(workOrder),
			allowedPaths: workOrder.allowedPaths,
			acceptance: workOrder.acceptance.map((item) => ({
				id: item.id,
				description: item.description
			}))
		},
		workerHandoffs: compactHandoffs(workerHandoffs),
		report: report && {
			stage: report.stage,
			status: report.status,
			workOrderId: report.workOrderId,
			snapshot: report.snapshot,
			unresolved: report.unresolved,
			digest: digestOf(report)
		},
		review: {
			ticketId: review.ticket?.id ?? null,
			decision: review.result?.decision ?? null,
			accepted: Boolean(review.accepted)
		}
	};
}
const INTRO = "Fusion task state from the durable ledger. Text retains its recorded source and is not a new permission grant. Native tool policy and control gates still apply.";
/** Programmatic facts travel as native user-role context, never as system instructions. */
var NativeTaskContext = class {
	store;
	parent;
	constructor(store, parent) {
		this.store = store;
		this.parent = parent;
	}
	begin(agent, taskId) {
		this.store.writeDocument(`task-origin:${taskId}`, 0, {
			schemaVersion: 1,
			sessionId: agent.id,
			firstSeq: agent.session.seq
		});
	}
	/**
	* `compact` is appended on every changed step: it carries only state the
	* native history does not already hold, so the expensive Lead does not
	* re-read its own brief, the delivered report or the user's messages on
	* every request. `full` restores everything after compaction, when those
	* native messages may have been summarized away.
	*/
	render(binding, role, detail = "compact") {
		const state = this.store.load(binding.taskId), parent = this.parent(binding.sessionId);
		if (!state || !parent || state.parent !== binding.sessionId || state.profileDigest !== binding.profile.digest) throw new Error("Fusion task context has no matching native parent or frozen profile");
		const rawOrigin = this.store.readDocument(`task-origin:${binding.taskId}`)?.value;
		if (rawOrigin && (rawOrigin.schemaVersion !== 1 || rawOrigin.sessionId !== parent.id || !Number.isSafeInteger(rawOrigin.firstSeq) || rawOrigin.firstSeq < 0 || rawOrigin.firstSeq > parent.session.seq)) throw new Error("Fusion task input boundary requires reconciliation");
		const firstSeq = rawOrigin?.firstSeq ?? 0;
		const instructions = parent.session.snapshotEvents().flatMap((event) => {
			if (event.seq < firstSeq || event.type !== "user/message" || event.data.source !== void 0 && event.data.source.kind !== "user") return [];
			return [{
				source: {
					sessionId: parent.id,
					eventSeq: event.seq,
					messageId: event.data.id,
					kind: event.data.source?.kind ?? "unspecified-native-user-role"
				},
				text: event.data.content.filter((block) => block.type === "text").map((block) => block.text),
				otherContent: event.data.content.filter((block) => block.type !== "text").map((block) => ({
					type: block.type,
					digest: digestOf(block)
				}))
			}];
		});
		const order = state.currentWorkOrder;
		const report = state.validatedReport ?? state.candidateReport;
		const refs = [
			...order?.evidence ?? [],
			...state.exploration?.sources.map((source) => source.excerpt) ?? [],
			...report ? [report.changeManifest, ...report.verification] : []
		];
		const artifacts = new Map(this.store.artifacts(binding.taskId).map((ref) => [ref.id, ref]));
		for (const ref of refs) {
			const stored = artifacts.get(ref.id);
			if (ref.ownerTaskId !== binding.taskId || !stored || stored.digest !== ref.digest || stored.bytes !== ref.bytes) throw new Error("Fusion task context references missing or foreign evidence");
		}
		const facts = {
			schemaVersion: 1,
			taskId: state.taskId,
			revision: state.revision,
			taskSeq: state.seq,
			role,
			profileDigest: state.profileDigest,
			inputScope: rawOrigin ? "current-task-native-user-messages" : "legacy-all-native-user-messages",
			userInstructions: instructions,
			phase: state.phase,
			intent: state.intent ?? null,
			control: state.control,
			pendingApprovals: state.pendingApprovals,
			writer: state.lease ?? null,
			workOrder: order && binding.profile.interactionMode === "model-like" ? {
				...order,
				policy: {
					mode: "native",
					constraints: "Native permissions, single writer, explicit check timeouts; no task request or rework cap"
				}
			} : order ?? null,
			exploration: state.exploration ?? null,
			workerHandoffs: workerHandoffProjection(this.store, binding.taskId),
			nativeJobs: this.store.listDocumentIds(`native-effect:${binding.taskId}:`).flatMap((id) => {
				const effect = this.store.readDocument(id).value;
				return effect.nativeJob ? [{
					effectId: id,
					agentId: effect.agentId,
					state: effect.state,
					job: effect.nativeJob
				}] : [];
			}),
			report: report ? {
				stage: state.validatedReport ? "validated" : "candidate",
				...report
			} : null,
			review: {
				ticket: state.activeReviewTicket ?? null,
				result: state.reviewResult ?? null,
				accepted: state.acceptedReview ?? null
			},
			verification: state.verification,
			snapshot: state.lastSnapshot ?? report?.snapshot ?? order?.baseSnapshot ?? null
		};
		const projected = detail === "full" ? facts : compactFacts(facts, role);
		const digest = digestOf(projected), id = this.#latest(binding, role);
		const prior = this.store.readDocument(id);
		const saved = prior?.value;
		if (saved && (saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.role !== role)) throw new Error("Fusion task projection requires migration");
		let artifact = saved?.digest === digest ? saved.artifact : void 0;
		if (artifact) this.store.readArtifact(binding.taskId, artifact.id);
		else {
			artifact = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify(projected)), "application/vnd.dsh-fusion.task-context+json");
			this.store.writeDocument(id, prior?.revision ?? 0, {
				schemaVersion: 1,
				taskId: binding.taskId,
				role,
				digest,
				artifact
			});
		}
		return this.#text(projected, digest, artifact);
	}
	/** Run after native pre-step handlers, including the existing compaction owner. */
	message(agent, binding, role, detail) {
		const text = this.render(binding, role, detail ?? this.#detailFor(agent, binding, role));
		if (agent.session.deriveMessages().some((message) => message.source?.kind === "plugin:dsh-model-fusion" && message.source.form === "snapshot" && message.source.sections.some((section) => section.name === "fusion:task" && section.text === text))) return void 0;
		return this.#message(text);
	}
	/** The final frozen request must contain the snapshot that was actually assembled. */
	assertPresent(agent, binding, role, request) {
		if (!isAgentLoopRequest(request) || request.purpose !== void 0) return;
		const saved = this.store.readDocument(this.#latest(binding, role))?.value;
		if (!saved || saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.role !== role) throw new Error("Fusion task context was not assembled");
		const facts = JSON.parse(Buffer.from(this.store.readArtifact(binding.taskId, saved.artifact.id)).toString("utf8"));
		if (digestOf(facts) !== saved.digest) throw new Error("Fusion task projection checksum changed");
		const expected = this.#text(facts, saved.digest, saved.artifact);
		if (!request.messages.some((message) => message.source?.kind === "plugin:dsh-model-fusion" && message.source.form === "snapshot" && message.source.sections.some((section) => section.name === "fusion:task" && section.text === expected) && message.content.some((block) => block.type === "text" && block.text.includes(expected)))) throw new Error(`Fusion task context is absent from the native request for ${agent.id}; execution is blocked`);
	}
	prepareCompaction(agent, binding, role, sourceSurfaceSeqs) {
		this.render(binding, role, "full");
		const saved = this.store.readDocument(this.#latest(binding, role)).value;
		const state = this.store.load(binding.taskId);
		const id = `task-checkpoint:${binding.taskId}:${randomUUID()}`;
		this.store.writeDocument(id, 0, {
			schemaVersion: 1,
			state: "prepared",
			taskId: binding.taskId,
			agentId: agent.id,
			role,
			revision: state.revision,
			profileDigest: binding.profile.digest,
			workOrderDigest: state.currentWorkOrder ? digestOf(state.currentWorkOrder) : null,
			sourceSurfaceSeqs: [...sourceSurfaceSeqs],
			projection: saved
		});
		return id;
	}
	restoreCompaction(agent, binding, role, id, compactionId) {
		const row = this.store.readDocument(id);
		const checkpoint = row?.value;
		const state = this.store.load(binding.taskId);
		if (!row || !checkpoint || !state || checkpoint.schemaVersion !== 1 || checkpoint.state !== "prepared" || checkpoint.agentId !== agent.id || checkpoint.taskId !== binding.taskId || checkpoint.role !== role || checkpoint.revision !== state.revision || checkpoint.profileDigest !== binding.profile.digest || checkpoint.workOrderDigest !== (state.currentWorkOrder ? digestOf(state.currentWorkOrder) : null)) throw new Error("Fusion task changed during compaction; reconcile before retrying");
		const message = this.message(agent, binding, role, "full");
		const priorSnapshot = message && agent.session.surface.nodes.toReversed().find((seq) => {
			const event = agent.session.eventAt(seq);
			if (event?.type !== "user/message") return false;
			const { source, content } = event.data;
			if (source?.kind !== "plugin:dsh-model-fusion" || source.form !== "snapshot" || source.sections.length !== 1 || source.sections[0].name !== "fusion:task" || content.length !== 1 || content[0].type !== "text" || content[0].text !== source.sections[0].text) return false;
			try {
				const facts = JSON.parse(source.sections[0].text.slice(source.sections[0].text.indexOf("\n") + 1)).facts;
				return facts.taskId === binding.taskId && facts.role === role;
			} catch {
				return false;
			}
		});
		const event = message && agent.session.append("user/message", message, priorSnapshot !== void 0 ? {
			surfaceOp: {
				op: "replace",
				startSeq: priorSnapshot,
				endSeq: priorSnapshot
			},
			sourceEventSeqs: [priorSnapshot]
		} : { surfaceOp: "append" });
		this.store.writeDocument(id, row.revision, {
			...checkpoint,
			state: "committed",
			compactionId,
			restoredEventSeq: event?.seq ?? null,
			reusedExistingSnapshot: message === void 0,
			replacedSnapshotSeq: priorSnapshot ?? null,
			restoredProjection: this.store.readDocument(this.#latest(binding, role)).value
		});
	}
	/**
	* Compact snapshots rely on native history for briefs, reports and user text.
	* Any compaction, including one the Host or the user started, may summarize
	* those away, so the first snapshot after it (and a task's first) is full.
	*/
	#detailFor(agent, binding, role) {
		let lastFull = -1, lastCompaction = -1;
		for (const event of agent.session.snapshotEvents()) {
			if (event.type === "compaction/end") lastCompaction = event.seq;
			if (event.type !== "user/message" || event.data.source?.kind !== "plugin:dsh-model-fusion" || event.data.source.form !== "snapshot") continue;
			for (const section of event.data.source.sections) {
				if (section.name !== "fusion:task") continue;
				try {
					const facts = JSON.parse(section.text.slice(section.text.indexOf("\n") + 1)).facts;
					if (facts.taskId === binding.taskId && facts.role === role && facts.detail !== "compact") lastFull = event.seq;
				} catch {}
			}
		}
		return lastFull < 0 || lastCompaction > lastFull ? "full" : "compact";
	}
	#latest(binding, role) {
		return `task-context:${binding.taskId}:${role}`;
	}
	#message(text) {
		return createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "plugin:dsh-model-fusion",
				form: "snapshot",
				sections: [{
					name: FUSION_TASK_CONTEXT,
					text
				}]
			}
		});
	}
	#text(facts, digest, artifact) {
		return `${INTRO}\n${JSON.stringify({
			facts,
			digest,
			sourceArtifact: artifact
		})}`;
	}
};
//#endregion
//#region src/host/native-compaction.ts
/**
* Public llm/stream routing for the Host's mutable, one-shot summary envelope.
* The Host still owns the compaction transaction and records this exact target.
* Never replace a prepared AgentLoop request or start a nested model call.
*/
function routeNativeCompaction(request, profile, effectiveRoute) {
	const choice = profile.compactor ?? (effectiveRoute && profile.interactionMode === "model-like" ? {
		route: effectiveRoute,
		maxOutputTokens: request.maxTokens
	} : void 0);
	if (request.purpose !== "compaction" || !choice) return;
	if (isAgentLoopRequest(request) || Object.isFrozen(request)) throw new Error("DSH 压缩请求已冻结，无法通过公开接口选择压缩模型");
	request.provider = choice.route.provider;
	request.model = choice.route.model;
	if (choice.maxOutputTokens !== void 0) request.maxTokens = choice.maxOutputTokens;
	if (choice.route.reasoningEffort === void 0) delete request.reasoningEffort;
	else request.reasoningEffort = ReasoningEffortId(choice.route.reasoningEffort);
	Object.freeze(request);
}
//#endregion
//#region src/host/native-context.ts
/** Optional summary routing, then final admission and the Host's single compaction owner. */
var NativeContextGuard = class {
	ctx;
	store;
	owner;
	blocked;
	taskContext;
	auxiliary;
	route;
	#rejected = /* @__PURE__ */ new WeakMap();
	constructor(ctx, store, owner, blocked, taskContext, auxiliary, route) {
		this.ctx = ctx;
		this.store = store;
		this.owner = owner;
		this.blocked = blocked;
		this.taskContext = taskContext;
		this.auxiliary = auxiliary;
		this.route = route;
	}
	async measure(agent, owner, request) {
		const meter = this.ctx.get("tokenMeter");
		if (!meter) throw new Error("Fusion requires the native tokenMeter service");
		const separateCompactor = request.purpose === "compaction" && owner.binding.profile.compactor;
		const route = separateCompactor ? separateCompactor.route : owner.binding.profile[owner.role];
		const policy = owner.binding.profile.context[owner.role];
		if (request.provider !== route.provider || request.model !== route.model) throw new Error("Fusion request must use its frozen role or compactor model");
		const logged = isAgentLoopRequest(request) ? agent.session.requestContext() : void 0;
		const capacity = logged?.provider === request.provider && logged.model === request.model ? logged.contextWindow : (await this.ctx.llm.resolveModelInfo(request.provider, request.model, request.signal)).context?.contextWindow;
		if (!Number.isSafeInteger(capacity) || Number(capacity) <= 0) throw new Error("The configured model does not disclose a usable context window");
		const contextWindow = Number(capacity), output = request.maxTokens;
		if (!Number.isSafeInteger(output) || Number(output) <= 0) throw new Error("Fusion requires an explicit output token reservation");
		const { messages, tools, signal: _signal, sessionId: _sessionId, purpose: _purpose, system, ...config } = request;
		const replay = meter.measure(agent.session, {
			config,
			...tools?.length ? { tools } : {}
		});
		const text = (value) => meter.estimateMessage(createUserMessage({
			content: [{
				type: "text",
				text: value
			}],
			source: { kind: "plugin:dsh-model-fusion" }
		}));
		const fixed = (system ? text(system) : 0) + (tools?.length ? text(JSON.stringify(tools)) : 0);
		const actual = messages.reduce((total, message) => total + meter.estimateMessage(message.id ? message : createUserMessage({
			content: message.content,
			source: { kind: "plugin:dsh-model-fusion" }
		})), 0) + fixed;
		const pinned = messages.flatMap((message) => message.source?.kind === "plugin:dsh-model-fusion" && message.source.form === "snapshot" ? message.source.sections.filter((section) => section.name === FUSION_TASK_CONTEXT) : []).at(-1);
		const minimumRetainedInputTokens = fixed + (pinned ? text(pinned.text) : 0);
		return {
			route,
			measurement: {
				inputTokens: this.auxiliary?.get(request) || separateCompactor ? actual : Math.max(replay.totalTokens, actual),
				reservedOutputTokens: Number(output),
				contextWindow,
				safetyTokens: safetyTokens(contextWindow, policy, "heuristic"),
				quality: "heuristic",
				requestDigest: digestOf({
					...config,
					messages,
					tools,
					system,
					purpose: request.purpose
				})
			},
			budget: inputBudget(request.purpose === "compaction" ? {
				...policy,
				targetInputTokens: contextWindow
			} : policy, contextWindow, Number(output), "heuristic"),
			purpose: this.auxiliary?.get(request)?.purpose ?? request.purpose ?? "conversation",
			logRevision: replay.logRevision,
			nativeBaseline: replay.baseline.kind,
			minimumRetainedInputTokens
		};
	}
	install(admit, ready) {
		const guard = this;
		const disposeStream = this.ctx.on("llm/stream", async function* (request, next) {
			const agent = nativeRequestAgent(guard.ctx, request), owner = agent && guard.owner(agent);
			if (!agent || !owner) {
				yield* next();
				return;
			}
			const auxiliary = guard.auxiliary?.get(request);
			ready(agent, request);
			if (owner.binding.profile.interactionMode === "model-like") {
				routeNativeCompaction(request, owner.binding.profile, guard.route?.(owner.binding, owner.role));
				admit(agent, owner, request);
				yield* next();
				return;
			}
			let check;
			try {
				routeNativeCompaction(request, owner.binding.profile);
				check = await guard.measure(agent, owner, request);
			} catch (error) {
				const reason = `Fusion 上下文检查失败：${error instanceof Error ? error.message : String(error)}`;
				if (!auxiliary && request.purpose !== "session-title") guard.blocked(owner, reason);
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: new LlmError(reason, "FUSION_CONTEXT_UNAVAILABLE").failure
					}
				};
				return;
			}
			request.signal?.throwIfAborted();
			const accepted = check.measurement.inputTokens <= check.budget;
			const recordId = `context-request:${owner.binding.taskId}:${randomUUID()}`;
			guard.store.writeDocument(recordId, 0, {
				schemaVersion: 1,
				sessionId: agent.id,
				role: owner.role,
				taskId: owner.binding.taskId,
				checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
				admitted: accepted,
				...check
			});
			if (!accepted) {
				const reason = `Fusion 上下文 ${check.measurement.inputTokens} 超过本轮预算 ${check.budget}（估算）`;
				if (isAgentLoopRequest(request) && request.purpose === void 0) guard.#rejected.set(agent, {
					owner,
					recordId,
					...check
				});
				else if (!auxiliary && request.purpose !== "session-title") guard.blocked(owner, reason);
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: new LlmError(reason, FUSION_CONTEXT_BUDGET).failure
					}
				};
				return;
			}
			if (isAgentLoopRequest(request) && request.purpose === void 0) guard.#rejected.delete(agent);
			ready(agent, request);
			admit(agent, owner, request);
			yield* next();
		}, { prepend: true });
		const disposeRecovery = this.ctx.on("agent/request-error", async ({ agent, turn, step, failure, signal }, next) => {
			const rejected = this.#rejected.get(agent);
			if (failure.code !== "FUSION_CONTEXT_BUDGET" || !rejected) return next();
			this.#rejected.delete(agent);
			const { owner } = rejected;
			const key = `context-recovery:${owner.binding.taskId}:${agent.id}:${turn}:${step}`;
			const saved = this.store.readDocument(key);
			const prior = saved?.value;
			const attempts = prior?.attempts ?? 0;
			const stop = (reason) => {
				const current = this.store.readDocument(key);
				const used = (current?.value)?.attempts ?? attempts;
				this.store.writeDocument(key, current?.revision ?? 0, {
					...current?.value,
					schemaVersion: 1,
					attempts: used,
					priorInput: rejected.measurement.inputTokens,
					state: "blocked",
					reason,
					request: rejected.recordId
				});
				this.blocked(owner, reason);
			};
			if (signal.aborted) return stop("上下文压缩已中断；Fusion 已暂停并保留原始记录");
			if (rejected.minimumRetainedInputTokens > rejected.budget) return stop("Fusion 必须保留的任务内容已超过本轮上下文预算；请缩短最新交接或调整模型配置，原始记录已保留");
			if (attempts >= 2 || prior && rejected.measurement.inputTokens >= prior.priorInput) return stop("上下文压缩没有继续缩小；Fusion 已暂停，保留原始记录");
			const compaction = this.ctx.get("agentPresets")?.serviceFor(agent, "compaction") ?? agent.ctx.get("compaction") ?? this.ctx.get("compaction");
			const meter = this.ctx.get("tokenMeter");
			if (!compaction || !meter) return stop("DSH 未提供上下文压缩服务；Fusion 已暂停");
			const measurement = meter.measure(agent.session);
			const nodes = measurement.nodes;
			const first = nodes.findIndex((node) => agent.session.eventAt(node.seq)?.type !== "system/message");
			const policy = owner.binding.profile.context[owner.role];
			const keepTokens = Math.max(0, Math.floor(rejected.budget * policy.compactToFraction) - Math.max(0, measurement.totalTokens - measurement.surfaceTokens) - policy.reserveOutputTokens);
			let keep = nodes.length - 1;
			while (keep > first && !toolPairingBalancedBefore(agent.session, nodes[keep].seq)) keep--;
			let retained = nodes.slice(Math.max(0, keep)).reduce((sum, node) => sum + node.tokens, 0);
			for (let index = keep - 1; index > first; index--) {
				retained += nodes[index].tokens;
				if (retained > keepTokens) break;
				if (toolPairingBalancedBefore(agent.session, nodes[index].seq)) keep = index;
			}
			if (first < 0 || keep <= first) return stop("当前输入没有可安全压缩的历史；请缩短输入或调整 Fusion 模型配置");
			this.store.writeDocument(key, saved?.revision ?? 0, {
				schemaVersion: 1,
				attempts: attempts + 1,
				priorInput: rejected.measurement.inputTokens,
				state: "started",
				request: rejected.recordId
			});
			try {
				const checkpoint = this.taskContext?.prepareCompaction(agent, owner.binding, owner.role, nodes.slice(first, keep).map((node) => node.seq));
				const result = await compaction.compactRegion(nodes[first].seq, nodes[keep - 1].seq, agent, signal);
				signal.throwIfAborted();
				if (checkpoint) this.taskContext.restoreCompaction(agent, owner.binding, owner.role, checkpoint, result.compactionId);
				const after = meter.measure(agent.session).totalTokens;
				this.store.writeDocument(key, this.store.readDocument(key).revision, {
					schemaVersion: 1,
					attempts: attempts + 1,
					priorInput: rejected.measurement.inputTokens,
					state: "compacted",
					compactionId: result.compactionId,
					beforeTokens: rejected.measurement.inputTokens,
					beforeNativeTokens: measurement.totalTokens,
					afterTokens: after,
					request: rejected.recordId,
					...checkpoint ? { checkpoint } : {}
				});
				if (after >= rejected.measurement.inputTokens) return stop("DSH 压缩后上下文没有缩小；Fusion 已暂停");
				return { kind: "retry" };
			} catch (error) {
				if (signal.aborted) return stop("上下文压缩已中断；Fusion 已暂停并保留原始记录");
				return stop(`DSH 上下文压缩失败；Fusion 已暂停：${error instanceof Error ? error.message : String(error)}`);
			}
		}, { prepend: true });
		return () => {
			disposeRecovery();
			disposeStream();
		};
	}
};
//#endregion
//#region src/host/native-workflow.ts
const enforcedWorkflow = (binding) => binding.profile.workflowPolicy === "enforced-v1" || binding.profile.workflowPolicy === "enforced-v2" || binding.profile.workflowPolicy === "enforced-v3";
/** v3 keeps every v2 mechanism and adds role separation (see native-role-sandbox). */
const adaptiveWorkflow = (binding) => binding.profile.workflowPolicy === "enforced-v2" || binding.profile.workflowPolicy === "enforced-v3";
/** Results, not model explanations, drive this bounded and persistable detector. */
function advanceProgress(previous, observation) {
	const prior = previous?.milestone === observation.milestone ? previous : void 0;
	const recent = [...prior?.recent ?? [], observation.fingerprint ?? ""].slice(-8);
	const tinyRead = observation.tinyPath ? {
		path: observation.tinyPath,
		count: prior?.tinyRead?.path === observation.tinyPath ? prior.tinyRead.count + 1 : 1
	} : void 0;
	return {
		window: {
			schemaVersion: 1,
			milestone: observation.milestone,
			recent,
			...tinyRead ? { tinyRead } : {}
		},
		stalled: Boolean(observation.fingerprint && recent.filter((item) => item === observation.fingerprint).length >= 3 || tinyRead && tinyRead.count >= (observation.role === "lead" ? 12 : 32))
	};
}
/** Only public execution results and durable task facts enter the workflow controller. */
var NativeWorkflow = class {
	store;
	constructor(store) {
		this.store = store;
	}
	milestone(binding) {
		const state = this.store.load(binding.taskId);
		const runtime = this.store.readDocument(`runtime:${binding.taskId}`)?.value;
		const control = adaptiveWorkflow(binding) ? this.store.readDocument(`model-control:${binding.sessionId}`)?.value : void 0;
		return digestOf({
			order: state.currentWorkOrder?.id,
			revision: state.currentWorkOrder?.revision,
			brief: runtime?.briefRevision,
			submitted: runtime?.submitted,
			takeover: runtime?.takeover,
			phase: state.phase,
			report: state.validatedReport,
			review: state.reviewResult,
			...adaptiveWorkflow(binding) ? { recoveryEpoch: control?.recoveryEpoch ?? 0 } : {}
		});
	}
	observe(exec, result, binding, role, read) {
		if (exec.name === "fusion_read_state" || exec.name === "job_output") return false;
		const id = `workflow-progress:${binding.taskId}:${exec.agent.id}`, row = this.store.readDocument(id);
		const shell = isShellTool(exec.name) && !result.isError ? result.value : void 0;
		const failed = result.isError || typeof shell?.exitCode === "number" && shell.exitCode !== 0;
		const args = exec.arguments;
		const fingerprint = failed || read || exec.name.startsWith("fusion_") ? digestOf({
			name: exec.name,
			args: exec.arguments,
			error: result.isError,
			content: result.content
		}) : void 0;
		const tinyPath = !adaptiveWorkflow(binding) && !failed && exec.name === "read" && typeof args.limit === "number" && args.limit <= 2 ? args.file_path ?? args.path : void 0;
		const next = advanceProgress(row?.value, {
			milestone: this.milestone(binding),
			fingerprint,
			tinyPath,
			role
		});
		this.store.writeDocument(id, row?.revision ?? 0, next.window);
		return next.stalled;
	}
	/** One local replanning opportunity, not an immediate request for user intervention. */
	repairProgress(agent, binding, role) {
		if (!adaptiveWorkflow(binding)) return false;
		const id = `workflow-replan:${binding.taskId}:${agent.id}:${this.milestone(binding)}`;
		if (this.store.readDocument(id)) return false;
		this.store.writeDocument(id, 0, {
			schemaVersion: 1,
			role,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		const progressId = `workflow-progress:${binding.taskId}:${agent.id}`, row = this.store.readDocument(progressId);
		this.store.writeDocument(progressId, row?.revision ?? 0, {
			schemaVersion: 1,
			milestone: this.milestone(binding),
			recent: []
		});
		agent.send(createUserMessage({
			source: {
				kind: "plugin:dsh-model-fusion",
				form: "notice",
				summary: "Fusion 检测到重复结果，正在调整执行方式"
			},
			content: [{
				type: "text",
				text: "The runtime detected repeated unchanged tool results. Use the evidence already collected and change the approach instead of repeating those calls. Continue the current task; delegate broad work if useful. Another unchanged cycle will pause this role without discarding progress."
			}]
		}), "next-step", false);
		return true;
	}
	denyEffect(binding) {
		const id = `workflow-effect-denied:${binding.taskId}`;
		if (!this.store.readDocument(id)) this.store.writeDocument(id, 0, {
			schemaVersion: 1,
			taskId: binding.taskId
		});
		return "FUSION_LEAD_READ_ONLY: execution belongs to the Sidekick. Use fusion_delegate for workspace changes or commands; fusion_explore for investigation. Lead takeover requires a current implementation report and a recorded rework review.";
	}
	deniedEffect(binding) {
		return Boolean(this.store.readDocument(`workflow-effect-denied:${binding.taskId}`));
	}
	/** At most one repair generation per role and durable milestone, surviving reloads. */
	repairStop(agent, binding, role, instruction) {
		const id = `workflow-stop:${binding.taskId}:${agent.id}:${this.milestone(binding)}`;
		if (this.store.readDocument(id)) return false;
		this.store.writeDocument(id, 0, {
			schemaVersion: 1,
			role,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		agent.send(createUserMessage({
			source: {
				kind: "plugin:dsh-model-fusion",
				form: "notice",
				summary: "Fusion 工作流尚未完成"
			},
			content: [{
				type: "text",
				text: instruction
			}]
		}), "next-step", false);
		return true;
	}
};
//#endregion
//#region src/host/native-model-control.ts
const LEAD_RECOVERABLE = [
	"WORKFLOW_INCOMPLETE",
	"NO_PROGRESS",
	"UNKNOWN"
];
const LEAD_RECOVERIES = 2;
function readModelControl(store, binding) {
	if (binding.profile.interactionMode !== "model-like") return void 0;
	const row = store.readDocument(`model-control:${binding.sessionId}`);
	if (!row) return {
		schemaVersion: 1,
		revision: 0,
		sessionId: binding.sessionId,
		profileDigest: binding.profile.digest,
		epoch: 0,
		routes: {
			lead: binding.profile.lead,
			worker: binding.profile.worker
		},
		waits: {}
	};
	const value = row.value;
	if (value.schemaVersion !== 1 || value.sessionId !== binding.sessionId || value.profileDigest !== binding.profile.digest || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !value.routes?.lead || !value.routes.worker || !value.waits) throw new Error("Fusion model control requires reconciliation");
	return {
		...value,
		revision: row.revision
	};
}
/** Durable local controls. No provider polling, synthetic user identity, or silent routing fallback. */
var NativeModelControl = class {
	ctx;
	store;
	callbacks;
	#bindings;
	#locks = /* @__PURE__ */ new Set();
	#pending = /* @__PURE__ */ new Set();
	#timers = /* @__PURE__ */ new Map();
	#dispose = [];
	#closed = false;
	constructor(ctx, store, callbacks) {
		this.ctx = ctx;
		this.store = store;
		this.callbacks = callbacks;
		this.#bindings = new BindingRepository(store);
		this.#dispose.push(ctx.on("agent/request-error", async (payload, next) => {
			const owner = callbacks.owner(payload.agent);
			if (owner?.binding.profile.interactionMode !== "model-like") return next();
			if (![
				"QUOTA",
				"QUOTA_EXHAUSTED",
				"INSUFFICIENT_QUOTA",
				"USAGE_LIMIT_REACHED"
			].includes(payload.failure.code)) {
				const action = await next();
				if (!action && !payload.signal.aborted) this.failure(owner.binding, owner.role, payload.failure);
				return action;
			}
			this.failure(owner.binding, owner.role, payload.failure);
			payload.agent.cancel({
				kind: "hook",
				reason: "Fusion provider quota requires local continuation"
			}, { keepInbox: true });
		}, { prepend: true }));
		this.#dispose.push(ctx.on("session/event", (session, event) => {
			if (!(event.type === "user/message" ? !event.data.source || event.data.source.kind === "user" : event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => !message.source || message.source.kind === "user"))) return;
			const binding = this.#bindings.read(session.id)?.binding;
			if (!binding?.selected || binding.profile.interactionMode !== "model-like") return;
			let view = readModelControl(store, binding);
			if (view.schedule?.state === "scheduled" && event.seq > view.schedule.userSeq) this.cancel(binding, bi("新的用户消息已取消定时继续", "A new user message cancelled the scheduled continuation"));
			view = readModelControl(store, binding);
			if (adaptiveWorkflow(binding) && Object.values(view.waits).some((wait) => wait?.taskId === binding.taskId && ["NO_PROGRESS", "WORKFLOW_INCOMPLETE"].includes(wait.code))) this.write({
				...view,
				recoveryEpoch: (view.recoveryEpoch ?? 0) + 1,
				waits: Object.fromEntries(Object.entries(view.waits).filter(([, wait]) => wait?.taskId !== binding.taskId || !["NO_PROGRESS", "WORKFLOW_INCOMPLETE"].includes(wait.code)))
			});
		}));
		this.#dispose.push(ctx.on("tools/result", (exec, result) => {
			const owner = exec.agent && callbacks.owner(exec.agent);
			if (owner?.binding.profile.interactionMode !== "model-like") return void 0;
			if (enforcedWorkflow(owner.binding)) return void 0;
			const id = `progress:${owner.binding.taskId}:${exec.agent.id}`, row = store.readDocument(id);
			const prior = row?.value;
			const shell = isShellTool(exec.name) && !result.isError ? result.value : void 0;
			const failedShell = typeof shell?.exitCode === "number" && shell.exitCode !== 0;
			const fingerprint = result.isError || failedShell ? digestOf({
				name: exec.name,
				args: exec.arguments,
				outcome: failedShell ? {
					exitCode: shell.exitCode,
					stdout: shell.stdout,
					stderr: shell.stderr
				} : result.content
			}) : void 0;
			const count = fingerprint && fingerprint === prior?.fingerprint ? (prior.count ?? 0) + 1 : fingerprint ? 1 : 0;
			store.writeDocument(id, row?.revision ?? 0, {
				fingerprint,
				count
			});
			if (count >= 3) this.failure(owner.binding, owner.role, {
				code: "NO_PROGRESS",
				message: "Three unchanged failed tool attempts; a changed approach is required"
			});
		}));
		for (const binding of this.#bindings.selected()) this.arm(binding);
	}
	reset(binding) {
		if (binding.profile.interactionMode !== "model-like") return;
		const id = `model-control:${binding.sessionId}`, row = this.store.readDocument(id);
		this.store.writeDocument(id, row?.revision ?? 0, {
			schemaVersion: 1,
			sessionId: binding.sessionId,
			profileDigest: binding.profile.digest,
			epoch: 0,
			routes: {
				lead: binding.profile.lead,
				worker: binding.profile.worker
			},
			waits: {}
		});
	}
	write(view) {
		const { revision, ...value } = view;
		return this.store.writeDocument(`model-control:${view.sessionId}`, revision, value);
	}
	route(binding, role) {
		return readModelControl(this.store, binding)?.routes[role] ?? binding.profile[role];
	}
	waiting(binding, role) {
		const wait = readModelControl(this.store, binding)?.waits[role];
		return wait?.taskId === binding.taskId ? wait : void 0;
	}
	/**
	* Clear a role wait the Lead can resolve itself by sending a new instruction: a missing report or
	* transition (WORKFLOW_INCOMPLETE), a repeated unchanged result (NO_PROGRESS) or an unclassified
	* error (UNKNOWN). At most LEAD_RECOVERIES per task; quota and credential stops are never cleared here.
	*/
	leadRecover(binding, role) {
		const view = readModelControl(this.store, binding);
		const wait = view?.waits[role];
		if (!view || !wait || wait.taskId !== binding.taskId || !LEAD_RECOVERABLE.includes(wait.code)) return false;
		const used = view.leadRecoveries?.taskId === binding.taskId ? view.leadRecoveries.count : 0;
		if (used >= LEAD_RECOVERIES) return false;
		const { [role]: _cleared, ...waits } = view.waits;
		this.write({
			...view,
			waits,
			recoveryEpoch: (view.recoveryEpoch ?? 0) + 1,
			leadRecoveries: {
				taskId: binding.taskId,
				count: used + 1
			}
		});
		return true;
	}
	/** The role stalled again after the Lead already redirected it LEAD_RECOVERIES times this task. */
	recoveriesExhausted(binding, role) {
		const view = readModelControl(this.store, binding), wait = view?.waits[role];
		if (!view || !wait || wait.taskId !== binding.taskId || !LEAD_RECOVERABLE.includes(wait.code)) return false;
		return (view.leadRecoveries?.taskId === binding.taskId ? view.leadRecoveries.count : 0) >= LEAD_RECOVERIES;
	}
	blocked(binding, role) {
		const view = readModelControl(this.store, binding);
		if (view?.operation && ["prepared", "dispatching"].includes(view.operation.state)) return "Fusion continuation is pending local delivery confirmation";
		return view?.waits[role]?.taskId === binding.taskId ? `${role} is paused (${view.waits[role].code}); use local Fusion controls to continue` : void 0;
	}
	reconcileDelivery(agent, binding, evidenceId) {
		const view = readModelControl(this.store, binding), operation = view?.operation;
		if (!view || !operation || !["prepared", "dispatching"].includes(operation.state)) return;
		const delivered = operation.message && agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => message.id === operation.message.id));
		this.write({
			...view,
			operation: {
				...operation,
				state: delivered ? "delivered" : "failed",
				error: `Delivery inspected; evidence ${evidenceId}. No automatic replay.`
			}
		});
	}
	failure(binding, role, failure) {
		const view = readModelControl(this.store, binding);
		const ms = failure.providerRetryAfterMs;
		this.write({
			...view,
			waits: {
				...view.waits,
				[role]: {
					taskId: binding.taskId,
					code: failure.code,
					at: (/* @__PURE__ */ new Date()).toISOString(),
					quotaResetAt: null,
					...ms !== void 0 && Number.isFinite(ms) && ms >= 0 && ms < 864e13 - Date.now() ? { retryNotBefore: new Date(Date.now() + ms).toISOString() } : {}
				}
			},
			...view.schedule ? { schedule: {
				...view.schedule,
				state: "cancelled",
				reason: bi("模型仍不可用；不会重复自动请求", "The model is still unavailable; no further automatic request")
			} } : {}
		});
		this.callbacks.stopAuxiliary(binding);
		this.clearTimer(binding.sessionId);
	}
	require(sessionId, taskId, revision) {
		const saved = this.#bindings.read(sessionId);
		if (!saved?.binding.selected || saved.binding.taskId !== taskId) throw new Error(bi("任务已变化，请刷新状态", "The task changed; refresh the status"));
		const view = readModelControl(this.store, saved.binding);
		if (!view || view.revision !== revision) throw new Error(bi("恢复状态已变化，请刷新后重试", "The recovery state changed; refresh and retry"));
		if (this.store.load(saved.binding.taskId)?.control.mode === "completed") throw new Error(bi("任务已经完成", "The task is already finished"));
		return {
			binding: saved.binding,
			view,
			bindingRevision: saved.revision
		};
	}
	userSeq(agent) {
		return agent.session.snapshotEvents().findLast((event) => event.type === "user/message" && (!event.data.source || event.data.source.kind === "user") || event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => !message.source || message.source.kind === "user"))?.seq ?? 0;
	}
	cancel(binding, reason = bi("已取消定时继续", "Scheduled continuation cancelled")) {
		const view = readModelControl(this.store, binding);
		if (view?.schedule?.state === "scheduled") this.write({
			...view,
			schedule: {
				...view.schedule,
				state: "cancelled",
				reason
			}
		});
		this.clearTimer(binding.sessionId);
	}
	async schedule(sessionId, taskId, revision, dueAt) {
		const time = Date.parse(dueAt);
		if (!Number.isFinite(time) || time <= Date.now()) throw new Error(bi("请选择未来的继续时间", "Choose a time in the future"));
		const { binding } = this.require(sessionId, taskId, revision);
		const agent = await this.callbacks.resolve(sessionId);
		const { view } = this.require(sessionId, taskId, revision);
		if (agent.status !== "idle" || !this.callbacks.settled(binding)) throw new Error(bi("等待当前操作停止并核对结果后再设置定时继续", "Wait for the current operation to stop and check it before scheduling"));
		if (view.operation && ["prepared", "dispatching"].includes(view.operation.state)) throw new Error(bi("请先检查上次继续操作的投递结果", "Check the delivery of the last continuation first"));
		if (!Object.values(view.waits).some((wait) => wait?.taskId === taskId)) throw new Error(bi("只有等待模型恢复的任务可以定时继续", "Only a task waiting for its model can be scheduled"));
		this.write({
			...view,
			schedule: {
				id: randomUUID(),
				taskId,
				epoch: view.epoch,
				dueAt: new Date(time).toISOString(),
				userSeq: this.userSeq(agent),
				state: "scheduled"
			}
		});
		this.arm(binding);
	}
	continue(sessionId, taskId, revision, change, scheduledId) {
		if (this.#closed) return Promise.reject(/* @__PURE__ */ new Error("Fusion runtime is closing"));
		const pending = this.runContinue(sessionId, taskId, revision, change, scheduledId);
		this.#pending.add(pending);
		pending.finally(() => this.#pending.delete(pending)).catch(() => void 0);
		return pending;
	}
	async runContinue(sessionId, taskId, revision, change, scheduledId) {
		if (this.#locks.has(sessionId)) throw new Error(bi("当前会话正在恢复，请稍候", "This conversation is recovering; please wait"));
		this.#locks.add(sessionId);
		try {
			const initial = this.require(sessionId, taskId, revision);
			const agent = await this.callbacks.resolve(sessionId);
			const userSeq = this.userSeq(agent);
			let { view, binding } = this.require(sessionId, taskId, revision);
			if (view.operation && ["prepared", "dispatching"].includes(view.operation.state)) {
				const messageId = view.operation.message?.id;
				if (messageId && agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => message.id === messageId))) {
					this.write({
						...view,
						operation: {
							...view.operation,
							state: "delivered"
						}
					});
					return;
				}
				throw new Error(bi("上次继续操作的投递结果未知；请检查会话，不会自动重复发送", "Delivery of the last continuation is unknown; check the conversation. Nothing is resent automatically"));
			}
			if (scheduledId && (view.schedule?.id !== scheduledId || view.schedule.state !== "scheduled" || view.schedule.epoch !== view.epoch || view.schedule.userSeq !== userSeq || agent.status !== "idle")) {
				this.cancel(binding, bi("任务状态已变化，定时继续已取消", "The task changed; the scheduled continuation was cancelled"));
				return;
			}
			await this.callbacks.pause(agent);
			if (this.#bindings.read(sessionId)?.revision !== initial.bindingRevision || this.userSeq(agent) !== userSeq) throw new Error(bi("暂停期间任务或用户消息已变化，请刷新", "The task or messages changed while paused; refresh"));
			({view, binding} = this.require(sessionId, taskId, revision));
			if (!this.callbacks.settled(binding)) throw new Error(bi("中断的操作尚未确认结束，请先使用 /fusion recover 核对", "Interrupted operations are not confirmed finished; use /fusion recover first"));
			const operation = {
				id: randomUUID(),
				taskId,
				state: "prepared"
			};
			const message = createUserMessage({
				content: [{
					type: "text",
					text: `Continue the existing Fusion task ${taskId} from its saved state. Read fusion_read_state if needed. Preserve accepted constraints and inspect uncertain effects before replay. Local continuation operation: ${operation.id}.`
				}],
				source: {
					kind: "plugin:dsh-model-fusion",
					form: "notice",
					summary: bi("用户通过 Fusion 控件继续当前任务", "The user continued the task from the Fusion controls")
				}
			});
			view = {
				...view,
				epoch: view.epoch + (change ? 1 : 0),
				recoveryEpoch: (view.recoveryEpoch ?? 0) + 1,
				routes: change ? {
					...view.routes,
					[change.role]: change.route
				} : view.routes,
				waits: change ? Object.fromEntries(Object.entries(view.waits).filter(([role]) => role !== change.role)) : {},
				operation: {
					...operation,
					message
				},
				...view.schedule ? { schedule: {
					...view.schedule,
					state: scheduledId ? "fired" : "cancelled"
				} } : {}
			};
			view.revision = this.write(view);
			for (const id of this.store.listDocumentIds(`progress:${taskId}:`)) {
				const row = this.store.readDocument(id);
				this.store.writeDocument(id, row.revision, { count: 0 });
			}
			for (const id of this.store.listDocumentIds(`workflow-progress:${taskId}:`)) {
				const row = this.store.readDocument(id);
				this.store.writeDocument(id, row.revision, {
					schemaVersion: 1,
					milestone: "",
					recent: []
				});
			}
			this.clearTimer(sessionId);
			try {
				await this.callbacks.resume(agent);
				if (this.#closed || this.userSeq(agent) !== userSeq) throw new Error(bi("恢复期间出现新消息或插件已退出", "A new message arrived or the plugin exited during recovery"));
				view = {
					...view,
					operation: {
						...view.operation,
						state: "dispatching"
					}
				};
				view.revision = this.write(view);
				agent.send(message, "next-turn", true);
				if (!agent.session.snapshotEvents().some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((item) => item.id === message.id))) throw new Error(bi("继续消息未获得原生收件箱确认；不会自动重发", "The native inbox did not confirm the continuation; it is not resent automatically"));
				this.write({
					...view,
					operation: {
						...view.operation,
						state: "delivered"
					}
				});
			} catch (error) {
				if (view.operation?.state === "prepared") this.write({
					...view,
					operation: {
						...view.operation,
						state: "failed",
						error: String(error)
					}
				});
				throw error;
			}
		} finally {
			this.#locks.delete(sessionId);
		}
	}
	clearTimer(sessionId) {
		clearTimeout(this.#timers.get(sessionId));
		this.#timers.delete(sessionId);
	}
	arm(binding) {
		this.clearTimer(binding.sessionId);
		if (this.#closed || binding.profile.interactionMode !== "model-like") return;
		const schedule = readModelControl(this.store, binding).schedule;
		if (schedule?.state !== "scheduled") return;
		const delay = Math.max(0, Date.parse(schedule.dueAt) - Date.now());
		const timer = setTimeout(() => {
			this.#timers.delete(binding.sessionId);
			const current = this.#bindings.read(binding.sessionId)?.binding;
			if (!current?.selected || current.taskId !== schedule.taskId || this.store.load(current.taskId)?.control.mode === "completed") {
				if (current?.selected && current.profile.interactionMode === "model-like") this.cancel(current, bi("任务已结束或切换", "The task ended or changed"));
				return;
			}
			if (delay > 6e4) {
				this.arm(current);
				return;
			}
			const fresh = readModelControl(this.store, current);
			this.continue(current.sessionId, current.taskId, fresh.revision, void 0, schedule.id).catch((error) => {
				const latest = readModelControl(this.store, current);
				if (latest.schedule?.id === schedule.id && latest.schedule.state === "scheduled") this.write({
					...latest,
					schedule: {
						...latest.schedule,
						state: "failed",
						reason: String(error)
					}
				});
			});
		}, Math.min(delay, 6e4));
		timer.unref();
		this.#timers.set(binding.sessionId, timer);
	}
	async close() {
		this.#closed = true;
		for (const id of this.#timers.keys()) this.clearTimer(id);
		this.#dispose.forEach((dispose) => dispose());
		await Promise.allSettled(this.#pending);
	}
};
//#endregion
//#region src/host/native-role-sandbox.ts
const roleSeparated = (binding) => binding.profile.workflowPolicy === "enforced-v3";
/**
* Role separation enforced below the prompt: the Lead's session runs under the
* Host's own read-only sandbox (bash and filesystem are refused by the OS
* backend), while the Sidekick keeps the mode the user chose. The plugin never
* widens a mode: the Sidekick gets exactly the user's mode, and leaving Fusion
* restores it on the conversation. Only public session events are written.
*/
var NativeRoleSandbox = class {
	ctx;
	store;
	binding;
	#dispose = [];
	constructor(ctx, store, binding) {
		this.ctx = ctx;
		this.store = store;
		this.binding = binding;
	}
	get #policy() {
		return this.ctx.get("sandboxPolicy");
	}
	#id(sessionId) {
		return `sandbox-intent:${sessionId}`;
	}
	#intent(sessionId) {
		return this.store.readDocument(this.#id(sessionId))?.value;
	}
	#save(intent) {
		const prior = this.store.readDocument(this.#id(intent.sessionId));
		this.store.writeDocument(this.#id(intent.sessionId), prior?.revision ?? 0, {
			...intent,
			ownSeqs: intent.ownSeqs.slice(-32)
		});
	}
	#writing = false;
	#set(session, mode, intent) {
		this.#writing = true;
		try {
			intent.ownSeqs.push(session.append("sandbox/mode", { mode }).seq);
		} finally {
			this.#writing = false;
		}
	}
	/**
	* Called before every model request of an enforced-v3 role. `writer` is true only while the Lead holds the
	* write lease through a Host-unlocked takeover; it then runs under the user's own mode, like the Sidekick.
	*/
	ensure(agent, binding, role, writer = false) {
		const policy = this.#policy;
		if (!policy || !roleSeparated(binding)) return;
		if (role === "lead") {
			const saved = this.#intent(binding.sessionId);
			const intent = saved?.active ? saved : {
				schemaVersion: 1,
				sessionId: binding.sessionId,
				mode: policy.resolve({ session: agent.session }).mode,
				ownSeqs: saved?.ownSeqs ?? [],
				active: true
			};
			const target = writer ? intent.mode : "read-only";
			if (policy.overrideOf(agent.session) !== target) this.#set(agent.session, target, intent);
			this.#save(intent);
			return;
		}
		const intent = this.#intent(binding.sessionId);
		if (!intent?.active) throw new Error("Fusion has not recorded the conversation sandbox mode for the Sidekick");
		if (policy.overrideOf(agent.session) !== intent.mode) this.#set(agent.session, intent.mode, {
			...intent,
			ownSeqs: []
		});
	}
	/**
	* Frozen acceptance checks are plugin-issued and nested in a Lead tool call, so
	* they would inherit the Lead's read-only session. They run under the user's
	* mode; the Lead's own shell stays refused meanwhile because leadShellProblem
	* requires an actual read-only resolution at execution time.
	*/
	async whileChecking(agent, binding, run) {
		const policy = this.#policy, intent = this.#intent(binding.sessionId);
		if (!policy || !roleSeparated(binding) || !intent?.active || intent.mode === "read-only") return run();
		this.#set(agent.session, intent.mode, intent);
		this.#save(intent);
		try {
			return await run();
		} finally {
			const current = this.#intent(binding.sessionId) ?? intent;
			this.#set(agent.session, "read-only", current);
			this.#save(current);
		}
	}
	/** A Lead shell is allowed only when the Host will actually run it read-only and without escalation. */
	leadShellProblem(exec) {
		const policy = this.#policy;
		if (!policy) return "FUSION_LEAD_READ_ONLY: this Host exposes no sandbox policy, so the Lead cannot run shell commands. Delegate commands to the Sidekick.";
		const args = exec.arguments ?? {};
		if (args.sandbox_permissions !== void 0 && args.sandbox_permissions !== null && args.sandbox_permissions !== "") return "FUSION_LEAD_READ_ONLY: the Lead never escalates its sandbox. Delegate anything that needs to write or run with wider access to the Sidekick with fusion_delegate.";
		if (policy.resolve({ session: exec.agent.session }).mode !== "read-only") return "FUSION_LEAD_READ_ONLY: the Lead shell is not currently confined to read-only; delegate this command to the Sidekick.";
	}
	/** Put the user's own mode back when the conversation leaves Fusion. */
	restore(agent) {
		const intent = this.#intent(agent.id), policy = this.#policy;
		if (!intent?.active || !policy) return;
		if (policy.overrideOf(agent.session) !== intent.mode) this.#set(agent.session, intent.mode, intent);
		this.#save({
			...intent,
			active: false
		});
	}
	/** A mode switch the user makes while Fusion is selected becomes the Sidekick's mode; the Lead stays read-only. */
	install() {
		this.#dispose.push(this.ctx.on("session/event", (session, event) => {
			if (event.type !== "sandbox/mode" || this.#writing) return;
			const binding = this.binding(session.id);
			if (!binding?.selected || !roleSeparated(binding) || binding.sessionId !== session.id) return;
			const intent = this.#intent(session.id);
			if (!intent?.active || intent.ownSeqs.includes(event.seq)) return;
			intent.mode = event.data.mode;
			setImmediate(() => {
				try {
					const current = this.#intent(session.id);
					if (!current?.active) return;
					this.#set(session, "read-only", current);
					this.#save(current);
				} catch {}
			});
			this.#save(intent);
		}));
		return () => {
			for (const dispose of this.#dispose.splice(0)) dispose();
		};
	}
};
//#endregion
//#region src/host/evidence-page.ts
/** Lossless text decoding; binary artifacts stay available as explicit base64. */
function evidenceText(bytes) {
	if (bytes.includes(0)) return void 0;
	try {
		return new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true
		}).decode(bytes);
	} catch {
		return;
	}
}
/** Offsets count UTF-16 code units of text, or characters of base64. */
function evidencePage(bytes, offset = 0, limit = 24e3) {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Evidence offset must be a nonnegative safe integer");
	if (!Number.isSafeInteger(limit) || limit < 2 || limit > 24e3) throw new Error("Evidence limit must be an integer from 2 to 24000");
	const decoded = evidenceText(bytes);
	const encoding = decoded === void 0 ? "base64" : "utf-8";
	const content = decoded ?? Buffer.from(bytes).toString("base64");
	if (offset > content.length) throw new Error("Evidence offset exceeds the artifact text length");
	const splitsPair = (at) => at > 0 && at < content.length && content.charCodeAt(at - 1) >= 55296 && content.charCodeAt(at - 1) <= 56319 && content.charCodeAt(at) >= 56320 && content.charCodeAt(at) <= 57343;
	if (splitsPair(offset)) throw new Error("Evidence offset splits a Unicode character; use the returned nextOffset");
	let end = Math.min(content.length, offset + limit);
	if (splitsPair(end)) end--;
	const truncated = end < content.length;
	return {
		bytes: bytes.byteLength,
		encoding,
		offsetUnit: "utf-16-code-units",
		offset,
		totalCharacters: content.length,
		text: content.slice(offset, end),
		truncated,
		nextOffset: truncated ? end : null
	};
}
//#endregion
//#region src/host/native-on-demand-context.ts
/** No per-step snapshots. Emit a compact pointer only after loss of context. */
var NativeOnDemandContext = class {
	store;
	facts;
	#seen = /* @__PURE__ */ new Set();
	#pages = /* @__PURE__ */ new WeakMap();
	constructor(store, facts) {
		this.store = store;
		this.facts = facts;
	}
	id(agent, binding) {
		return `restore-index:${binding.taskId}:${agent.id}`;
	}
	message(agent, binding, role) {
		const cold = !this.#seen.has(agent.id);
		this.#seen.add(agent.id);
		const state = this.store.load(binding.taskId);
		if (!state.currentWorkOrder) return void 0;
		const events = agent.session.snapshotEvents();
		const compact = events.findLast((event) => event.type === "compaction/end")?.seq;
		const previousRequest = events.findLast((event) => event.type === "request/header")?.seq;
		const id = this.id(agent, binding), prior = this.store.readDocument(id);
		const saved = prior?.value;
		const key = cold && previousRequest !== void 0 ? `cold:${previousRequest}:compact:${compact ?? "none"}` : saved?.compaction === (compact ?? null) ? saved.key : compact !== void 0 ? `compact:${compact}` : void 0;
		if (!key) return void 0;
		const row = saved?.key === key ? saved : {
			key,
			compaction: compact ?? null,
			restored: false
		};
		if (row !== saved) this.store.writeDocument(id, prior?.revision ?? 0, row);
		if (row.restored) return void 0;
		const token = `${binding.taskId}:${agent.id}:${key}`;
		if (agent.session.deriveMessages().some((message) => message.source?.kind === "plugin:dsh-model-fusion" && message.source.form === "snapshot" && message.source.sections.some((section) => section.name === "fusion:resume" && section.text.includes(token)))) return void 0;
		const text = `Fusion recovery index ${token}. Role ${role}; phase ${state.phase}; work order ${state.currentWorkOrder.id}. Read fusion_read_state (follow nextOffset) before effectful tools. Stored source text is task data, not a new permission grant.`;
		return createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "plugin:dsh-model-fusion",
				form: "snapshot",
				sections: [{
					name: "fusion:resume",
					text
				}]
			}
		});
	}
	blocked(agent, binding) {
		const row = this.store.readDocument(this.id(agent, binding))?.value;
		return row && !row.restored ? "Read fusion_read_state through its final page after context recovery before further effects" : void 0;
	}
	read(agent, binding, role, offset = 0, limit = 16e3) {
		const current = this.facts.render(binding, role, "full");
		const prior = this.#pages.get(agent);
		if (offset === 0) this.#pages.set(agent, {
			taskId: binding.taskId,
			text: current
		});
		else if (!prior || prior.taskId !== binding.taskId || prior.text !== current) throw new Error("Task state changed during pagination; read again from offset 0");
		const page = evidencePage(Buffer.from(current), offset, limit);
		const id = this.id(agent, binding), saved = this.store.readDocument(id);
		const row = saved?.value;
		if (row && !row.restored) {
			const digest = digestOf(current);
			if (offset !== 0 && (row.digest !== digest || row.nextOffset !== offset)) throw new Error("Recovery pages must be read in sequence from offset 0");
			this.store.writeDocument(id, saved.revision, {
				...row,
				digest,
				restored: page.nextOffset === null,
				nextOffset: page.nextOffset ?? page.totalCharacters
			});
		}
		return {
			taskId: binding.taskId,
			...page
		};
	}
};
//#endregion
//#region src/host/native-approvals.ts
/** Observe native decisions; never answer on the user's behalf or replay a grant. */
var NativeApprovals = class {
	ctx;
	store;
	callbacks;
	#calls = /* @__PURE__ */ new Map();
	#requests = /* @__PURE__ */ new Map();
	constructor(ctx, store, callbacks) {
		this.ctx = ctx;
		this.store = store;
		this.callbacks = callbacks;
	}
	install() {
		const disposers = [
			this.ctx.on("tools/pre-execute", async (exec, next) => {
				if (exec.agent && this.callbacks.owner(exec.agent)) {
					let calls = this.#calls.get(exec.agent);
					if (!calls) this.#calls.set(exec.agent, calls = /* @__PURE__ */ new Map());
					calls.set(exec.callId, exec);
				}
				return next();
			}, { prepend: true }),
			this.ctx.on("session/event", (session, event) => {
				if (event.type !== "approval/asked" && event.type !== "approval/decided") return;
				const agent = this.ctx.agents.get(SessionId$1(session.id)), owner = agent && this.callbacks.owner(agent);
				if (!agent || !owner) return;
				try {
					if (event.type === "approval/asked") this.#asked(agent, owner, event.data, event.seq);
					else this.#decided(owner, event.data.id, event.data.outcome, event.seq);
				} catch (error) {
					this.callbacks.failed(agent, error);
				}
			}),
			this.ctx.on("approval/request", async (request, next) => {
				const owner = this.callbacks.owner(request.agent);
				if (!owner) return next();
				const key = this.#requests.get(this.#callKey(request.agent.id, request.callId ?? ""));
				if (!key) return "unavailable";
				const outcome = await next();
				if (outcome !== "allowed-once") return outcome;
				try {
					const row = this.#read(key), exec = this.#calls.get(request.agent)?.get(row.callId);
					const control = this.callbacks.state(owner.binding.taskId).control;
					if (!exec || request.signal?.aborted || control.mode !== "running" || control.recovering || control.outcomeUnknown || control.budgetBlocked || row.scopeDigest !== this.#scope(request.agent, owner, exec).digest) {
						this.#write(key, {
							...row,
							scopeRejection: "The action, workspace, policy or task control changed while approval was pending"
						});
						return "rejected";
					}
					return outcome;
				} catch (error) {
					this.callbacks.failed(request.agent, error);
					return "unavailable";
				}
			}, { prepend: true }),
			this.ctx.on("tools/result", (exec, result) => {
				if (!exec.agent) return;
				const key = this.#requests.get(this.#callKey(exec.agent.id, exec.callId));
				if (key) {
					try {
						const row = this.#read(key);
						this.#write(key, {
							...row,
							logical: row.nativeOutcome === "allowed-once" ? {
								...row.logical,
								state: "consumed"
							} : row.logical,
							effect: result.isError ? "failed" : "settled"
						});
					} catch (error) {
						this.callbacks.failed(exec.agent, error);
					}
					this.#requests.delete(this.#callKey(exec.agent.id, exec.callId));
				}
				this.#calls.get(exec.agent)?.delete(exec.callId);
			})
		];
		return () => {
			for (const dispose of disposers.reverse()) dispose();
			this.#calls.clear();
			this.#requests.clear();
		};
	}
	/** Caller must first stop/release both native Agents and inspect uncertain effects. */
	reconcile(taskId, evidence) {
		if (!evidence) throw new Error("Approval recovery requires inspection evidence");
		for (const key of this.store.listDocumentIds(`native-approval:${taskId}:`)) {
			const row = this.#read(key);
			if (row.state !== "pending") continue;
			const agent = this.ctx.agents.get(SessionId$1(row.agentId));
			if (agent && agent.status !== "idle" || [...this.#requests.values()].includes(key)) throw new Error("The native approval is still live; settle it before recovery");
			if (row.processId !== process.pid) try {
				process.kill(row.processId, 0);
				throw new Error("The recorded approval process is still live");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
			if (this.callbacks.state(taskId).pendingApprovalIds.includes(row.logical.id)) this.callbacks.answered(taskId, row.logical.id, "withdrawn");
			this.#write(key, {
				...row,
				logical: {
					...row.logical,
					state: "withdrawn"
				},
				state: "withdrawn-after-inspection",
				inspectionEvidence: evidence
			});
		}
	}
	#asked(agent, owner, asked, seq) {
		const exec = asked.callId && this.#calls.get(agent)?.get(asked.callId);
		if (!exec || exec.name !== asked.toolName) throw new Error("Native approval has no matching immutable tool execution");
		const key = `native-approval:${owner.binding.taskId}:${asked.id}`;
		if (this.store.readDocument(key)) throw new Error("Native approval identity was reused");
		const scope = this.#scope(agent, owner, exec), state = this.callbacks.state(owner.binding.taskId);
		const previousRequest = this.store.listDocumentIds(`native-approval:${owner.binding.taskId}:`).find((id) => {
			const prior = this.#read(id);
			return prior.state === "withdrawn-after-inspection" && !prior.reissuedAs && prior.scopeDigest === scope.digest;
		});
		const prior = previousRequest && this.#read(previousRequest);
		const logical = {
			id: prior ? prior.logical.id : `native:${asked.id}`,
			taskId: owner.binding.taskId,
			revision: state.revision,
			operationId: prior ? prior.logical.operationId : state.currentWorkOrder?.operationId ?? OperationId(`native-tool:${agent.id}:${exec.callId}`),
			nativeRequestId: asked.id,
			argsDigest: scope.argsDigest,
			snapshot: scope.snapshot.id,
			permissionPolicyDigest: scope.policyDigest,
			state: "pending",
			requestingAgent: SessionId(agent.id),
			toolName: exec.name,
			callId: exec.callId,
			role: owner.role,
			...asked.reason ? { reason: asked.reason } : {}
		};
		const evidence = this.store.putArtifact(owner.binding.taskId, Buffer.from(JSON.stringify({
			nativeRequestId: asked.id,
			toolName: exec.name,
			arguments: exec.arguments,
			snapshot: scope.snapshot,
			policy: scope.policy
		})), "application/vnd.dsh-fusion.approval-scope+json");
		this.store.writeDocument(key, 0, {
			schemaVersion: 1,
			logical,
			agentId: agent.id,
			role: owner.role,
			toolName: exec.name,
			callId: exec.callId,
			rootCallId: exec.rootCallId,
			askedSeq: seq,
			askedAt: (/* @__PURE__ */ new Date()).toISOString(),
			processId: process.pid,
			scopeDigest: scope.digest,
			evidence,
			state: "pending",
			...previousRequest ? { previousRequest } : {}
		});
		this.callbacks.pending(owner.binding.taskId, logical);
		if (prior && previousRequest) this.#write(previousRequest, {
			...prior,
			reissuedAs: key
		});
		this.#requests.set(this.#callKey(agent.id, exec.callId), key);
	}
	#decided(owner, nativeId, outcome, seq) {
		const key = `native-approval:${owner.binding.taskId}:${nativeId}`, row = this.#read(key);
		if (row.state !== "pending") throw new Error("Native approval already settled");
		const state = outcome === "allowed-once" ? "approved" : outcome === "cancelled" ? "withdrawn" : "rejected";
		this.callbacks.answered(owner.binding.taskId, row.logical.id, state);
		this.#write(key, {
			...row,
			logical: {
				...row.logical,
				state
			},
			state: "decided",
			nativeOutcome: outcome,
			decidedSeq: seq
		});
	}
	#scope(agent, owner, exec) {
		const state = this.callbacks.state(owner.binding.taskId), service = agent.ctx.get("approval") ?? this.ctx.get("approval");
		if (!service || !agent.session.header.cwd) throw new Error("Native approval policy or workspace is unavailable");
		const snapshot = snapshotWorkspace(agent.session.header.cwd);
		const policy = {
			scope: "native-approval-and-frozen-fusion-policy",
			nativeApproval: service.overrideOf(agent.session) ?? service.config.policy ?? "ask",
			profileDigest: owner.binding.profile.digest,
			allowedPaths: state.currentWorkOrder?.allowedPaths ?? null
		};
		const argsDigest = digestOf({
			tool: exec.name,
			arguments: exec.arguments
		}), policyDigest = digestOf(policy);
		return {
			snapshot,
			policy,
			argsDigest,
			policyDigest,
			digest: digestOf({
				taskId: state.taskId,
				revision: state.revision,
				agentId: agent.id,
				role: owner.role,
				argsDigest,
				snapshot: snapshot.id,
				policyDigest
			})
		};
	}
	#callKey(agent, call) {
		return JSON.stringify([agent, call]);
	}
	#read(key) {
		const row = this.store.readDocument(key)?.value;
		if (!row || row.schemaVersion !== 1 || !row.logical || !row.scopeDigest) throw new Error("Native approval journal requires reconciliation");
		return row;
	}
	#write(key, row) {
		this.store.writeDocument(key, this.store.readDocument(key).revision, row);
	}
};
//#endregion
//#region src/host/native-effects.ts
/** Public native dispatch journal; it never wraps a provider or invents a PID. */
var NativeEffects = class {
	ctx;
	store;
	callbacks;
	#live = /* @__PURE__ */ new Map();
	#waiters = /* @__PURE__ */ new Map();
	#jobs = /* @__PURE__ */ new Map();
	#registry;
	constructor(ctx, store, callbacks) {
		this.ctx = ctx;
		this.store = store;
		this.callbacks = callbacks;
		this.#registry = ctx.get("jobs");
	}
	install() {
		const offJobs = this.#registry?.events.subscribe({ owners: "all" }, (event) => {
			if (event.type !== "settled") return;
			const snapshot = event.job;
			const live = this.#jobs.get(snapshot.id);
			if (live && snapshot.owner === live.agent.id) this.#settled(live, snapshot);
		});
		const offTools = this.ctx.on("tools/execute", async (exec, next) => {
			const owner = exec.agent && this.callbacks.owner(exec.agent);
			if (owner && exec.name === "job_output") {
				this.#waiters.set(exec.token, exec.agent);
				try {
					return await next();
				} finally {
					this.#waiters.delete(exec.token);
				}
			}
			if (!owner || !this.callbacks.track(exec)) return next();
			const taskId = owner.binding.taskId, id = `native-effect:${taskId}:${randomUUID()}`;
			let row;
			try {
				row = {
					schemaVersion: 1,
					taskId,
					agentId: exec.agent.id,
					role: owner.role,
					callId: exec.callId,
					rootCallId: exec.rootCallId,
					toolName: exec.name,
					processId: process.pid,
					startedAt: (/* @__PURE__ */ new Date()).toISOString(),
					state: "dispatch-started",
					arguments: this.store.putArtifact(taskId, Buffer.from(JSON.stringify({
						tool: exec.name,
						arguments: exec.arguments
					})), "application/vnd.dsh-fusion.native-effect+json")
				};
				this.store.writeDocument(id, 0, row);
			} catch (error) {
				this.callbacks.failed(exec.agent, error);
				throw error;
			}
			this.#live.set(exec.token, taskId);
			try {
				const result = await next();
				const value = !result.isError && result.value;
				const resultJob = !result.isError ? value : null;
				const jobKind = resultJob?.kind;
				if (isShellTool(exec.name) && !result.isError && (exec.arguments.run_in_background === true || jobKind === "background" || jobKind === "promoted")) {
					if (jobKind !== "background" && jobKind !== "promoted" || typeof resultJob?.jobId !== "string") throw new Error(`Native ${exec.name} returned a live job without an authoritative jobId`);
					const snapshot = this.#registry.get(JobId(resultJob.jobId), exec.agent?.id);
					if (snapshot.kind !== exec.name || snapshot.owner !== exec.agent.id) throw new Error("Native job ownership mismatch");
					const maximum = this.callbacks.backgroundMaxMs ? this.callbacks.backgroundMaxMs(exec, owner.binding) : 6e4;
					const requested = exec.arguments.timeoutMs;
					const timeout = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, maximum ?? Infinity) : maximum;
					if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Background command deadline is unavailable");
					row = {
						...row,
						nativeJob: {
							id: snapshot.id,
							startedAt: snapshot.startedAt,
							deadlineAt: timeout === null ? null : Date.now() + Math.ceil(timeout),
							status: snapshot.status
						}
					};
					const timer = timeout === null ? void 0 : setTimeout(() => {
						try {
							this.#assertJob(row, this.#registry.get(snapshot.id, exec.agent?.id));
							this.#registry.kill(snapshot.id, exec.agent?.id, "Fusion command deadline elapsed");
						} catch (error) {
							const live = this.#jobs.get(snapshot.id);
							if (live) this.#uncertain(live, error);
							else this.callbacks.failed(exec.agent, error);
						}
					}, timeout);
					timer?.unref();
					const live = {
						id,
						row,
						agent: exec.agent,
						timer
					};
					this.#jobs.set(snapshot.id, live);
					this.store.writeDocument(id, 1, row);
					if (snapshot.status !== "running" && snapshot.status !== "stopping") this.#settled(live, snapshot);
					return result;
				}
				this.store.writeDocument(id, 1, {
					...row,
					state: "returned",
					endedAt: (/* @__PURE__ */ new Date()).toISOString(),
					nativeIsError: Boolean(result.isError)
				});
				return result;
			} catch (error) {
				if (row.nativeJob && this.#jobs.has(row.nativeJob.id)) try {
					this.#registry.kill(JobId(row.nativeJob.id), exec.agent?.id, "Fusion job tracking failed");
				} catch (stopError) {
					this.callbacks.failed(exec.agent, stopError);
				}
				try {
					this.store.writeDocument(id, this.store.readDocument(id).revision, {
						...row,
						state: "outcome-unknown",
						endedAt: (/* @__PURE__ */ new Date()).toISOString()
					});
				} catch (recordingError) {
					this.callbacks.failed(exec.agent, recordingError);
				}
				this.callbacks.failed(exec.agent, error);
				throw error;
			} finally {
				this.#live.delete(exec.token);
			}
		}, { prepend: true });
		return () => {
			offTools();
			offJobs?.();
			for (const live of this.#jobs.values()) clearTimeout(live.timer);
		};
	}
	#settled(live, snapshot) {
		try {
			this.#assertJob(live.row, snapshot);
			if (snapshot.status === "running" || snapshot.status === "stopping") return;
			const row = this.store.readDocument(live.id);
			this.store.writeDocument(live.id, row.revision, {
				...live.row,
				nativeJob: {
					...live.row.nativeJob,
					status: snapshot.status,
					...snapshot.detail ? { detail: snapshot.detail } : {}
				},
				state: snapshot.status === "failed" ? "outcome-unknown" : "returned",
				endedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			if (snapshot.status === "failed") this.callbacks.failed(live.agent, /* @__PURE__ */ new Error("Native job failed without proven process quiescence"));
		} catch (error) {
			this.callbacks.failed(live.agent, error);
		} finally {
			clearTimeout(live.timer);
			this.#jobs.delete(snapshot.id);
		}
	}
	#assertJob(row, snapshot) {
		if (!row.nativeJob || row.processId !== process.pid || snapshot.id !== row.nativeJob.id || snapshot.kind !== row.toolName || snapshot.owner !== row.agentId || snapshot.startedAt !== row.nativeJob.startedAt) throw new Error("Native job identity changed; inspect rather than adopting or replaying it");
	}
	#uncertain(live, error) {
		clearTimeout(live.timer);
		this.#jobs.delete(live.row.nativeJob.id);
		try {
			const row = this.store.readDocument(live.id);
			this.store.writeDocument(live.id, row.revision, {
				...live.row,
				state: "outcome-unknown"
			});
		} catch (recordingError) {
			this.callbacks.failed(live.agent, recordingError);
		}
		this.callbacks.failed(live.agent, error);
	}
	backgroundProblem(exec) {
		if (!this.#registry || !exec.agent || !this.ctx.tools.get("job_output", exec.agent?.id) || !this.ctx.tools.get("job_kill", exec.agent?.id)) return "Background commands require the native jobs runtime and visible job_output/job_kill tools";
	}
	jobProblem(exec, taskId) {
		const id = exec.arguments.job_id;
		if (typeof id !== "string" || !exec.agent || !this.#registry) return "Native job identity is required";
		const record = this.store.listDocumentIds(`native-effect:${taskId}:`).map((key) => this.store.readDocument(key).value).find((row) => row.nativeJob?.id === id && row.agentId === exec.agent.id && row.taskId === taskId);
		if (!record) return "Only native jobs recorded for this Agent and current Fusion task may be accessed";
		try {
			this.#assertJob(record, this.#registry.get(JobId(id), exec.agent?.id));
		} catch (error) {
			return String(error);
		}
	}
	waitingForJob(agent) {
		return [...this.#waiters.values()].includes(agent);
	}
	onlyBackgroundPending(taskId) {
		const pending = this.pending(taskId);
		return pending.length > 0 && pending.every(({ id, record }) => record.state === "dispatch-started" && record.nativeJob && this.#jobs.get(record.nativeJob.id)?.id === id);
	}
	async stopJobs(taskId) {
		for (const live of [...this.#jobs.values()].filter((job) => job.row.taskId === taskId)) try {
			const id = JobId(live.row.nativeJob.id);
			this.#assertJob(live.row, this.#registry.get(id, live.agent.id));
			this.#registry.kill(id, live.agent.id, "Fusion task is stopping");
			const done = await this.#registry.wait(id, 1e4, live.agent.id);
			if (done.status === "running" || done.status === "stopping" || done.status === "failed") throw new Error("Native job did not prove process quiescence; keep the writer and inspect");
			if (this.#jobs.has(id)) this.#settled(live, done);
		} catch (error) {
			this.#uncertain(live, error);
			throw error;
		}
	}
	pending(taskId) {
		return this.store.listDocumentIds(`native-effect:${taskId}:`).flatMap((id) => {
			const record = this.store.readDocument(id).value;
			if (record.schemaVersion !== 1 || record.taskId !== taskId || !record.agentId || !record.toolName || !Number.isSafeInteger(record.processId) || record.processId <= 0 || ![
				"dispatch-started",
				"returned",
				"outcome-unknown",
				"inspected"
			].includes(record.state)) throw new Error("Native effect journal requires migration or inspection");
			if (record.nativeJob && (typeof record.nativeJob.id !== "string" || !Number.isSafeInteger(record.nativeJob.startedAt) || record.nativeJob.deadlineAt !== null && !Number.isSafeInteger(record.nativeJob.deadlineAt))) throw new Error("Native job journal requires migration or inspection");
			return record.state === "dispatch-started" || record.state === "outcome-unknown" ? [{
				id,
				record
			}] : [];
		});
	}
	assertInspection(taskId, effectsStopped) {
		const pending = this.pending(taskId);
		if (!pending.length) return;
		if ([...this.#live.values()].includes(taskId) || [...this.#jobs.values()].some((job) => job.row.taskId === taskId)) throw new Error("Native tool execution is still live; stop and settle it before recovery");
		if (!effectsStopped) throw new Error(`有 ${pending.length} 项原生操作在中断时未收尾。Host 退出不代表命令及子进程已停止。请先检查并停止这些操作，再使用 /fusion recover --effects-stopped <检查记录>。`);
		for (const { record } of pending) {
			if (record.processId === process.pid) continue;
			try {
				process.kill(record.processId, 0);
				throw new Error("The recorded effect owner is still live; settle it before recovery");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		}
	}
	inspected(taskId, evidence, effectsStopped) {
		this.assertInspection(taskId, effectsStopped);
		if (!evidence) throw new Error("Effect inspection evidence is required");
		for (const { id, record } of this.pending(taskId)) this.store.writeDocument(id, this.store.readDocument(id).revision, {
			...record,
			state: "inspected",
			inspectionEvidence: evidence,
			quiescenceBasis: "explicit-user-inspection"
		});
	}
};
//#endregion
//#region src/host/native-usage.ts
/** DSH counters are disjoint; missing provider fields retain unknown applicability. */
function billFromNativeUsage(usage) {
	const count = (value) => value === void 0 ? unknown() : known(value);
	return {
		uncachedInput: count(usage?.inputTokens),
		cacheRead: count(usage?.cacheReadTokens),
		output: count(usage?.outputTokens),
		cacheWrite: usage?.cacheWriteTokens === void 0 ? { kind: "unknown" } : {
			kind: "aggregate",
			rateKey: "provider-cache-write-rate-unknown",
			tokens: known(usage.cacheWriteTokens)
		},
		reasoning: {
			kind: "unknown",
			tokens: count(usage?.reasoningTokens)
		}
	};
}
/** Read-only stream observer. It neither changes requests nor orchestrates agents. */
function observeNativeUsage(ctx, store, ownerOf, auxiliary) {
	return ctx.on("llm/stream", async function* (options, next) {
		const agent = nativeRequestAgent(ctx, options);
		const owner = agent && ownerOf(agent);
		if (!owner || !agent) {
			yield* next();
			return;
		}
		const extra = auxiliary?.get(options);
		const id = `native:${randomUUID()}`;
		const key = {
			provider: options.provider,
			model: options.model,
			requestId: id,
			attemptId: id,
			contractDigest: digestOf({
				host: "0.1.5-rc.2",
				input: "disjoint",
				reasoning: "unknown",
				missing: "unknown"
			})
		};
		let ledger = newLedger(key);
		let revision = 0, summaryRevision = 0;
		let sequence = 0;
		let lastUsage;
		const record = {
			schemaVersion: 1,
			taskId: owner.taskId,
			sessionId: agent.id,
			role: owner.role,
			purpose: extra?.purpose ?? options.purpose ?? "conversation",
			nativeInvocationId: id,
			maxOutputTokens: options.maxTokens ?? null,
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...extra ? { auxiliary: {
				seriesId: extra.seriesId,
				iteration: extra.iteration
			} } : {},
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			endedAt: null,
			nativeStreamInvocations: 1,
			upstreamHttpCalls: null,
			outcome: "entered",
			ledger,
			actualSubscriptionChargeUsd: null,
			apiEquivalentCostUsd: null
		};
		const persist = () => {
			const value = {
				...record,
				ledger
			};
			[revision, summaryRevision] = store.writeDocuments([{
				id: `usage:${owner.taskId}:${id}`,
				expectedRevision: revision,
				value
			}, {
				id: `usage-index:${owner.taskId}:${id}`,
				expectedRevision: summaryRevision,
				value: usageSummary(value)
			}]);
		};
		persist();
		try {
			for await (const chunk of next()) {
				if (chunk.type === "usage") {
					lastUsage = chunk.usage;
					ledger = ingestDurable(ledger, {
						id: `${id}:${++sequence}`,
						key,
						sequence,
						mode: "snapshot",
						bill: billFromNativeUsage(lastUsage)
					});
					persist();
				}
				if (chunk.type === "finish") {
					const kind = chunk.reason.kind;
					record.outcome = [
						"stop",
						"tool-calls",
						"max-tokens",
						"aborted",
						"error"
					].includes(kind) ? kind : "unknown";
					record.endedAt = (/* @__PURE__ */ new Date()).toISOString();
					if ([
						"stop",
						"tool-calls",
						"max-tokens"
					].includes(kind) && lastUsage) ledger = ingestDurable(ledger, {
						id: `${id}:final`,
						key,
						sequence: ++sequence,
						mode: "final",
						bill: billFromNativeUsage(lastUsage)
					});
					persist();
				}
				yield chunk;
			}
		} finally {
			if (record.endedAt === null) {
				record.outcome = options.signal?.aborted ? "aborted" : "unknown";
				record.endedAt = (/* @__PURE__ */ new Date()).toISOString();
				persist();
			}
		}
	});
}
//#endregion
//#region src/host/native-auxiliary.ts
/** Plugin-local identity: do not widen or misuse the Host's purpose enum. */
var NativeAuxiliaryRequests = class {
	#requests = /* @__PURE__ */ new WeakMap();
	tag(request, metadata) {
		this.#requests.set(request, Object.freeze(metadata));
	}
	get(request) {
		return this.#requests.get(request);
	}
};
//#endregion
//#region src/host/native-keepalive.ts
/** R19 recovered schedule; one-token output is this plugin's conservative cap. */
const KEEPALIVE_INTERVAL_MS = 285e3;
const systemClock = {
	now: () => performance.now(),
	schedule: (callback, delay) => {
		const timer = setTimeout(callback, delay);
		timer.unref();
		return () => clearTimeout(timer);
	}
};
/** Retains only plugin-owned requests in memory; never replays timers on restart. */
/** Explicit per-role choice; unset is automatic for the Lead (armed only on observed cache reads), off for the Worker. */
function keepalivePolicy(binding, role) {
	return binding.profile.cacheKeepalive?.[role] ?? (role === "lead" ? "auto" : false);
}
var NativeCacheKeepalive = class {
	ctx;
	store;
	auxiliary;
	callbacks;
	clock;
	#series = /* @__PURE__ */ new Map();
	/** Start time of each agent's previous model request (real or ping): the wait before the next one. */
	#lastStart = /* @__PURE__ */ new Map();
	#pending = /* @__PURE__ */ new Map();
	#dispose = [];
	#closed = false;
	constructor(ctx, store, auxiliary, callbacks, clock = systemClock) {
		this.ctx = ctx;
		this.store = store;
		this.auxiliary = auxiliary;
		this.callbacks = callbacks;
		this.clock = clock;
	}
	#active(row) {
		if (this.#closed || this.#series.get(row.agent.id) !== row || row.controller.signal.aborted || this.ctx.agents.get(row.agent.id) !== row.agent) return false;
		const current = this.callbacks.owner(row.agent);
		return Boolean(current?.binding.selected && current.binding.taskId === row.owner.binding.taskId && current.binding.profile.digest === row.owner.binding.profile.digest && current.role === row.owner.role && this.#policy(current, row.input.provider, row.input.model).mode !== "off" && this.callbacks.allowed(row.agent, current));
	}
	#policy(owner, provider, model) {
		if (this.callbacks.policy) return this.callbacks.policy(owner, provider, model);
		const legacy = keepalivePolicy(owner.binding, owner.role);
		return {
			mode: legacy === true ? "on" : legacy === false ? "off" : "auto",
			intervalMs: KEEPALIVE_INTERVAL_MS
		};
	}
	#invalidate(row) {
		if (this.#series.get(row.agent.id) === row) this.#series.delete(row.agent.id);
		row.cancelTimer?.();
		row.cancelTimer = void 0;
		row.detachSourceAbort?.();
		row.detachSourceAbort = void 0;
		row.controller.abort();
	}
	#persist(row) {
		row.record.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		try {
			row.revision = this.store.writeDocument(`keepalive:${row.record.taskId}:${row.record.id}`, row.revision, row.record);
			return true;
		} catch (error) {
			this.#invalidate(row);
			this.callbacks.failed(row.agent, `Cache keepalive tracking failed: ${String(error)}`);
			return false;
		}
	}
	#stop(row, reason) {
		this.#invalidate(row);
		if (row.record.state === "stopped") return;
		row.record.state = "stopped";
		row.record.stopReason = reason;
		this.#persist(row);
	}
	stopSession(sessionId, reason) {
		const row = this.#series.get(sessionId);
		if (row) this.#stop(row, reason);
		return Promise.all([...this.#pending].filter(([, item]) => item.sessionId === sessionId).map(([pending]) => pending)).then(() => void 0);
	}
	stopTask(taskId, reason) {
		for (const row of this.#series.values()) if (row.record.taskId === taskId) this.#stop(row, reason);
		return Promise.all([...this.#pending].filter(([, item]) => item.taskId === taskId).map(([pending]) => pending)).then(() => void 0);
	}
	/** Called again after asynchronous context measurement, before spend admission. */
	assertRequest(agent, request) {
		const extra = this.auxiliary.get(request);
		if (!extra) return;
		const row = this.#series.get(agent.id);
		if (!row || row.record.id !== extra.seriesId || row.record.attempts !== extra.iteration || row.record.taskId !== extra.taskId || row.record.sessionId !== extra.sessionId || row.record.profileDigest !== extra.profileDigest || row.record.role !== extra.role || !this.#active(row)) throw new Error("Cache keepalive generation is no longer active");
		request.signal?.throwIfAborted();
	}
	#arm(row, deadline) {
		if (!this.#active(row)) {
			this.#stop(row, "inactive");
			return;
		}
		row.record.state = "scheduled";
		if (!this.#persist(row)) return;
		row.cancelTimer = this.clock.schedule(() => {
			row.cancelTimer = void 0;
			const pending = Promise.resolve().then(() => this.#ping(row)).finally(() => {
				this.#pending.delete(pending);
			});
			this.#pending.set(pending, {
				sessionId: row.agent.id,
				taskId: row.record.taskId
			});
		}, Math.max(0, deadline - this.clock.now()));
	}
	async #ping(row) {
		try {
			if (!this.#active(row)) {
				this.#stop(row, "inactive");
				return;
			}
			const nextDeadline = this.clock.now() + row.intervalMs;
			row.record.attempts++;
			row.record.state = "inflight";
			if (!this.#persist(row)) return;
			const request = {
				...structuredClone(row.input),
				maxTokens: 1,
				signal: row.controller.signal,
				messages: [...structuredClone(row.input.messages), createUserMessage({
					content: [{
						type: "text",
						text: "continue"
					}],
					source: { kind: "plugin:dsh-model-fusion" }
				})]
			};
			this.auxiliary.tag(request, {
				purpose: "cache-keepalive",
				taskId: row.record.taskId,
				sessionId: row.agent.id,
				profileDigest: row.owner.binding.profile.digest,
				role: row.owner.role,
				seriesId: row.record.id,
				iteration: row.record.attempts
			});
			let success = false;
			for await (const chunk of this.ctx.llm.stream(request)) if (chunk.type === "finish") success = [
				"stop",
				"max-tokens",
				"tool-calls"
			].includes(chunk.reason.kind);
			if (success) row.record.successes++;
			if (row.controller.signal.aborted || this.#series.get(row.agent.id) !== row) {
				this.#persist(row);
				return;
			}
			if (!success) {
				this.#stop(row, "request-failed");
				return;
			}
			if (row.record.attempts >= 11) {
				this.#stop(row, "attempt-limit");
				return;
			}
			this.#arm(row, nextDeadline);
		} catch {
			this.#stop(row, row.controller.signal.aborted ? "cancelled" : "request-failed");
		}
	}
	install() {
		const manager = this;
		this.#dispose.push(this.ctx.on("llm/stream", async function* (request, next) {
			const agent = nativeRequestAgent(manager.ctx, request), owner = agent && manager.callbacks.owner(agent);
			const extra = manager.auxiliary.get(request), ping = extra?.purpose === "cache-keepalive";
			if (!agent || !owner || !manager.callbacks.observe || extra && !ping || !ping && (!isAgentLoopRequest(request) || request.purpose !== void 0)) {
				yield* next();
				return;
			}
			const started = manager.clock.now(), previous = manager.#lastStart.get(agent.id);
			manager.#lastStart.set(agent.id, started);
			let usage;
			for await (const chunk of next()) {
				if (chunk.type === "usage") usage = chunk.usage;
				yield chunk;
			}
			if (!usage || previous === void 0) return;
			const cacheRead = usage.cacheReadTokens ?? 0, input = usage.inputTokens ?? 0;
			try {
				manager.callbacks.observe(owner, request.provider, request.model, {
					gapSeconds: (started - previous) / 1e3,
					ping,
					hit: cacheHit(cacheRead, input),
					cacheRead,
					input
				});
			} catch {}
		}));
		this.#dispose.push(this.ctx.on("llm/stream", async function* (request, next) {
			if (!manager.auxiliary.get(request) && (isAgentLoopRequest(request) || request.purpose === "compaction")) {
				const agent = nativeRequestAgent(manager.ctx, request);
				if (agent) await manager.stopSession(agent.id, request.purpose === "compaction" ? "compaction" : "new-generation");
			}
			yield* next();
		}, { prepend: true }));
		this.#dispose.push(this.ctx.on("llm/stream", async function* (request, next) {
			const agent = nativeRequestAgent(manager.ctx, request), owner = agent && manager.callbacks.owner(agent);
			const policy = owner ? manager.#policy(owner, request.provider, request.model) : void 0;
			if (!agent || !owner || !policy || policy.mode === "off" || manager.auxiliary.get(request) || !isAgentLoopRequest(request) || request.purpose !== void 0 || manager.#closed) {
				yield* next();
				return;
			}
			const input = structuredClone({
				provider: request.provider,
				model: request.model,
				messages: request.messages,
				tools: request.tools,
				system: request.system,
				temperature: request.temperature,
				reasoningEffort: request.reasoningEffort,
				stop: request.stop,
				sessionId: request.sessionId
			});
			const row = {
				agent,
				owner,
				input,
				started: manager.clock.now(),
				controller: new AbortController(),
				revision: 0,
				intervalMs: policy.intervalMs,
				record: {
					schemaVersion: 1,
					id: randomUUID(),
					taskId: owner.binding.taskId,
					sessionId: agent.id,
					role: owner.role,
					profileDigest: owner.binding.profile.digest,
					inputDigest: digestOf(input),
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
					state: "generating",
					attempts: 0,
					successes: 0
				}
			};
			manager.#series.set(agent.id, row);
			if (request.signal) {
				const abort = () => {
					manager.stopSession(agent.id, "native-cancel");
				};
				request.signal.addEventListener("abort", abort, { once: true });
				row.detachSourceAbort = () => request.signal.removeEventListener("abort", abort);
			}
			if (!manager.#persist(row)) throw new Error("Cache keepalive request tracking failed");
			let success = false, cached = policy.mode === "on";
			try {
				for await (const chunk of next()) {
					if (chunk.type === "finish") success = [
						"stop",
						"max-tokens",
						"tool-calls"
					].includes(chunk.reason.kind);
					if (chunk.type === "usage" && (chunk.usage.cacheReadTokens ?? 0) > 0) cached = true;
					yield chunk;
				}
			} finally {
				if (success && cached && !request.signal?.aborted && manager.#series.get(agent.id) === row) manager.#arm(row, row.started + row.intervalMs);
				else manager.#stop(row, cached ? "generation-stopped" : "no-cache-evidence");
			}
		}));
		this.#dispose.push(this.ctx.on("session/event", (session, event) => {
			if (event.type === "compaction/start") this.stopSession(session.id, "compaction");
			if (event.type !== "turn/end") return;
			const row = this.#series.get(session.id);
			if (row && (event.data.reason.kind !== "completed" || row.owner.role === "worker" || !this.#active(row))) this.stopSession(session.id, "agent-stopping");
		}));
		this.#dispose.push(this.ctx.on("agent/status", ({ status }) => {
			if (status !== "idle") return;
			for (const row of this.#series.values()) if (!this.#active(row)) this.stopSession(row.agent.id, "agent-idle");
		}));
		this.#dispose.push(this.ctx.on("agent/disposed", ({ agent }) => {
			this.#lastStart.delete(agent.id);
			this.stopSession(agent.id, "agent-disposed");
		}));
	}
	async close() {
		this.#closed = true;
		for (const row of this.#series.values()) this.#stop(row, "runtime-closing");
		await Promise.all(this.#pending.keys());
		for (const dispose of this.#dispose.reverse()) dispose();
	}
};
//#endregion
//#region src/host/native-worker.ts
/** Version-pinned public API adapter. It never calls an LLM adapter or runs a shell itself. */
var NativeWorkerTransport = class {
	ctx;
	provider;
	#flushed = /* @__PURE__ */ new WeakMap();
	constructor(ctx, provider = "spawn") {
		this.ctx = ctx;
		this.provider = provider;
	}
	assertAvailable() {
		const provider = this.ctx.subagents.getProvider(this.provider);
		if (!provider?.prepareContinuable || provider.inheritsParentContext !== false) throw new Error(`Fusion requires an independent continuable provider: ${this.provider}`);
	}
	/** Caller durably reserves the child and operation before entering this method. */
	async start(parent, request, signal) {
		this.assertAvailable();
		signal.throwIfAborted();
		if (this.ctx.agents.get(SessionId$1(request.childId))) throw new Error("Reserved Worker already exists; reconcile before retrying");
		const accepted = await this.ctx.subagents.startContinuable({
			provider: this.provider,
			label: request.label,
			childId: SessionId$1(request.childId),
			request: {
				parent,
				prompt: [{
					type: "text",
					text: request.brief
				}],
				persona: request.persona,
				agentOptions: {
					provider: request.route.provider,
					model: request.route.model,
					...request.route.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.route.reasoningEffort) }
				},
				toolFilter: { allow: [...request.allowedTools] },
				maxDepth: (parent.session.header.delegationDepth ?? 0) + 1
			},
			signal
		});
		if (accepted.childId !== request.childId) throw new Error("Native Worker identity changed during creation");
		return accepted;
	}
	/** Only Lead-authored feedback is sent through this public model-message API. */
	async continue(parent, childId, feedback, signal) {
		signal.throwIfAborted();
		return {
			childId,
			messageId: await this.ctx.subagents.sendMessage(parent, SessionId$1(childId), [{
				type: "text",
				text: feedback
			}], { signal })
		};
	}
	/**
	* Replace an in-flight generation through public cancellation, then deliver
	* to the same durable child. The caller must first exclude live/unknown
	* effectful tools. Otherwise use continue(), which steers at a step boundary.
	*/
	async interruptAndContinue(parent, childId, feedback, signal) {
		signal.throwIfAborted();
		await this.stop(parent, childId);
		signal.throwIfAborted();
		return this.continue(parent, childId, feedback, signal);
	}
	async settle(parent, childId, signal, yieldToSteering = false) {
		const child = this.#requireChild(parent, childId);
		let interruptError;
		let removeSteering = () => {};
		const interrupt = () => {
			try {
				this.ctx.subagents.interrupt(child.id, {
					kind: "ancestor",
					agent: parent
				});
			} catch (error) {
				interruptError = error;
			}
		};
		signal.addEventListener("abort", interrupt, { once: true });
		if (signal.aborted) interrupt();
		try {
			if (yieldToSteering && !signal.aborted) {
				const steering = new Promise((resolve) => {
					const check = () => {
						if (parent.inbox.nextStep.some((message) => message.source.kind === "user")) resolve(true);
					};
					removeSteering = parent.ctx.on("agent/inbox/inserted", ({ agent }) => {
						if (agent === parent) check();
					});
					check();
				});
				if (await Promise.race([child.whenIdle().then(() => false), steering]) && !signal.aborted && child.status !== "idle") return void 0;
			}
			await child.whenIdle();
			if (interruptError) throw interruptError;
			if (this.ctx.agents.get(child.id) !== child) throw new Error("Worker residency changed; quiescence requires reconciliation");
			if (!await this.ctx.sessions.flush(child.session)) throw new Error("Worker log persistence unavailable");
			this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0);
			return child;
		} finally {
			removeSteering();
			signal.removeEventListener("abort", interrupt);
		}
	}
	async stop(parent, childId) {
		const child = this.#requireChild(parent, childId);
		if (child.status === "idle" && this.#flushed.get(child) === (child.session.snapshotEvents().at(-1)?.seq ?? 0)) return child;
		this.ctx.subagents.interrupt(child.id, {
			kind: "ancestor",
			agent: parent
		});
		await child.whenIdle();
		if (this.ctx.agents.get(child.id) !== child) throw new Error("Worker residency changed during stop");
		if (!await this.ctx.sessions.flush(child.session)) throw new Error("Worker log persistence unavailable");
		this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0);
		return child;
	}
	/** Native release owns quiescence, persistence and handle disposal across HMR. */
	async release(parent, childId) {
		const child = this.ctx.agents.get(SessionId$1(childId));
		if (child && child.session.header.parentSession !== parent.id) throw new Error("Cannot release another Lead’s child");
		await this.ctx.subagents.drainContinuableChildren(parent, [SessionId$1(childId)]);
		if (this.ctx.agents.get(SessionId$1(childId))) throw new Error("Native Worker release did not prove absence");
	}
	#requireChild(parent, childId) {
		const child = this.ctx.agents.get(SessionId$1(childId));
		if (!child || child.session.header.parentSession !== parent.id) throw new Error("Worker is absent or is not this Lead’s child; reconcile its persisted session");
		return child;
	}
};
//#endregion
//#region src/host/native-activity.ts
const prefix = "activity-link:";
const visibleTools = new Set([
	"bash",
	"pwsh",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"job_output",
	"job_kill",
	"str_replace_editor"
]);
const parentPrefix = (parentId) => `activity:${encodeURIComponent(parentId)}:`;
const callPrefix = (parentId, callId) => `${parentPrefix(parentId)}${encodeURIComponent(callId)}:`;
/** Paginated read-only data for a plugin-owned tool view; no runtime activation. */
function readFusionActivity(store, parentId, callId, after = -1) {
	if (!Number.isSafeInteger(after) || after < -1) throw new Error("Invalid activity cursor");
	const rows = store.listDocumentIds(callPrefix(parentId, callId)).map((id) => store.readDocument(id).value).filter((row) => row.source.seq > after).sort((a, b) => a.source.seq - b.source.seq);
	const events = rows.slice(0, 100);
	const link = store.listDocumentIds(prefix).map((id) => store.readDocument(id).value).find((row) => row.parentId === parentId && row.callId === callId);
	return {
		events,
		cursor: events.at(-1)?.source.seq ?? after,
		more: rows.length > events.length,
		done: !link || link.done === true
	};
}
/** Old conversations remain readable through the public, non-activating history
* API. Correlate accepted message ids, never timing guesses or model narration.
* This fallback neither rewrites the old log nor creates a replacement Worker.
*/
async function readHistoricalFusionActivity(ctx, store, parentId, callId, after = -1) {
	const cached = readFusionActivity(store, parentId, callId, after);
	if (store.listDocumentIds(prefix).some((id) => {
		const row = store.readDocument(id).value;
		return row.parentId === parentId && row.callId === callId;
	}) || !parentId || !callId) return cached;
	const tasks = store.listTaskIds().map((id) => store.load(id)).filter((task) => task.parent === parentId);
	for (const task of tasks) {
		if (!task.acceptedChild) continue;
		const history = store.events(task.taskId);
		const prepared = history.find((event) => event.type === "work-order/prepared" && event.causeId === callId);
		const delivery = store.listDocumentIds(`worker-delivery:${task.taskId}:`).map((id) => store.readDocument(id).value).find((row) => row.causeId === callId && row.state === "accepted");
		const accepted = prepared && history.find((event) => event.type === "child/accepted" && event.seq > prepared.seq);
		const messageId = delivery?.messageId ?? (accepted?.type === "child/accepted" ? accepted.payload.messageId : void 0);
		if (!messageId) continue;
		const [parent, child] = await Promise.all([ctx.sessionQuery.readSession(SessionId$1(parentId)), ctx.sessionQuery.readSession(SessionId$1(task.acceptedChild))]);
		if (child.session.parentSession !== parentId) throw new Error("Fusion activity child ownership mismatch");
		const call = parent.events.find((event) => event.type === "tool/call" && event.data.callId === callId);
		if (!call || call.type !== "tool/call" || ![
			"fusion_explore",
			"fusion_delegate",
			"fusion_rework"
		].includes(call.data.name)) return cached;
		const start = child.events.find((event) => event.type === "user/message" && event.data.id === messageId);
		if (!start) return cached;
		const acceptedIds = new Set(tasks.flatMap((item) => store.events(item.taskId).flatMap((event) => event.type === "child/accepted" && event.payload.child === task.acceptedChild ? [event.payload.messageId] : [])));
		const end = child.events.find((event) => event.seq > start.seq && event.type === "user/message" && acceptedIds.has(event.data.id))?.seq ?? Infinity;
		const calls = /* @__PURE__ */ new Set();
		const all = [];
		for (const source of child.events) {
			if (source.seq <= start.seq) continue;
			if (source.type === "tool/call" && source.seq < end && visibleTools.has(source.data.name)) calls.add(source.data.callId);
			else if (source.type !== "tool/result" || !calls.has(source.data.message.source.callId)) continue;
			if (source.type !== "tool/call" && source.type !== "tool/result") continue;
			all.push({
				schemaVersion: 1,
				taskId: task.taskId,
				childSessionId: task.acceptedChild,
				parentCallId: callId,
				turn: call.data.turn,
				step: call.data.step,
				anchorSeq: call.seq,
				source
			});
		}
		const remaining = all.filter((event) => event.source.seq > after), events = remaining.slice(0, 100);
		return {
			events,
			cursor: events.at(-1)?.source.seq ?? after,
			more: remaining.length > events.length,
			done: task.control.mode === "completed" || child.events.at(-1)?.type === "turn/end"
		};
	}
	return cached;
}
/** Copies actual Worker tool events into plugin-owned presentation storage only.
* Model history still contains solely the Lead's native messages and reports.
* Stored source coordinates make replay/HMR idempotent without executing tools.
*/
var NativeFusionActivity = class {
	ctx;
	store;
	#dispose = [];
	#pending = Promise.resolve();
	#seen = /* @__PURE__ */ new WeakMap();
	#calls = /* @__PURE__ */ new WeakMap();
	errors = /* @__PURE__ */ new Map();
	constructor(ctx, store) {
		this.ctx = ctx;
		this.store = store;
		this.#dispose.push(ctx.on("session/event", (session, event) => {
			if (!session.header.parentSession) return;
			if (event.type === "turn/end") {
				this.#enqueue(() => this.#ended(session));
				return;
			}
			if (event.type !== "tool/call" && event.type !== "tool/result") return;
			this.#enqueue(() => this.#mirror(session, event, false));
		}));
		this.#dispose.push(ctx.on("agent/created", ({ agent }) => {
			this.#replay(agent.session);
			for (const child of ctx.sessions.list()) if (child.header.parentSession === agent.id) this.#replay(child);
		}));
		for (const session of ctx.sessions.list()) this.#replay(session);
	}
	/** Called before each native delivery. No inference, dispatch or approval. */
	link(parent, childId, taskId, callId) {
		const call = parent.snapshotEvents().find((event) => event.type === "tool/call" && event.data.callId === callId);
		if (!call || call.type !== "tool/call") return;
		const id = `${prefix}${childId}:${call.seq}`;
		if (this.store.readDocument(id)) return;
		this.store.writeDocument(id, 0, {
			parentId: parent.id,
			childId,
			taskId,
			callId,
			turn: call.data.turn,
			step: call.data.step,
			anchorSeq: call.seq,
			fromSeq: this.ctx.sessions.get(SessionId$1(childId))?.seq ?? null
		});
	}
	#enqueue(action) {
		this.#pending = this.#pending.then(action).catch((error) => {
			this.errors.set("presentation", String(error));
			this.ctx.logger.warn("Fusion activity presentation failed: %s", String(error));
		});
	}
	#replay(session) {
		if (!session.header.parentSession) return;
		this.#enqueue(() => {
			for (const event of session.snapshotEvents()) {
				if (event.type === "tool/call" || event.type === "tool/result") this.#mirror(session, event, true);
				if (event.type === "turn/end") this.#ended(session, event.seq, false);
			}
		});
	}
	#ended(child, throughSeq = child.seq, live = true) {
		for (const id of this.store.listDocumentIds(`${prefix}${child.id}:`)) {
			const row = this.store.readDocument(id), link = row.value;
			if ((link.fromSeq === null ? live : link.fromSeq <= throughSeq) && !link.done) this.store.writeDocument(id, row.revision, {
				...link,
				done: true
			});
		}
	}
	#mirror(child, event, replay) {
		const parent = child.header.parentSession && this.ctx.sessions.get(child.header.parentSession);
		if (!parent) return;
		let seen = this.#seen.get(parent), calls = this.#calls.get(parent);
		if (!seen || !calls) {
			seen = /* @__PURE__ */ new Set();
			calls = /* @__PURE__ */ new Map();
			for (const id of this.store.listDocumentIds(parentPrefix(parent.id))) {
				const activity = this.store.readDocument(id).value;
				seen.add(`${activity.childSessionId}:${activity.source.seq}`);
				if (activity.source.type === "tool/call") calls.set(`${activity.childSessionId}:${activity.source.data.callId}`, activity);
			}
			this.#seen.set(parent, seen);
			this.#calls.set(parent, calls);
		}
		const key = `${child.id}:${event.seq}`;
		if (seen.has(key)) return;
		const sourceCallId = event.type === "tool/call" ? event.data.callId : event.data.message.source.callId;
		const callKey = `${child.id}:${sourceCallId}`;
		let origin = calls.get(callKey);
		if (event.type === "tool/call") {
			if (!visibleTools.has(event.data.name)) return;
			const row = this.store.listDocumentIds(`${prefix}${child.id}:`).map((id) => ({
				id,
				...this.store.readDocument(id)
			})).filter((row) => row.value.parentId === parent.id).sort((a, b) => b.value.anchorSeq - a.value.anchorSeq).find((row) => {
				const link = row.value;
				return link.fromSeq === null ? !replay : event.seq >= link.fromSeq;
			});
			if (!row) return;
			let link = row.value;
			if (link.fromSeq === null) {
				link = {
					...link,
					fromSeq: event.seq
				};
				this.store.writeDocument(row.id, row.revision, link);
			}
			origin = {
				schemaVersion: 1,
				taskId: link.taskId,
				childSessionId: child.id,
				parentCallId: link.callId,
				turn: link.turn,
				step: link.step,
				anchorSeq: link.anchorSeq + .5 - .5 / (event.seq + 2)
			};
		}
		if (!origin) return;
		const activity = {
			...origin,
			source: event
		};
		const id = `${callPrefix(parent.id, origin.parentCallId)}${String(event.seq).padStart(12, "0")}`;
		if (!this.store.readDocument(id)) this.store.writeDocument(id, 0, activity);
		seen.add(key);
		if (event.type === "tool/call") calls.set(callKey, activity);
	}
	async flush() {
		await this.#pending;
	}
	async close() {
		for (const dispose of this.#dispose.splice(0).reverse()) dispose();
		await this.flush();
	}
};
//#endregion
//#region src/host/native-exploration.ts
/** Bounded, source-backed handoff. No commands, guessed snippets or verification claims. */
function captureExploration(store, order, snapshot, submitted, sources) {
	if (order.mode !== "explore" || order.baseSnapshot !== snapshot.id) throw new Error("Exploration workspace changed; inspect and explore again");
	if (sources.length > 12 || submitted.status === "completed" && !sources.length) throw new Error("A completed exploration requires 1–12 source ranges");
	let total = 0;
	const captured = sources.map((source) => {
		const path = workspacePath(snapshot.root, source.path);
		const entry = snapshot.entries.find((entry) => entry.path === source.path && entry.kind === "file");
		if (!entry) throw new Error("Exploration sources must be files in the frozen workspace manifest");
		if (!Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || source.endLine - source.startLine >= 80) throw new Error("Exploration source ranges require 1–80 lines each");
		const bytes = readFileSync(path);
		if (sha256Hex(bytes) !== entry.digest) throw new Error("Exploration source changed during capture");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (content.includes("\0")) throw new Error("Exploration sources must be text files");
		const lines = content.split("\n");
		if (source.endLine > lines.length) throw new Error("Exploration source range exceeds the file");
		const text = lines.slice(source.startLine - 1, source.endLine).join("\n");
		total += Buffer.byteLength(text, "utf8");
		if (total > 24e3) throw new Error("Exploration excerpts exceed 24000 bytes; select narrower ranges");
		return {
			...source,
			fileDigest: entry.digest,
			excerpt: store.putArtifact(order.taskId, Buffer.from(text), "text/plain")
		};
	});
	return {
		schemaVersion: 1,
		workOrderId: order.id,
		revision: order.revision,
		...submitted,
		snapshot: snapshot.id,
		sources: captured
	};
}
//#endregion
//#region src/host/model-output.ts
/** Public model metadata only; resolving limits does not start a model turn. */
async function resolveModelOutputLimits(ctx, provider, model) {
	const info = await ctx.llm.resolveModelInfo(provider, model);
	const contextWindow = info.context?.contextWindow;
	if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0) throw new Error("The configured model does not disclose a usable context window");
	fittedOutputReservation(Number(contextWindow));
	return {
		contextWindow: Number(contextWindow),
		defaultMaxTokens: info.defaultMaxTokens
	};
}
//#endregion
//#region src/host/change-evidence.ts
/** Read only the exact leaf described by the snapshot, never its symlink target. */
function readEntry(snapshot, entry) {
	if (realpathSync.native(snapshot.root) !== snapshot.root) throw new Error("Evidence workspace root changed");
	const path = join(workspacePath(snapshot.root, dirname(entry.path)), basename(entry.path));
	const before = lstatSync(path);
	let bytes;
	if (entry.kind === "symlink") {
		if (!before.isSymbolicLink()) throw new Error("Evidence file kind changed");
		bytes = readlinkSync(path, { encoding: "buffer" });
	} else {
		if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("Evidence file is not a bounded regular source file");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("Evidence source changed while opening");
			bytes = Buffer.alloc(opened.size);
			let offset = 0;
			while (offset < bytes.length) {
				const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
				if (!count) throw new Error("Evidence source shrank while reading");
				offset += count;
			}
			if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error("Evidence source grew while reading");
			const after = fstatSync(fd);
			if (after.size !== bytes.length || after.mtimeMs !== opened.mtimeMs) throw new Error("Evidence source changed while reading");
		} finally {
			closeSync(fd);
		}
	}
	const after = lstatSync(path);
	if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || entry.kind === "file" && Boolean(after.mode & 73) !== entry.executable || sha256Hex(bytes) !== entry.digest) throw new Error("Evidence bytes do not match the frozen snapshot");
	workspacePath(snapshot.root, dirname(entry.path));
	if (realpathSync.native(snapshot.root) !== snapshot.root) throw new Error("Evidence workspace root changed");
	return bytes;
}
function captureChangeBase(store, taskId, base, allowed) {
	const entries = base.entries.filter((entry) => pathAllowed(entry.path, allowed));
	const refs = store.putArtifacts(taskId, entries.map((entry) => ({
		bytes: readEntry(base, entry),
		mediaType: "application/octet-stream"
	})));
	return {
		schemaVersion: 1,
		snapshot: base.id,
		contents: Object.fromEntries(entries.map((entry, i) => [entry.path, refs[i]]))
	};
}
function quotePath(path) {
	const bytes = Buffer.from(path);
	if (bytes.every((byte) => byte > 32 && byte < 127 && byte !== 34 && byte !== 92)) return path;
	return "\"" + Array.from(bytes, (byte) => byte === 34 || byte === 92 ? "\\" + String.fromCharCode(byte) : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : "\\" + byte.toString(8).padStart(3, "0")).join("") + "\"";
}
const mode = (entry) => entry.kind === "symlink" ? "120000" : entry.executable ? "100755" : "100644";
/** A full, applicable single hunk, trimmed only at unchanged leading/trailing lines. */
function patch(path, before, after, oldText, newText) {
	const a = quotePath(`a/${path}`), b = quotePath(`b/${path}`);
	let output = `diff --git ${a} ${b}\n`;
	if (!before) output += `new file mode ${mode(after)}\n`;
	else if (!after) output += `deleted file mode ${mode(before)}\n`;
	else if (mode(before) !== mode(after)) output += `old mode ${mode(before)}\nnew mode ${mode(after)}\n`;
	if (oldText === newText) return output;
	const oldLines = oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [], newLines = newText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let prefix = 0, suffix = 0;
	while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
	while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
	const start = Math.max(0, prefix - 3), oldEnd = oldLines.length - Math.max(0, suffix - 3), newEnd = newLines.length - Math.max(0, suffix - 3);
	const line = (tag, value) => tag + value + (value.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
	output += `--- ${before ? a : "/dev/null"}\n+++ ${after ? b : "/dev/null"}\n@@ -${oldEnd === start ? 0 : start + 1},${oldEnd - start} +${newEnd === start ? 0 : start + 1},${newEnd - start} @@\n`;
	for (let i = start; i < prefix; i++) output += line(" ", oldLines[i]);
	for (let i = prefix; i < oldLines.length - suffix; i++) output += line("-", oldLines[i]);
	for (let i = prefix; i < newLines.length - suffix; i++) output += line("+", newLines[i]);
	for (let i = oldLines.length - suffix; i < oldEnd; i++) output += line(" ", oldLines[i]);
	return output;
}
function saveChangeManifest(store, taskId, base, candidate, captured) {
	if (captured && (captured.schemaVersion !== 1 || captured.snapshot !== base.id)) throw new Error("Change evidence belongs to another base snapshot");
	const changes = changedPaths(base, candidate);
	const old = new Map(base.entries.map((entry) => [entry.path, entry])), now = new Map(candidate.entries.map((entry) => [entry.path, entry]));
	const baseRefs = changes.flatMap((path) => {
		const ref = old.has(path) && captured && Object.hasOwn(captured.contents, path) ? captured.contents[path] : void 0;
		return ref ? [ref] : [];
	});
	const baseBytes = new Map(store.readArtifacts(taskId, baseRefs.map((ref) => ref.id)).map((bytes, i) => [baseRefs[i].id, bytes]));
	const pending = [];
	const prepared = changes.map((path) => {
		const before = old.get(path), after = now.get(path);
		const beforeRef = before && captured && Object.hasOwn(captured.contents, path) ? captured.contents[path] : void 0;
		const oldBytes = beforeRef ? baseBytes.get(beforeRef.id) : void 0;
		if (beforeRef && (!before || beforeRef.digest !== before.digest || sha256Hex(oldBytes) !== before.digest)) throw new Error("Change evidence does not match the base file");
		if (before && captured && !beforeRef) throw new Error("Frozen change evidence is missing the base file");
		const newBytes = after ? readEntry(candidate, after) : void 0;
		const afterIndex = pending.length;
		if (newBytes) pending.push({
			bytes: newBytes,
			mediaType: "application/octet-stream"
		});
		const oldText = oldBytes ? evidenceText(oldBytes) : "", newText = newBytes ? evidenceText(newBytes) : "";
		const status = before && !beforeRef ? "unavailable-base" : before && after && before.kind !== after.kind ? "type-change" : oldText === void 0 || newText === void 0 ? "binary" : "text";
		const patchIndex = pending.length;
		if (status === "text") pending.push({
			bytes: Buffer.from(patch(path, before, after, oldText, newText)),
			mediaType: "text/x-diff"
		});
		return {
			path,
			status,
			before,
			beforeRef,
			after,
			afterIndex,
			patchIndex
		};
	});
	const refs = store.putArtifacts(taskId, pending);
	const diffs = prepared.map((item) => ({
		path: item.path,
		status: item.status,
		...item.before ? { before: {
			entry: item.before,
			...item.beforeRef ? { content: item.beforeRef } : {}
		} } : {},
		...item.after ? { after: {
			entry: item.after,
			content: refs[item.afterIndex]
		} } : {},
		...item.status === "text" ? { patch: refs[item.patchIndex] } : {}
	}));
	return store.putArtifact(taskId, Buffer.from(JSON.stringify({
		schemaVersion: 2,
		base: base.id,
		changes,
		diffs,
		candidate
	})), "application/vnd.dsh-fusion.change-manifest+json");
}
//#endregion
//#region src/host/native-evidence.ts
/** Coverage uses logical receipt IDs; ordinary evidence uses content digests. */
function readNativeEvidence(store, taskId, id) {
	if (!id.startsWith("receipt:")) return store.readArtifact(taskId, id);
	const match = /^receipt:(fusion-check-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id);
	if (!match) throw new Error("Invalid native check receipt id");
	const { check, receipt, evidence } = store.readDocument(`check-invocation:${taskId}:${match[1]}`)?.value ?? {};
	if (!check?.plan || !check.definition || !receipt?.evidence || !evidence || receipt.id !== id || check.plan.taskId !== taskId || evidence.taskId !== taskId || evidence.nativeToolCallId !== match[1] || evidence.operationId !== match[1] || receipt.planDigest !== digestOf(check.plan) || digestOf(receipt.evidence) !== digestOf(evidence) || evidence.argvDigest !== check.plan.argvDigest || evidence.cwdDigest !== check.plan.cwdDigest) throw new Error("Native check receipt unavailable or invalid for this task");
	const refs = [evidence.stdout, evidence.stderr];
	if (refs.some((ref) => !ref || ref.ownerTaskId !== taskId || String(ref.id) !== ref.digest || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0)) throw new Error("Invalid check output ownership or reference");
	if (store.readArtifacts(taskId, refs.map((ref) => ref.id)).some((bytes, index) => bytes.byteLength !== refs[index].bytes)) throw new Error("Invalid check output length");
	return Buffer.from(JSON.stringify({
		kind: "check-receipt",
		check,
		receipt
	}));
}
//#endregion
//#region src/host/coordinator.ts
const textOutput = {
	schema: { type: "string" },
	render: (_args, text) => [{
		type: "text",
		text
	}]
};
const stringList = {
	type: "array",
	items: { type: "string" },
	required: true
};
const optionalStringList = {
	type: "array",
	items: { type: "string" }
};
const READ_TOOLS = new Set([
	"fusion_read_state",
	"glob",
	"grep",
	"read",
	"fusion_read_evidence",
	"job_output"
]);
const isRead = (exec) => READ_TOOLS.has(exec.name) || exec.name === "str_replace_editor" && exec.arguments.command === "view";
const FUSION_TOOLS = new Set([
	"fusion_read_state",
	"fusion_delegate_text",
	"fusion_explore",
	"fusion_delegate",
	"fusion_rework",
	"fusion_wait",
	"fusion_review_result",
	"fusion_submit_result",
	"fusion_takeover",
	"fusion_finish_direct",
	"fusion_read_evidence"
]);
const STUB_REVIEW = /^(?:placeholder|todo|tbd|n\/?a|none|ok|okay|lgtm|done|accept(?:ed)?|looks good|fine|test)\.?$/i;
/** At least a sentence that is not a stock stub. */
function substantiveReview(reason) {
	const text = reason.trim();
	return text.length >= 20 && !STUB_REVIEW.test(text);
}
/** Fill the defaults a Lead may omit; an explicit test kind without a parser still fails in freezeChecks. */
function normalizeChecks(raw) {
	return raw.map((check, index) => {
		const parser = check.parser ?? (check.kind === "test" ? void 0 : "exit-code");
		const kind = check.kind ?? (parser && parser !== "exit-code" ? "test" : "static-check");
		return {
			id: check.id?.trim() || `check-${index + 1}`,
			description: check.description?.trim() || check.command,
			command: check.command,
			kind,
			parser,
			definitionPaths: check.definitionPaths ?? [],
			...check.timeoutSeconds === void 0 ? {} : { timeoutSeconds: check.timeoutSeconds },
			...check.baseline === void 0 ? {} : { baseline: check.baseline }
		};
	});
}
/** Consecutive read-only calls allowed before a model must act; the Lead delegates broad reading. */
const READ_STREAK = {
	lead: 25,
	worker: 60
};
/** A few lines stay natural for the Lead; anything larger goes to the Sidekick. */
const LEAD_DIRECT_WRITE = {
	perCall: 30,
	perTask: 80
};
const lineCount = (text) => typeof text === "string" && text.length ? text.split("\n").length : 0;
/** Lines a Lead tool call would write; 0 for reads and ordinary commands. */
function directWriteLines(exec) {
	const args = exec.arguments ?? {};
	if (exec.name === "write") return lineCount(args.content);
	if (exec.name === "edit") return lineCount(args.new_string);
	if (exec.name === "str_replace_editor") return lineCount(args.file_text) || lineCount(args.new_str);
	if (isShellTool(exec.name) && typeof args.command === "string") return /<<-?\s*['"]?\w+/.test(args.command) || /[@]["']\s*\r?\n/.test(args.command) || /(^|[^>&0-9])>{1,2}\s*[^\s&|]/.test(args.command) && args.command.includes("\n") || /\b(Set-Content|Add-Content|Out-File|Tee-Object)\b/i.test(args.command) ? Math.max(1, lineCount(args.command)) : 0;
	return 0;
}
/**
* The Worker is the cheap model: a real task needs room to explore, run and fix.
* Stopping it early pushes work back to the expensive Lead or the user.
*/
const DEFAULT_POLICY = {
	maxWorkerSteps: 150,
	maxReworkRounds: 3,
	commandMaxSeconds: 600
};
/** Whitespace-insensitive, otherwise exact: a requirement must be the user's own words. */
const normalizeQuote = (text) => text.replace(/\s+/g, " ").trim();
/** Literal code spans (`like this`) a requirement asks for; a candidate that omits them gets flagged. */
const literalSpans = (text) => [...new Set([...text.matchAll(/`([^`\n]{2,120})`/g)].map((match) => match[1]))];
/** The enforced-v3 Lead's fixed catalog (order is part of the cached prompt prefix). */
const SEPARATED_LEAD_TOOLS = [...new Set([
	...READ_TOOLS,
	nativeShellTool,
	...[...FUSION_TOOLS].filter((name) => ![
		"fusion_takeover",
		"fusion_submit_result",
		"fusion_finish_direct"
	].includes(name))
])];
/** Test files by common conventions (Python, JS/TS, Go, Rust and generic test directories). */
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)conftest\.py$/i;
/**
* Existing test files whose original lines were removed or changed (pure additions are not listed). A Worker
* that rewrites an old test to fit its change hides a regression the maintainers' test would catch
* (round 4, canvasapi): the Lead must look at these before accepting.
*/
function rewrittenTests(store, taskId, root, changeBase, changes) {
	if (!changeBase) return [];
	return changes.filter((path) => TEST_FILE.test(path) && Object.hasOwn(changeBase.contents, path)).flatMap((path) => {
		const original = Buffer.from(store.readArtifacts(taskId, [changeBase.contents[path].id])[0]).toString("utf8");
		let current = "";
		try {
			current = readFileSync(workspacePath(root, path), "utf8");
		} catch {
			return [{
				path,
				removedLines: original.split("\n").filter((line) => line.trim()).length,
				deleted: true
			}];
		}
		const remaining = /* @__PURE__ */ new Map();
		for (const line of current.split("\n")) if (line.trim()) remaining.set(line.trim(), (remaining.get(line.trim()) ?? 0) + 1);
		let removed = 0;
		for (const line of original.split("\n")) {
			const key = line.trim();
			if (!key) continue;
			const count = remaining.get(key) ?? 0;
			if (count) remaining.set(key, count - 1);
			else removed++;
		}
		return removed ? [{
			path,
			removedLines: removed
		}] : [];
	});
}
/** Native AgentLoop owns work; optional auxiliary calls use the public LLM service. */
var FusionCoordinator = class {
	ctx;
	store;
	options;
	bindings;
	scopes;
	transport;
	activity;
	leases;
	taskContext;
	onDemand;
	approvals;
	effects;
	keepalive;
	/** Per-model cache keepalive settings, evidence and defaults (shared with the settings API). */
	cachePolicy;
	#auxiliary = new NativeAuxiliaryRequests();
	#dispose = [];
	#nestedChecks = /* @__PURE__ */ new Map();
	#reads = /* @__PURE__ */ new Map();
	#held = /* @__PURE__ */ new Map();
	#installErrors = /* @__PURE__ */ new Map();
	#trackingErrors = /* @__PURE__ */ new Map();
	#leadMutations = /* @__PURE__ */ new Map();
	#stoppingTasks = /* @__PURE__ */ new Map();
	#backgroundStops = /* @__PURE__ */ new Map();
	#closing = false;
	modelControl;
	workflow;
	roleSandbox;
	constructor(ctx, store, options) {
		this.ctx = ctx;
		this.store = store;
		this.options = options;
		this.bindings = new BindingRepository(store);
		this.workflow = new NativeWorkflow(store);
		this.roleSandbox = new NativeRoleSandbox(ctx, store, (id) => this.bindings.read(id)?.binding);
		this.transport = new NativeWorkerTransport(ctx);
		this.activity = new NativeFusionActivity(ctx, store);
		this.leases = new WorkspaceWriteLease(options.leaseRoot);
		this.taskContext = new NativeTaskContext(store, (id) => ctx.agents.get(SessionId$1(id)));
		this.onDemand = new NativeOnDemandContext(store, this.taskContext);
		const notices = new NativeWorkerNotices(store);
		this.scopes = new NativeFusionScopes({
			route: (binding, role) => this.modelControl?.route(binding, role) ?? binding.profile[role],
			beforeTurn: (agent, binding, role) => {
				const previous = this.state(binding.taskId);
				if (role !== "lead" || previous.control.mode !== "completed") return binding;
				if (!binding.workerId && previous.acceptedChild) this.bindings.assignWorker(agent.id, binding.taskId, previous.acceptedChild);
				const nextTask = TaskId(randomUUID());
				this.#createTask(agent, nextTask, {
					profile: binding.profile,
					prompts: binding.prompts
				});
				return this.bindings.rollover(agent.id, binding.taskId, nextTask);
			},
			taskContext: (agent, binding, role) => binding.profile.interactionMode === "model-like" ? this.onDemand.message(agent, binding, role) : this.taskContext.message(agent, binding, role),
			beforeStep: (agent, binding, role) => {
				if (role !== "lead") return;
				notices.projectHistory(agent, binding);
				this.#acknowledgeUserRetry(agent, binding.taskId);
			},
			projectMessage: (agent, binding, role, message) => role === "lead" ? notices.project(agent, binding, message) : message,
			canAccess: (agent, binding, role) => this.#accessBlocked(agent, binding, role),
			canRequest: (agent, binding, role) => this.#requestBlocked(agent, binding, role),
			canExecute: (exec, binding, role) => this.#toolBlocked(exec, binding, role),
			modelLimits: (provider, model) => resolveModelOutputLimits(this.ctx, provider, model),
			beforeRequest: (agent, turn, step, binding, role) => {
				this.options.authorizeRequest(agent, binding, role, turn, step);
				this.roleSandbox.ensure(agent, binding, role, role === "lead" && this.#leadWriter(binding, agent));
				const state = this.state(binding.taskId);
				if (role === "lead" && state.activeReviewTicket) captureNativeReviewRequest(store, agent, turn, step, state.activeReviewTicket);
				if (role === "worker") try {
					captureWorkerBrief(store, binding.taskId, agent, turn, step, this.#runtime(binding.taskId).briefRevision ?? 0);
				} catch (error) {
					this.#trackingFailed(agent, `Worker brief tracking failed: ${String(error)}`);
					throw error;
				}
			},
			installTools: (scope, agent, _binding, role) => this.#tools(scope, agent, role),
			readOnlyTools: (agent, binding, role) => {
				const state = this.state(binding.taskId);
				if (role === "lead" && adaptiveWorkflow(binding) && state.control.mode === "completed" && !roleSeparated(binding)) return [];
				if (role === "worker") return state.currentWorkOrder?.mode === "text" ? [] : state.currentWorkOrder?.mode === "explore" ? this.options.workerTools.filter((name) => READ_TOOLS.has(name)) : void 0;
				const lease = this.#held.get(binding.taskId);
				if (roleSeparated(binding)) return this.#leadWriter(binding, agent) ? void 0 : this.#separatedLeadTools(state, binding);
				if (enforcedWorkflow(binding)) {
					if (adaptiveWorkflow(binding) && !state.currentWorkOrder) return void 0;
					if (state.currentWorkOrder && this.#runtime(binding.taskId).takeover && lease?.holder === SessionId(agent.id) && this.leases.stillHeld(lease)) return void 0;
					return [...READ_TOOLS, ...FUSION_TOOLS].filter((name) => {
						if (adaptiveWorkflow(binding) && state.currentWorkOrder) {
							if (name === "fusion_delegate_text" || name === "fusion_explore") return false;
							if (name === "fusion_delegate" || name === "fusion_finish_direct") return state.currentWorkOrder.mode === "explore" && state.phase === "PLANNING" && state.exploration?.status === "completed";
							if (name === "fusion_review_result") return state.phase === "REVIEWING";
							if (name === "fusion_wait") return state.phase === "WORKER_RUNNING";
						}
						return name !== "fusion_submit_result" && (name !== "fusion_takeover" || state.currentWorkOrder?.mode !== "text" && state.currentWorkOrder?.mode !== "explore" && state.reviewResult?.decision === "rework");
					});
				}
				if (binding.profile.interactionMode === "model-like" && !state.currentWorkOrder) return void 0;
				return state.control.mode === "running" && lease?.holder === SessionId(agent.id) && this.leases.stillHeld(lease) ? void 0 : [...READ_TOOLS, ...FUSION_TOOLS];
			}
		});
		this.approvals = new NativeApprovals(ctx, store, {
			owner: (agent) => this.owner(agent),
			state: (id) => this.state(id),
			pending: (id, approval) => {
				this.append(id, "approval/pending", { approval });
			},
			answered: (id, approvalId, state) => {
				this.append(id, "approval/answered", {
					approvalId,
					state
				});
			},
			failed: (agent, error) => this.#trackingFailed(agent, `Fusion approval tracking failed: ${String(error)}`)
		});
		this.#dispose.push(this.approvals.install());
		this.#dispose.push(this.roleSandbox.install());
		this.effects = new NativeEffects(ctx, store, {
			owner: (agent) => this.owner(agent),
			track: (exec) => !isRead(exec) && !FUSION_TOOLS.has(exec.name),
			backgroundMaxMs: (_exec, binding) => binding.profile.interactionMode === "model-like" ? null : (this.state(binding.taskId).currentWorkOrder?.policy.commandMaxSeconds ?? this.options.commandMaxSeconds ?? DEFAULT_POLICY.commandMaxSeconds) * 1e3,
			failed: (agent, error) => this.#trackingFailed(agent, `Fusion native effect tracking failed: ${String(error)}`)
		});
		this.#dispose.push(this.effects.install());
		this.#dispose.push(ctx.on("tools/execute", async (exec, next) => {
			const owner = exec.agent && this.owner(exec.agent);
			if (owner?.role !== "lead" || !FUSION_TOOLS.has(exec.name) || isRead(exec)) return next();
			const taskId = owner.binding.taskId;
			if (this.#leadMutations.has(taskId)) throw new Error("Another Fusion control call is active; issue delegation, steering, wait and takeover sequentially");
			this.#leadMutations.set(taskId, exec.token);
			try {
				return await next();
			} finally {
				if (this.#leadMutations.get(taskId) === exec.token) this.#leadMutations.delete(taskId);
			}
		}));
		this.#dispose.push(ctx.on("agent/created", async ({ agent }) => {
			this.#attachKnown(agent);
		}));
		this.#dispose.push(ctx.tools.guard((exec) => {
			if (!exec.agent) return void 0;
			if (this.owner(exec.agent)) try {
				this.scopes.assertReady(exec.agent);
			} catch (error) {
				return String(error);
			}
			if (!isRead(exec) && !FUSION_TOOLS.has(exec.name) && exec.name !== "run_code") {
				const cwd = exec.agent.session.header.cwd;
				if (cwd) {
					const lease = this.leases.current(cwd);
					if (lease && lease.holder !== SessionId(exec.agent.id)) return `Workspace writer is ${lease.holder}; this Agent is read-only`;
				}
			}
		}));
		this.cachePolicy = new CachePolicy(store);
		this.keepalive = new NativeCacheKeepalive(ctx, store, this.#auxiliary, {
			owner: (agent) => this.owner(agent),
			allowed: (agent, owner) => {
				const state = this.state(owner.binding.taskId);
				if (digestOf(this.modelControl?.route(owner.binding, owner.role) ?? owner.binding.profile[owner.role]) !== digestOf(owner.binding.profile[owner.role])) return false;
				if (state.control.mode !== "running" || this.#requestBlocked(agent, owner.binding, owner.role)) return false;
				if (agent.status === "running") return true;
				if (owner.role !== "lead") return false;
				const childId = state.acceptedChild ?? state.reservedChild;
				const child = childId && ctx.agents.get(SessionId$1(childId));
				return Boolean(child && child.status === "running");
			},
			failed: (agent, reason) => this.#trackingFailed(agent, reason),
			policy: (owner, provider, model) => {
				const policy = this.cachePolicy.resolve(provider, model, owner.role, owner.binding.profile.cacheKeepalive?.[owner.role]);
				return {
					mode: policy.mode,
					intervalMs: policy.intervalSeconds * 1e3
				};
			},
			observe: (owner, provider, model, sample) => this.cachePolicy.observe(provider, model, sample, this.cachePolicy.resolve(provider, model, owner.role, owner.binding.profile.cacheKeepalive?.[owner.role]).intervalSeconds)
		}, options.keepaliveClock);
		this.#dispose.push(observeNativeUsage(ctx, store, (agent) => {
			const owner = this.owner(agent);
			return owner ? {
				taskId: owner.binding.taskId,
				role: owner.role
			} : void 0;
		}, this.#auxiliary));
		const context = new NativeContextGuard(ctx, store, (agent) => this.owner(agent), (owner, reason) => {
			if (this.state(owner.binding.taskId).control.mode === "running") this.append(owner.binding.taskId, "task/paused", { reason });
		}, this.taskContext, this.#auxiliary, (binding, role) => this.modelControl.route(binding, role));
		this.#dispose.push(context.install((_agent, owner, request) => {
			options.reserveRequest?.(request, owner.binding, owner.role);
		}, (agent, request) => {
			this.scopes.assertReady(agent);
			this.keepalive.assertRequest(agent, request);
			const owner = this.owner(agent);
			if (owner && owner.binding.profile.interactionMode !== "model-like") this.taskContext.assertPresent(agent, owner.binding, owner.role, request);
			if (owner?.role === "worker" && owner.binding.profile.interactionMode !== "model-like") assertWorkerBriefRequest(store, owner.binding.taskId, request);
		}));
		this.modelControl = new NativeModelControl(ctx, store, {
			owner: (agent) => this.owner(agent),
			resolve: async (id) => {
				const live = ctx.agents.get(SessionId$1(id));
				if (live) return live;
				const result = await ctx.sessionController.resolveAgent(SessionId$1(id));
				if ("error" in result) throw new Error(result.error.message);
				return result.agent;
			},
			pause: (agent) => this.pause(agent),
			resume: (agent) => this.resume(agent, options.resumeAuthorization?.(this.bindings.read(agent.id).binding) ?? "native-account"),
			settled: (binding) => {
				const state = this.state(binding.taskId);
				return !this.effects.pending(binding.taskId).length && !state.control.recovering && !state.control.outcomeUnknown && !state.control.pendingApprovalIds.length;
			},
			stopAuxiliary: (binding) => {
				this.keepalive.stopTask(binding.taskId, "provider-unavailable");
			}
		});
		this.#dispose.push(ctx.on("tools/result", (exec, result) => {
			const owner = exec.agent && this.owner(exec.agent);
			if (!owner || !enforcedWorkflow(owner.binding)) return;
			try {
				if (this.workflow.observe(exec, result, owner.binding, owner.role, isRead(exec))) {
					if (!this.workflow.repairProgress(exec.agent, owner.binding, owner.role)) this.modelControl.failure(owner.binding, owner.role, {
						code: "NO_PROGRESS",
						message: "Repeated unchanged results after a local replanning opportunity"
					});
				}
			} catch (error) {
				this.#trackingFailed(exec.agent, `Workflow observation failed: ${String(error)}`);
			}
		}));
		this.#dispose.push(ctx.on("agent/turn-stopping", ({ agent, signal }) => {
			const owner = this.owner(agent);
			if (!owner || !enforcedWorkflow(owner.binding) || signal.aborted || this.#accessBlocked(agent, owner.binding, owner.role)) return;
			const { binding, role } = owner, state = this.state(binding.taskId);
			let instruction;
			if (role === "lead" && state.phase === "REVIEWING") instruction = "The current report has not been accepted. Inspect its evidence and call fusion_review_result; failed checks cannot be accepted. Use needs-decision for a genuine missing user decision.";
			else if (role === "lead" && adaptiveWorkflow(binding) && state.phase === "REWORK") instruction = "Your review requires a correction. Send the specific feedback to the same Sidekick through fusion_rework; do not end the task before the correction and its checks. If a real user decision is missing, explain it explicitly.";
			else if (role === "worker" && state.currentWorkOrder && !this.#runtime(binding.taskId).submitted) instruction = "Submit the current work through fusion_submit_result with its actual status and unresolved requirements. Prose alone cannot complete this work order.";
			else if (role === "lead" && !state.currentWorkOrder && this.workflow.deniedEffect(binding)) instruction = "A requested effect was blocked and has not executed. Delegate it through fusion_delegate, or explain the blocker. This task cannot be recorded as completed by a text-only response.";
			if (!instruction) return;
			if (!this.workflow.repairStop(agent, binding, role, instruction)) this.modelControl.failure(binding, role, {
				code: "WORKFLOW_INCOMPLETE",
				message: "The required workflow transition is still missing after one repair opportunity"
			});
		}));
		this.keepalive.install();
		this.#dispose.push(ctx.on("session/event", (session, event) => {
			if (event.type !== "compaction/end") return;
			const agent = ctx.agents.get(SessionId$1(session.id)), owner = agent && this.owner(agent);
			if (!agent || owner?.binding.profile.interactionMode !== "model-like") return;
			const message = this.onDemand.message(agent, owner.binding, owner.role);
			if (message) agent.session.append("user/message", message, { surfaceOp: "append" });
		}));
		this.#dispose.push(ctx.on("session/event", (session, event) => {
			if (event.type !== "user/message" || event.data.source && event.data.source.kind !== "user") return;
			const binding = this.bindings.read(session.id)?.binding;
			if (!binding?.selected) return;
			const id = `task-index:${binding.taskId}`, row = store.readDocument(id);
			const value = row?.value;
			const title = event.data.content.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim().replace(/\s+/g, " ").slice(0, 160);
			if (row && value?.title === "对话任务" && title) store.writeDocument(id, row.revision, {
				...value,
				title
			});
		}));
		this.#dispose.push(ctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end") return;
			const binding = this.bindings.read(session.id)?.binding;
			if (!binding?.selected) return;
			const state = this.state(binding.taskId);
			if (event.data.reason.kind !== "completed") {
				if (state.currentWorkOrder && this.#runtime(binding.taskId).background) {
					const parent = ctx.agents.get(SessionId$1(session.id));
					if (parent) this.#stopBackground(parent, binding);
				}
				return;
			}
			if (state.currentWorkOrder || state.control.mode !== "running" || this.modelControl.blocked(binding, "lead")) return;
			if (state.lease && binding.profile.interactionMode !== "model-like") return;
			if (this.effects.pending(binding.taskId).length) return;
			try {
				this.#release(binding.taskId);
				this.append(binding.taskId, "intent/chosen", { intent: "DIRECT" });
				this.append(binding.taskId, "task/completed", {
					verification: "unverified",
					snapshot: SnapshotId(`conversation:${digestOf({
						sessionId: session.id,
						turn: event.data.turn,
						eventSeq: event.seq
					})}`)
				});
			} catch (error) {
				this.#installErrors.set(session.id, String(error));
			}
		}));
		for (const binding of this.bindings.selected()) {
			const state = this.state(binding.taskId);
			const pendingDispatch = this.store.outbox(binding.taskId).some((row) => row.kind === "native-worker" && [
				"prepared",
				"dispatched",
				"accepted"
			].includes(row.state));
			const uncertainCheck = this.store.listDocumentIds(`check-invocation:${binding.taskId}:`).some((id) => {
				const row = this.store.readDocument(id)?.value;
				return row?.evidence?.state === "started" || row?.evidence?.state === "outcome-unknown";
			});
			const interruptedCompaction = this.store.listDocumentIds(`context-recovery:${binding.taskId}:`).some((id) => (this.store.readDocument(id)?.value)?.state === "started");
			const interruptedApproval = this.store.listDocumentIds(`native-approval:${binding.taskId}:`).some((id) => (this.store.readDocument(id)?.value)?.state === "pending");
			const interruptedEffect = this.effects.pending(binding.taskId).length > 0;
			const uncertainBrief = this.store.listDocumentIds(`worker-delivery:${binding.taskId}:`).some((id) => (this.store.readDocument(id)?.value)?.state === "prepared");
			const detachedWorker = (this.store.readDocument(`runtime:${binding.taskId}`)?.value)?.background;
			if ((state.lease || pendingDispatch || uncertainCheck || interruptedCompaction || interruptedApproval || interruptedEffect || uncertainBrief || detachedWorker || state.pendingApprovalIds.length) && state.control.mode !== "completed" && !state.control.recovering) this.append(binding.taskId, "recovery/needed", { reason: "Host runtime was replaced with a recorded writer, pending dispatch/approval, uncertain check or unfinished compaction" });
		}
		for (const agent of ctx.agents.list()) this.#attachKnown(agent);
	}
	state(id) {
		const state = this.store.load(id);
		if (!state) throw new Error("Fusion task is missing; reconcile durable state");
		return state;
	}
	append(id, type, payload) {
		const state = this.state(id);
		const event = {
			schemaVersion: 1,
			id: randomUUID(),
			taskId: id,
			seq: state.seq + 1,
			revision: state.revision,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			causeId: "native-fusion",
			type,
			payload
		};
		const next = this.store.append(id, state.revision, [event]);
		const parent = this.ctx.agents.get(SessionId$1(next.parent));
		if (parent && this.scopes.get(parent)?.binding.taskId === id) this.scopes.refreshTools(parent);
		if (next.control.mode !== "running" || next.control.budgetBlocked || next.control.recovering || next.control.outcomeUnknown || next.control.pendingApprovalIds.length) this.keepalive?.stopTask(id, "task-gated");
		return next;
	}
	owner(agent) {
		const selected = this.bindings.read(agent.id)?.binding;
		if (selected?.selected) return {
			binding: selected,
			role: "lead"
		};
		const row = this.store.readDocument(`child:${agent.id}`)?.value;
		if (!row || row.parent !== agent.session.header.parentSession || typeof row.parent !== "string") return void 0;
		const binding = this.bindings.read(row.parent)?.binding;
		return binding?.selected && binding.taskId === row.taskId ? {
			binding,
			role: "worker"
		} : void 0;
	}
	async select(agent, resolved = this.options.profile) {
		this.transport.assertAvailable();
		if (agent.session.header.parentSession) throw new Error("Fusion selection is available on top-level sessions only");
		await agent.runMaintenance(async () => {
			this.selectBeforeAssembly(agent, resolved);
		});
	}
	/** Only at idle selection or native running reservation, before prompt assembly. */
	selectBeforeAssembly(agent, resolved) {
		if (agent.session.header.parentSession) throw new Error("Fusion requires a top-level session");
		this.transport.assertAvailable();
		if (this.bindings.read(agent.id)?.binding.selected) return;
		const taskId = TaskId(randomUUID());
		this.#createTask(agent, taskId, resolved);
		const binding = this.bindings.select(agent.id, taskId, resolved);
		this.modelControl.reset(binding);
		this.scopes.install(agent, binding, "lead");
	}
	#createTask(agent, taskId, resolved) {
		this.store.create({
			schemaVersion: 1,
			id: randomUUID(),
			taskId,
			seq: 1,
			revision: 1,
			type: "task/created",
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			causeId: "model-selector",
			payload: {
				parent: SessionId(agent.id),
				selection: {
					kind: "profile",
					profileId: resolved.profile.id
				}
			}
		});
		this.append(taskId, "profile/frozen", {
			digest: resolved.profile.digest,
			profileId: resolved.profile.id,
			version: resolved.profile.version
		});
		this.taskContext.begin(agent, taskId);
	}
	async clear(agent) {
		const binding = this.bindings.read(agent.id)?.binding;
		if (!binding?.selected) return;
		if (agent.status !== "idle") throw new Error("Stop the current turn before changing the execution profile");
		this.modelControl.cancel(binding, "Fusion 已退出");
		await this.keepalive.stopTask(binding.taskId, "selection-cleared");
		await this.#backgroundStops.get(binding.taskId);
		await agent.runMaintenance(async () => {
			const state = this.state(binding.taskId);
			const workerId = binding.workerId ?? state.acceptedChild;
			const child = workerId && this.ctx.agents.get(SessionId$1(workerId));
			await this.#stopJobs(binding.taskId, async () => {
				if (child) {
					await this.transport.release(agent, child.id);
					this.scopes.detach(child);
				}
			});
			if (this.#trackingErrors.has(binding.taskId) || state.control.recovering || state.control.outcomeUnknown) throw new Error("Reconcile the recorded effects before clearing Fusion");
			this.#release(binding.taskId);
			this.scopes.detach(agent);
			this.bindings.clear(agent.id);
			if (roleSeparated(binding)) this.roleSandbox.restore(agent);
		});
	}
	#attachKnown(agent) {
		const owner = this.owner(agent);
		if (!owner) return;
		try {
			this.scopes.install(agent, owner.binding, owner.role);
			this.#installErrors.delete(agent.id);
		} catch (error) {
			this.#installErrors.set(agent.id, String(error));
		}
	}
	#trackingFailed(agent, reason) {
		try {
			const taskId = this.owner(agent)?.binding.taskId;
			if (!taskId) this.#installErrors.set(agent.id, reason);
			else {
				this.#trackingErrors.set(taskId, reason);
				try {
					if (!this.state(taskId).control.recovering) this.append(taskId, "recovery/needed", { reason });
				} catch (error) {
					this.#trackingErrors.set(taskId, `${reason}; recovery state could not be persisted: ${String(error)}`);
				}
			}
		} catch (error) {
			this.#installErrors.set(agent.id, `${reason}; task identity could not be read: ${String(error)}`);
		} finally {
			agent.cancel({
				kind: "hook",
				reason
			}, { keepInbox: true });
		}
	}
	#accessBlocked(agent, binding, role) {
		const unavailable = this.modelControl?.blocked(binding, role);
		if (unavailable) return unavailable;
		if (this.#closing) return "Fusion runtime is closing";
		if (this.#stoppingTasks.has(binding.taskId)) return "Fusion native effects are stopping";
		const failed = this.#installErrors.get(agent.id);
		if (failed) return failed;
		const trackingFailure = this.#trackingErrors.get(binding.taskId);
		if (trackingFailure) return trackingFailure;
		const state = this.state(binding.taskId), control = state.control;
		if (control.mode === "completed" && role === "lead") return void 0;
		if (control.mode !== "running" || control.budgetBlocked || control.recovering || control.outcomeUnknown || control.pendingApprovalIds.length) return `Fusion execution is gated: ${state.phase}`;
		if (role === "worker") {
			if (this.#runtime(binding.taskId).submitted) return "Worker report was submitted; wait for Lead feedback";
		}
	}
	#requestBlocked(agent, binding, role) {
		const blocked = this.#accessBlocked(agent, binding, role);
		if (blocked) return blocked;
		if (role === "worker") {
			if (this.#workerStepLimit(binding.taskId)) return "Worker step limit reached";
			if (this.#workerQuotaStop(binding.taskId)) return "Worker provider quota exhausted; waiting for user input";
		}
	}
	#workerStepLimit(taskId, limit = this.state(taskId).currentWorkOrder?.policy.maxWorkerSteps ?? DEFAULT_POLICY.maxWorkerSteps) {
		if (this.bindings.read(this.state(taskId).parent)?.binding.profile.interactionMode === "model-like") return void 0;
		const requests = this.store.listDocumentIds(`usage:${taskId}:`).map((id) => this.store.readDocument(id).value).filter((row) => row.role === "worker" && (row.purpose === void 0 || row.purpose === "conversation")).length;
		return requests >= limit ? {
			requests,
			limit
		} : void 0;
	}
	#latestUserSeq(agent) {
		return agent.session.snapshotEvents().findLast((event) => event.type === "user/message" && (event.data.source === void 0 || event.data.source.kind === "user"))?.seq ?? 0;
	}
	#clearWorkerFailure(taskId) {
		const runtime = this.store.readDocument(`runtime:${taskId}`)?.value;
		const failure = runtime?.workerFailure;
		if (runtime && failure) this.#saveRuntime({
			...runtime,
			workerFailure: void 0,
			workerFailureClearedThrough: {
				childId: failure.childId,
				eventSeq: failure.eventSeq
			}
		});
	}
	#acknowledgeUserRetry(agent, taskId) {
		const runtime = this.store.readDocument(`runtime:${taskId}`)?.value;
		if (runtime?.workerFailure && this.#latestUserSeq(agent) > runtime.workerFailure.userSeq) this.#clearWorkerFailure(taskId);
	}
	#rememberWorkerFailure(agent, binding) {
		const state = this.state(binding.taskId), childId = state.acceptedChild;
		const child = childId && this.ctx.agents.get(SessionId$1(childId));
		if (!state.currentWorkOrder || !child || child.status !== "idle" || this.effects.pending(binding.taskId).length) return;
		const end = child.session.snapshotEvents().findLast((event) => event.type === "turn/end");
		if (!end || end.type !== "turn/end" || end.data.reason.kind !== "error") return;
		const runtime = this.#runtime(binding.taskId), cleared = runtime.workerFailureClearedThrough;
		if (runtime.workerFailure?.childId === child.id && runtime.workerFailure.eventSeq === end.seq || cleared?.childId === child.id && cleared.eventSeq >= end.seq) return;
		const error = end.data.reason.error;
		const code = error.code && /^[A-Z0-9_-]{1,64}$/i.test(error.code) ? error.code : void 0;
		const quota = [
			"QUOTA",
			"INSUFFICIENT_QUOTA",
			"BILLING_HARD_LIMIT_REACHED"
		].includes(code?.toUpperCase() ?? "") || code === "RATE_LIMIT" && /insufficient_quota|billing_hard_limit_reached|\bquota\s+(?:exceeded|exhausted)\b|Token Plan 用量上限/i.test(error.message);
		this.#saveRuntime({
			...runtime,
			workerFailure: {
				workOrderId: state.currentWorkOrder.id,
				childId: child.id,
				eventSeq: end.seq,
				userSeq: this.#latestUserSeq(agent),
				category: quota ? "quota-exhausted" : "provider-error",
				...code ? { code } : {}
			}
		});
	}
	#workerQuotaStop(taskId) {
		const state = this.state(taskId);
		const failure = (this.store.readDocument(`runtime:${taskId}`)?.value)?.workerFailure;
		return failure?.category === "quota-exhausted" && failure.workOrderId === state.currentWorkOrder?.id && failure.childId === state.acceptedChild ? failure : void 0;
	}
	#recordWorkerStepStop(taskId, spent) {
		const state = this.state(taskId), child = state.acceptedChild && this.ctx.agents.get(SessionId$1(state.acceptedChild));
		if (!state.currentWorkOrder || child && child.status !== "idle" || this.effects.pending(taskId).length) return;
		const runtime = this.#runtime(taskId);
		const workerStepStop = {
			workOrderId: state.currentWorkOrder.id,
			...spent
		};
		if (digestOf(runtime.workerStepStop ?? null) !== digestOf(workerStepStop)) this.#saveRuntime({
			...runtime,
			workerStepStop
		});
	}
	#assertWorkerCapacity(taskId, limit) {
		const spent = this.#workerStepLimit(taskId, limit);
		if (!spent) return;
		this.#recordWorkerStepStop(taskId, spent);
		throw new Error(`Worker step limit reached (${spent.requests}/${spent.limit}); no feedback or new work order was sent. Existing reports and counters are retained. Do not retry Worker feedback; collect any still-settling response with fusion_wait, explain unfinished work, and await a user decision.`);
	}
	#toolBlocked(exec, binding, role) {
		if (!exec.agent) return "Fusion tools require a native Agent";
		const blocked = this.#accessBlocked(exec.agent, binding, role);
		if (blocked) return blocked;
		if (binding.profile.interactionMode === "model-like" && !enforcedWorkflow(binding)) {
			const stalled = this.#readStreak(exec, role);
			if (stalled) return stalled;
		}
		const state = this.state(binding.taskId);
		if (exec.name === "job_list") return "Use the recorded job id; Fusion does not expose jobs outside the current task";
		if (exec.name === "job_output" || exec.name === "job_kill") {
			const issue = this.effects.jobProblem(exec, binding.taskId);
			if (issue) return issue;
		}
		if (state.control.mode === "completed") return "This task is completed; begin a new task before using tools";
		if (role === "lead" && [
			"fusion_delegate",
			"fusion_delegate_text",
			"fusion_explore",
			"fusion_rework",
			"fusion_takeover"
		].includes(exec.name) && this.modelControl.waiting(binding, "worker") && !(exec.name === "fusion_takeover" && this.#escalation(binding)) && !(exec.name !== "fusion_takeover" && this.modelControl.leadRecover(binding, "worker"))) return "Sidekick is unavailable; preserve its task and use the local Fusion controls to continue or replace its model. Do not retry delegation or take over automatically.";
		if (role === "worker" && !isRead(exec)) {
			const problem = workerToolBriefProblem(this.store, binding.taskId, exec, this.#runtime(binding.taskId).briefRevision ?? 0);
			if (problem) return problem;
		}
		if (role === "worker" && state.currentWorkOrder?.mode === "text" && ![
			"fusion_submit_result",
			"fusion_read_state",
			"fusion_read_evidence"
		].includes(exec.name)) return "Text delegation has no external tools; prepare the result from the supplied material";
		if (role === "worker" && state.currentWorkOrder?.mode === "explore" && !isRead(exec) && exec.name !== "fusion_submit_result") return "Exploration is read-only: use file search/read tools and fusion_submit_result with source ranges; no shell, edits or run_code";
		if (binding.profile.interactionMode === "model-like" && !isRead(exec)) {
			const restore = this.onDemand.blocked(exec.agent, binding);
			if (restore) return restore;
		}
		if (roleSeparated(binding) && role === "lead") {
			const separated = this.#separatedLeadGuard(exec, binding);
			if (separated !== false) return separated;
		}
		if (enforcedWorkflow(binding) && role === "lead" && !isRead(exec) && !FUSION_TOOLS.has(exec.name) && (!adaptiveWorkflow(binding) || state.currentWorkOrder)) {
			const nested = this.#nestedChecks.get(exec.callId);
			const check = isShellTool(exec.name) && nested?.agent === exec.agent && nested.parent === exec.parent;
			const takeover = state.currentWorkOrder && this.#runtime(binding.taskId).takeover;
			if (!check && !takeover) return this.workflow.denyEffect(binding);
		}
		if (isRead(exec) || FUSION_TOOLS.has(exec.name) || exec.name === "run_code") return void 0;
		if (binding.profile.interactionMode === "model-like" && !enforcedWorkflow(binding) && role === "lead") {
			const refused = this.#leadWriteBoundary(exec, binding);
			if (refused) return refused;
		}
		if (binding.profile.interactionMode === "model-like" && role === "lead" && !state.currentWorkOrder && !this.#held.has(binding.taskId)) {
			const root = exec.agent.session.header.cwd;
			if (!root && (isShellTool(exec.name) || [
				"write",
				"edit",
				"str_replace_editor"
			].includes(exec.name))) return "This native file operation needs a workspace";
			if (!root) return void 0;
			this.append(binding.taskId, "intent/chosen", { intent: "DIRECT" });
			try {
				this.#acquire(binding, root, exec.agent.id, OperationId(randomUUID()));
			} catch (error) {
				return String(error);
			}
		}
		const lease = this.#held.get(binding.taskId);
		if (!lease || lease.holder !== SessionId(exec.agent.id) || !this.leases.stillHeld(lease)) return "Acquire the workspace write lease before effectful tools";
		if ([
			"write",
			"edit",
			"str_replace_editor"
		].includes(exec.name)) {
			const args = exec.arguments, raw = args.file_path ?? args.path;
			if (typeof raw !== "string") return "A native edit must identify its workspace path";
			const path = isAbsolute(raw) ? relative(lease.workspaceId, raw) : raw;
			try {
				workspacePath(lease.workspaceId, path);
			} catch (error) {
				return String(error);
			}
			if (state.currentWorkOrder && !pathAllowed(path, state.currentWorkOrder.allowedPaths)) return "The edit is outside frozen allowedPaths";
		}
		if (isShellTool(exec.name)) {
			const args = exec.arguments;
			if (args.run_in_background) {
				const issue = this.effects.backgroundProblem(exec);
				if (issue) return issue;
			}
			if (args.workdir && args.workdir !== lease.workspaceId) return "Shell commands must use the frozen project root";
			const nested = this.#nestedChecks.get(exec.callId);
			if (role === "lead" && state.intent === "DELEGATE" && !this.#runtime(binding.taskId).takeover && (!nested || nested.agent !== exec.agent || nested.parent !== exec.parent)) return "Lead is reviewing; use the native acceptance checks or request takeover";
		}
	}
	/**
	* Prompts alone did not stop a capable Lead from writing whole implementations
	* itself (A/B 2026-09-24: zero delegations). The Lead stays a normal model for
	* conversation, lookups, commands and small edits; larger writing is refused
	* with a pointer to the Sidekick, which is the point of pairing a cheaper model.
	*/
	#leadWriteBoundary(exec, binding) {
		const lines = directWriteLines(exec);
		if (!lines) return void 0;
		const key = `lead-direct:${binding.taskId}`, prior = this.store.readDocument(key);
		const spent = (prior?.value)?.lines ?? 0;
		if (lines > LEAD_DIRECT_WRITE.perCall || spent + lines > LEAD_DIRECT_WRITE.perTask) return `Direct Lead writing is for small edits (this call ${lines} lines; this task ${spent}/${LEAD_DIRECT_WRITE.perTask} lines, at most ${LEAD_DIRECT_WRITE.perCall} per call). You are the more expensive model: delegate this implementation to the Sidekick with fusion_delegate (goal, constraints, allowedPaths, checks), then review its result. If the user explicitly requires you to write it yourself, explain that Fusion hands larger writing to its Sidekick and that a single model can be selected instead.`;
		this.store.writeDocument(key, prior?.revision ?? 0, {
			schemaVersion: 1,
			taskId: binding.taskId,
			lines: spent + lines
		});
	}
	/**
	* Successful calls can loop too (seen live: a Lead read a file one line per
	* call for 130+ calls). Consecutive reads with no action in between are
	* refused past a role-specific bound, so the model must decide with what it has.
	*/
	#readStreak(exec, role) {
		const id = exec.agent.id, limit = READ_STREAK[role];
		if (exec.name === "fusion_read_state" || exec.name === "job_output") return void 0;
		if (!isRead(exec)) {
			this.#reads.delete(id);
			return;
		}
		const count = (this.#reads.get(id) ?? 0) + 1;
		this.#reads.set(id, count);
		if (count <= limit) return void 0;
		return `${count - 1} consecutive read-only calls without any other action. Stop reading and act on what you already know: ` + (role === "lead" ? "answer, delegate or record fusion_review_result with the evidence you have. Broad reading belongs to the Sidekick." : "implement, run the check, or submit your report with what remains unresolved.");
	}
	/**
	* enforced-v3 role separation: the Lead never holds execution tools. It may
	* read, run shell commands the Host confines to read-only, and coordinate.
	* Every change goes through the Sidekick. The only exception is a takeover the
	* Host unlocks from objective state (#escalation), never the Lead's choice.
	*/
	#separatedLeadTools(_state, binding) {
		return this.#escalation(binding) ? [...SEPARATED_LEAD_TOOLS, "fusion_takeover"] : SEPARATED_LEAD_TOOLS;
	}
	/** undefined = allow now, string = refuse, false = not decided here (continue the ordinary guard). */
	#separatedLeadGuard(exec, binding) {
		if (this.#leadWriter(binding, exec.agent)) return exec.name === "fusion_finish_direct" ? "Submit the correction with fusion_submit_result; the frozen checks decide" : false;
		if (exec.name === "fusion_takeover" && this.#escalation(binding)) return false;
		if (exec.name === "fusion_takeover") return `FUSION_LEAD_READ_ONLY: takeover unlocks only when the Host sees the Sidekick cannot finish: 2 rework rounds with checks still failing (after you record a rework review), its step limit, or repeated stalls. Until then send corrections with fusion_rework.`;
		if (exec.name === "fusion_submit_result" || exec.name === "fusion_finish_direct") return "FUSION_LEAD_READ_ONLY: in this Fusion mode the Lead never writes. Send corrections to the same Sidekick with fusion_rework.";
		if (isRead(exec) || FUSION_TOOLS.has(exec.name)) return false;
		const nested = this.#nestedChecks.get(exec.callId);
		if (isShellTool(exec.name) && nested && nested.agent === exec.agent && nested.parent === exec.parent) return false;
		if (isShellTool(exec.name) && exec.arguments.run_in_background === true) {
			this.workflow.denyEffect(binding);
			return "FUSION_LEAD_READ_ONLY: the Lead runs only short foreground inspection commands. Test runs and long commands belong to the Sidekick: delegate them.";
		}
		const shell = isShellTool(exec.name) ? this.roleSandbox.leadShellProblem(exec) : void 0;
		if (isShellTool(exec.name) && !shell) return void 0;
		this.workflow.denyEffect(binding);
		if (shell) return shell;
		return "FUSION_LEAD_READ_ONLY: in this Fusion mode the Lead only reads and runs read-only commands. Every workspace change, file write or code execution goes to the Sidekick: use fusion_delegate (or fusion_delegate_text for writing without a workspace).";
	}
	/**
	* enforced-v3 escalation: why the Host lets the Lead take over the current implementation, from objective
	* state only. A persistent failure after ESCALATE_AFTER_REWORKS rework rounds, the Worker's step limit, or a
	* Worker that stalled again after the Lead's bounded redirects. Quota and credential stops stay with the user.
	*/
	#escalation(binding) {
		try {
			return this.#escalationOf(binding);
		} catch {
			return;
		}
	}
	#escalationOf(binding) {
		if (!roleSeparated(binding)) return void 0;
		const state = this.state(binding.taskId), order = state.currentWorkOrder;
		if (!order || order.mode !== "implement" || state.control.mode === "completed" || !this.store.readDocument(`runtime:${binding.taskId}`)) return void 0;
		const runtime = this.#runtime(binding.taskId);
		if (runtime.takeover) return (runtime.leadSubmissions ?? 0) < 3 && !this.#held.has(binding.taskId) ? runtime.escalation : void 0;
		if (runtime.workerStepStop?.workOrderId === order.id) return "worker-step-limit";
		if (this.modelControl.recoveriesExhausted(binding, "worker")) return "worker-stalled";
		if (runtime.submitted && state.reviewResult?.decision === "rework" && runtime.reworkRounds >= 2 && runtime.verification !== "verified") return "checks-still-failing";
	}
	/** The Lead currently writes through a takeover and holds the lease. */
	#leadWriter(binding, agent) {
		if (!roleSeparated(binding) || !this.store.readDocument(`runtime:${binding.taskId}`)) return false;
		const lease = this.#held.get(binding.taskId);
		try {
			return Boolean(this.#runtime(binding.taskId).takeover && lease?.holder === SessionId(agent.id) && this.leases.stillHeld(lease));
		} catch {
			return false;
		}
	}
	#runtime(id) {
		const row = this.store.readDocument(`runtime:${id}`)?.value;
		if (!row || row.schemaVersion !== 1 || row.taskId !== id || !row.root || !Array.isArray(row.checks)) throw new Error("Fusion runtime record is missing or incompatible");
		return row;
	}
	#candidate(runtime) {
		return this.state(runtime.taskId).currentWorkOrder?.mode === "text" ? {
			...runtime.base,
			id: SnapshotId(`text:${digestOf({
				order: this.state(runtime.taskId).currentWorkOrder,
				brief: runtime.briefRevision,
				submitted: runtime.submitted
			})}`)
		} : snapshotWorkspace(runtime.root);
	}
	#saveRuntime(row) {
		const key = `runtime:${row.taskId}`, prior = this.store.readDocument(key);
		this.store.writeDocument(key, prior?.revision ?? 0, row);
	}
	#binding(agent, role) {
		const owner = this.owner(agent);
		if (!owner || owner.role !== role) throw new Error("Fusion role identity mismatch");
		this.scopes.assertReady(agent);
		return owner.binding;
	}
	#acquire(binding, root, holder, operationId) {
		const lease = this.leases.acquire({
			cwd: root,
			holder: SessionId(holder),
			taskId: binding.taskId,
			operationId
		});
		this.#held.set(binding.taskId, lease);
		try {
			this.append(binding.taskId, "lease/acquired", { lease });
		} catch (error) {
			this.leases.release(lease);
			this.#held.delete(binding.taskId);
			throw error;
		}
	}
	#release(id) {
		const lease = this.#held.get(id);
		if (!lease) return;
		this.leases.release(lease);
		this.append(id, "lease/released", {
			workspaceId: lease.workspaceId,
			generation: lease.generation
		});
		this.#held.delete(id);
	}
	async #stopJobs(taskId, stopChild) {
		this.#stoppingTasks.set(taskId, (this.#stoppingTasks.get(taskId) ?? 0) + 1);
		try {
			await this.effects.stopJobs(taskId);
			await stopChild?.();
		} finally {
			const remaining = this.#stoppingTasks.get(taskId) - 1;
			if (remaining) this.#stoppingTasks.set(taskId, remaining);
			else this.#stoppingTasks.delete(taskId);
		}
	}
	/** A detached native child remains a recorded writer until wait/takeover/stop. */
	#stopBackground(agent, binding) {
		const previous = this.#backgroundStops.get(binding.taskId);
		if (previous) return previous;
		const pending = (async () => {
			try {
				const state = this.state(binding.taskId);
				if (state.control.mode === "running") this.append(binding.taskId, "task/paused", { reason: "Lead turn stopped during a background handoff" });
				const childId = state.acceptedChild ?? state.reservedChild;
				const child = childId && this.ctx.agents.get(SessionId$1(childId));
				if (child) await this.#stopJobs(binding.taskId, () => this.transport.stop(agent, child.id));
				else if (state.lease) throw new Error("Background Worker is absent with a recorded writer; reconcile before releasing");
				if (this.effects.pending(binding.taskId).length) throw new Error("Background stop left unfinished native effects; inspection is required");
				this.#release(binding.taskId);
				this.#saveRuntime({
					...this.#runtime(binding.taskId),
					background: false
				});
			} catch (error) {
				this.#trackingFailed(agent, `Background Worker stop requires recovery: ${String(error)}`);
			}
		})().finally(() => {
			this.#backgroundStops.delete(binding.taskId);
		});
		this.#backgroundStops.set(binding.taskId, pending);
		return pending;
	}
	#runningReply(binding, delivery) {
		const state = this.state(binding.taskId);
		return JSON.stringify({
			status: "worker-running",
			childId: state.acceptedChild,
			messageId: state.acceptedMessageId,
			briefRevision: this.#runtime(binding.taskId).briefRevision ?? 0,
			delivery,
			mode: state.currentWorkOrder?.mode ?? "implement",
			next: state.currentWorkOrder?.mode === "explore" ? "The Worker is exploring read-only with no write lease. Continue read-only analysis, use fusion_rework for more facts, or fusion_wait to collect the source findings before planning implementation." : "The Worker retains write ownership. Continue read-only work, use fusion_rework to steer the same Worker, or call fusion_wait for its report and native checks."
		});
	}
	async #waitWorker(agent, binding, exec) {
		const childId = this.state(binding.taskId).acceptedChild;
		if (!childId) throw new Error("No accepted Worker to wait for");
		this.#saveRuntime({
			...this.#runtime(binding.taskId),
			background: false
		});
		try {
			if (!await this.transport.settle(agent, childId, exec.signal, true)) {
				exec.signal.throwIfAborted();
				this.scopes.assertReady(agent);
				this.#saveRuntime({
					...this.#runtime(binding.taskId),
					background: true
				});
				return this.#runningReply(binding, "user-steering");
			}
			if (this.effects.pending(binding.taskId).length) throw new Error("Worker stopped with unfinished native effects; inspection is required");
			exec.signal.throwIfAborted();
		} catch (error) {
			const cause = exec.signal.aborted ? /* @__PURE__ */ new Error("FUSION_INTERRUPTED: the native turn was cancelled; progress is retained. Continue the existing task after its effects settle.") : error;
			try {
				await this.#stopJobs(binding.taskId, () => this.transport.stop(agent, childId));
				if (this.effects.pending(binding.taskId).length) throw new Error("Worker has unfinished native effects");
				this.#release(binding.taskId);
				if (!this.state(binding.taskId).control.recovering) this.append(binding.taskId, "task/paused", { reason: String(cause) });
			} catch (stopError) {
				this.#trackingFailed(agent, `Worker wait requires recovery: ${String(stopError)}`);
			}
			throw cause;
		}
		this.#release(binding.taskId);
		exec.signal.throwIfAborted();
		this.#rememberWorkerFailure(agent, binding);
		this.scopes.assertReady(agent);
		return this.#validate(agent, binding, exec);
	}
	async wait(agent, exec) {
		const binding = this.#binding(agent, "lead"), state = this.state(binding.taskId);
		if (!state.currentWorkOrder || !state.acceptedChild) throw new Error("No Worker handoff is pending");
		if (state.phase === "REVIEWING") throw new Error("The current report is ready; review it before another wait");
		if (this.#runtime(binding.taskId).takeover) throw new Error("Lead takeover must submit its own result");
		const operation = readModelControl(this.store, binding)?.operation;
		const resumeId = operation && `workflow-worker-resume:${binding.taskId}:${operation.id}`;
		const child = this.ctx.agents.get(SessionId$1(state.acceptedChild));
		if (adaptiveWorkflow(binding) && operation?.taskId === binding.taskId && operation.state === "delivered" && (!child || child.status === "idle") && !this.#runtime(binding.taskId).submitted && !this.effects.pending(binding.taskId).length && !this.modelControl.waiting(binding, "worker") && resumeId && !this.store.readDocument(resumeId)) {
			this.store.writeDocument(resumeId, 0, {
				schemaVersion: 1,
				operationId: operation.id,
				childId: state.acceptedChild,
				causeId: exec.callId,
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return this.rework(agent, "The user explicitly continued this task through the local Fusion controls. Resume the unchanged work order on this same Sidekick; restore saved state before effects and do not repeat an uncertain operation.", exec);
		}
		if (["explore", "text"].includes(state.currentWorkOrder.mode ?? "") ? state.phase !== "WORKER_RUNNING" : state.lease?.holder !== state.acceptedChild) throw new Error("No active Worker handoff; send specific feedback before waiting again");
		return this.#waitWorker(agent, binding, exec);
	}
	/** Refuse a work order whose acceptance programs this host cannot run, before any Worker request. */
	async #preflightPrograms(root, definitions) {
		const programs = [...new Set(definitions.flatMap((definition) => checkPrograms(definition.command)))];
		const probe = programs.length ? await probeMissingPrograms(root, programs) : void 0;
		if (!probe?.missing.length) return;
		const hints = probe.missing.map((name) => {
			const found = [...probe.alternatives[name].map((item) => `${item} on PATH`), ...probe.locations[name].map((path) => `installed at ${path}, not on PATH`)];
			return found.length ? `${name} (${found.join("; ")})` : name;
		});
		throw new Error(`Acceptance commands use programs this host's check shell cannot find: ${hints.join("; ")}. Checks and the Worker run in the same non-interactive shell with the Host's PATH (a desktop app started from the Dock gets only the system PATH). Retry fusion_delegate with commands that exist here, using the absolute path shown when one is installed off PATH, and tell the Worker to use the same path.`);
	}
	async delegate(agent, args, exec, mode = "implement") {
		const binding = this.#binding(agent, "lead");
		const priorState = this.state(binding.taskId);
		const held = this.#held.get(binding.taskId);
		const directHandoff = (mode === "implement" || binding.profile.interactionMode === "model-like") && priorState.intent === "DIRECT" && !priorState.currentWorkOrder && priorState.control.mode === "running" && !priorState.control.recovering && !priorState.control.outcomeUnknown && priorState.lease?.holder === SessionId(agent.id) && held?.holder === SessionId(agent.id) && held.generation === priorState.lease.generation && this.leases.stillHeld(held);
		if (priorState.lease && !directHandoff || held && !priorState.lease || this.effects.pending(binding.taskId).length) throw new Error("Settle the current writer and effects before a new work order: wait for or stop your running commands (job_output, job_kill) and let pending tools finish, then delegate again");
		const promoting = mode === "implement" && priorState.currentWorkOrder?.mode === "explore";
		if (priorState.currentWorkOrder && !promoting) throw new Error("A Worker already owns this task; use fusion_rework with model-authored feedback (after a report it can also add allowedPaths with addAllowedPaths, or correct checks)");
		const base = mode === "text" ? {
			schemaVersion: 1,
			root: `text:${binding.sessionId}`,
			entries: [],
			excludedDirectoryNames: [],
			id: SnapshotId(`text:${binding.taskId}`)
		} : snapshotWorkspace(agent.session.header.cwd);
		const explored = promoting && priorState.phase === "PLANNING" && priorState.exploration?.workOrderId === priorState.currentWorkOrder.id && priorState.exploration.status === "completed" && priorState.exploration.snapshot === base.id;
		const abandoned = promoting && !explored && roleSeparated(binding) && !priorState.lease;
		if (promoting && (!explored && !abandoned || priorState.lease || this.effects.pending(binding.taskId).length)) throw new Error("Wait for the completed read-only exploration on the unchanged workspace before sending an implementation plan");
		if (mode === "implement" && !args.allowedPaths.length) throw new Error("Explicit allowedPaths are required");
		for (const path of args.allowedPaths) workspacePath(base.root, path);
		const origin = this.store.readDocument(`task-origin:${binding.taskId}`)?.value;
		const source = agent.session.snapshotEvents().findLast((event) => event.seq >= (origin?.firstSeq ?? 0) && event.type === "user/message" && (event.data.source === void 0 || event.data.source.kind === "user"));
		if (!source || source.type !== "user/message") throw new Error("No native user instruction source");
		const userTexts = agent.session.snapshotEvents().filter((event) => event.seq >= (origin?.firstSeq ?? 0) && event.type === "user/message" && (event.data.source === void 0 || event.data.source.kind === "user")).flatMap((event) => event.type === "user/message" ? event.data.content.filter((block) => block.type === "text").map((block) => block.text) : []);
		const requirements = this.#requirements(binding, mode, args.requirements, userTexts);
		const order = {
			schemaVersion: 1,
			mode,
			taskId: binding.taskId,
			id: WorkOrderId(randomUUID()),
			operationId: OperationId(randomUUID()),
			revision: this.state(binding.taskId).revision,
			goal: args.goal,
			constraints: [...args.constraints.map((text, i) => ({
				id: `constraint-${i}`,
				text,
				mandatory: true,
				provenance: "inferred",
				source: {
					sessionId: SessionId(agent.id),
					eventSeq: source.seq,
					messageId: source.data.id
				}
			})), ...requirements.map((text, i) => ({
				id: `requirement-${i}`,
				text,
				mandatory: true,
				provenance: "user",
				source: {
					sessionId: SessionId(agent.id),
					eventSeq: source.seq,
					messageId: source.data.id
				}
			}))],
			acceptance: [],
			allowedPaths: args.allowedPaths,
			forbiddenActions: [
				...mode === "explore" ? ["Write files or run commands during read-only exploration"] : [],
				"Change unrelated paths",
				"Weaken frozen acceptance checks",
				"Bypass native tool permissions"
			],
			baseSnapshot: base.id,
			evidence: explored ? priorState.exploration.sources.map((source) => source.excerpt) : [],
			decisions: [],
			uncertainties: [],
			policy: {
				maxWorkerSteps: this.options.maxWorkerSteps ?? DEFAULT_POLICY.maxWorkerSteps,
				maxReworkRounds: this.options.maxReworkRounds ?? DEFAULT_POLICY.maxReworkRounds,
				maxCapabilityUpgrades: 0,
				commandMaxSeconds: this.options.commandMaxSeconds ?? DEFAULT_POLICY.commandMaxSeconds
			}
		};
		let checks = mode === "explore" || mode === "text" ? [] : freezeChecks(order, base.root, args.checks);
		if (checks.length) await this.#preflightPrograms(base.root, args.checks);
		if (checks.some((check) => check.definition.baseline)) checks = await this.#baseline(agent, binding, base.root, order, checks, exec, directHandoff);
		order.acceptance = checks.map((check) => ({
			id: check.definition.id,
			description: check.definition.description,
			mandatory: true,
			verificationKind: check.plan.kind,
			planId: check.plan.id,
			planDigest: digestOf(check.plan)
		}));
		this.#assertWorkerCapacity(binding.taskId, order.policy.maxWorkerSteps);
		const childId = SessionId(binding.workerId ?? `fusion-worker-${randomUUID()}`);
		const priorChild = this.store.readDocument(`child:${childId}`);
		const resident = this.ctx.agents.get(SessionId$1(childId));
		if (binding.workerId) {
			const prior = priorChild?.value;
			if (!prior || prior.parent !== agent.id || !prior.taskId) throw new Error("Persistent Worker ownership requires reconciliation");
			const previous = this.state(prior.taskId);
			if (previous.acceptedChild !== childId || previous.parent !== SessionId(agent.id) || (promoting ? previous.taskId !== binding.taskId || previous.control.mode !== "running" : previous.control.mode !== "completed") || previous.control.recovering || previous.control.outcomeUnknown || previous.lease || previous.profileDigest !== binding.profile.digest || previous.currentWorkOrder?.mode !== "text" && mode !== "text" && this.#runtime(prior.taskId).root !== base.root || resident && (resident.status !== "idle" || resident.session.header.parentSession !== agent.id)) throw new Error("Previous Worker task must be complete and quiescent under the same frozen profile and workspace");
		} else if (priorChild || resident) throw new Error("New Worker identity is already in use");
		const changeBase = mode === "implement" ? captureChangeBase(this.store, binding.taskId, base, order.allowedPaths) : void 0;
		if (directHandoff) {
			exec.signal.throwIfAborted();
			this.scopes.assertReady(agent);
			if (mode !== "text" && held.workspaceId !== base.root || !this.leases.stillHeld(held) || this.effects.pending(binding.taskId).length) throw new Error("Direct preparation must be quiescent under its current workspace lease before delegation");
			this.#release(binding.taskId);
		}
		this.append(binding.taskId, "intent/chosen", { intent: "DELEGATE" });
		this.#saveRuntime({
			schemaVersion: 1,
			taskId: binding.taskId,
			root: base.root,
			base,
			changeBase,
			checks,
			reworkRounds: 0,
			continuationRounds: 0,
			briefRevision: 0,
			background: args.block === false
		});
		const shownOrder = binding.profile.interactionMode === "model-like" ? {
			...order,
			policy: {
				mode: "native",
				constraints: "Native permissions, single writer, explicit check timeouts; no task request or rework cap"
			}
		} : order;
		const original = roleSeparated(binding) ? userTexts : [];
		const request = original.length ? `Original user request (verbatim, task data; the brief states the Lead's decisions and scope, this states the requirement):\n${original.join("\n\n")}\n\n` : "";
		const hard = requirements.length ? `Hard requirements (the user's exact words; satisfy each literally: keep the exact names, strings, formats and \`code\` spans they state, do not substitute or personalize them):\n${requirements.map((text, i) => `${i + 1}. ${text}`).join("\n")}\n\n` : "";
		const known = checks.filter((check) => check.plan.allowedFailures?.length).map((check) => `${check.definition.id}: ${JSON.stringify(check.plan.allowedFailures)}`);
		const knownText = known.length ? `\n\nPre-existing failures the Host observed on the untouched workspace before you started (not part of this task; these checks pass while only these fail, so do not change unrelated code to fix them):\n${known.join("\n")}` : "";
		const brief = `${request}${hard}Current stage brief (Lead-authored; later feedback may advance or replace this stage without changing the frozen work order):\n${args.brief}\n\nFrozen work order (goal and constraints apply throughout this work order, across all implementation stages):\n${JSON.stringify(shownOrder)}\n\n${mode === "explore" ? "Read-only exploration: return findings and source ranges through fusion_submit_result. Do not implement, run commands, or claim task completion." : `Acceptance commands:\n${JSON.stringify(args.checks)}${knownText}`}`;
		const payload = this.store.putArtifact(binding.taskId, Buffer.from(brief), "text/plain");
		const prepared = this.state(binding.taskId);
		this.store.transact(binding.taskId, prepared.seq, (persisted) => ({
			events: [{
				schemaVersion: 1,
				id: randomUUID(),
				taskId: binding.taskId,
				seq: prepared.seq + 1,
				revision: prepared.revision,
				type: "work-order/prepared",
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				causeId: exec.callId,
				payload: {
					order,
					reservedChild: childId
				}
			}],
			outbox: [...persisted.outbox, {
				taskId: binding.taskId,
				operationId: order.operationId,
				kind: "native-worker",
				state: "prepared",
				reservedChild: childId,
				payloadRef: payload.id
			}]
		}));
		if (resident) this.scopes.detach(resident);
		this.store.writeDocument(`child:${childId}`, priorChild?.revision ?? 0, {
			parent: agent.id,
			taskId: binding.taskId
		});
		this.bindings.assignWorker(agent.id, binding.taskId, childId);
		if (resident) this.#attachKnown(resident);
		if (mode === "implement") this.#acquire(binding, base.root, childId, order.operationId);
		let started = false;
		try {
			this.store.advanceOutbox(binding.taskId, order.operationId, "prepared", "dispatched");
			this.activity.link(agent.session, childId, binding.taskId, exec.callId);
			const accepted = binding.workerId ? await this.transport.continue(agent, childId, brief, exec.signal) : await this.transport.start(agent, {
				childId,
				brief,
				label: args.goal.slice(0, 100),
				route: this.modelControl.route(binding, "worker"),
				persona: binding.prompts.worker,
				allowedTools: this.options.workerTools
			}, exec.signal);
			started = true;
			this.append(binding.taskId, "child/accepted", {
				operationId: order.operationId,
				child: childId,
				messageId: accepted.messageId
			});
			this.store.advanceOutbox(binding.taskId, order.operationId, "dispatched", "accepted", { nativeMessageId: accepted.messageId });
		} catch (error) {
			try {
				if (this.ctx.agents.get(SessionId$1(childId))) await this.#stopJobs(binding.taskId, () => this.transport.stop(agent, childId));
				else if (started) throw new Error("Accepted Worker is absent");
				if (this.effects.pending(binding.taskId).length) throw new Error("Worker dispatch has unfinished native effects");
				this.#release(binding.taskId);
			} catch (stopError) {
				this.#trackingFailed(agent, `Worker dispatch requires recovery: ${String(stopError)}`);
			}
			this.append(binding.taskId, "task/paused", { reason: String(error) });
			throw error;
		}
		if (args.block === false) return this.#runningReply(binding, "started");
		return this.#waitWorker(agent, binding, exec);
	}
	/**
	* The user's hard requirements, quoted verbatim, become user-provenance constraints (study 2026-09-26: a
	* Worker "personalised" a required literal message and the Lead's review missed it). Quotes are checked
	* against the user's own messages, so the Lead cannot paraphrase them; interpretations belong in the brief.
	*/
	#requirements(binding, mode, raw, userTexts) {
		if (mode === "explore") return [];
		const list = [...new Set((raw ?? []).map((text) => text.trim()).filter(Boolean))];
		if (!list.length && roleSeparated(binding) && mode === "implement") throw new Error("fusion_delegate needs requirements: quote the user's hard requirements verbatim (1-20 exact excerpts of the user's messages: required behaviour, names, strings, formats, acceptance criteria). They are frozen for the Sidekick and checked one by one in your review.");
		if (list.length > 20 || list.some((text) => text.length < 4 || text.length > 600)) throw new Error("requirements: 1-20 quotes of 4-600 characters each");
		const haystack = normalizeQuote(userTexts.join("\n"));
		const missing = list.filter((text) => !haystack.includes(normalizeQuote(text)));
		if (missing.length) throw new Error(`requirements must be exact quotes of the user's words; not found verbatim: ${JSON.stringify(missing.slice(0, 3))}. Copy the text exactly (whitespace may differ, nothing else); put your own interpretation in the brief or constraints.`);
		return list;
	}
	async #baseline(agent, binding, root, order, checks, exec, leadHolds) {
		if (!leadHolds) this.#acquire(binding, root, agent.id, OperationId(randomUUID()));
		try {
			return await this.roleSandbox.whileChecking(agent, binding, () => runBaselineChecks({
				ctx: this.ctx,
				store: this.store,
				root,
				order,
				checks,
				exec,
				nativeTimeout: binding.profile.interactionMode === "model-like",
				authorizeNested: (id) => {
					this.#nestedChecks.set(id, {
						agent,
						parent: exec.token
					});
					return () => {
						this.#nestedChecks.delete(id);
					};
				}
			}));
		} finally {
			if (!leadHolds) this.#release(binding.taskId);
		}
	}
	/**
	* The Lead owns scope as it owns acceptance. When a report shows the frozen
	* allowedPaths were too narrow (seen in a benchmark: a test file outside the
	* scope still encoded the old behaviour, and the task could only end
	* unfinished), the Lead may add paths between reports. Paths are only added.
	* The added files still hold their delegation-time bytes, which become part
	* of the change base so diffs and the rewritten-test gate cover them.
	*/
	#expandScope(binding, runtime, feedback, paths, exec) {
		const state = this.state(binding.taskId), order = state.currentWorkOrder;
		if (order.mode === "explore" || order.mode === "text") throw new Error("This assignment has no workspace scope to expand");
		if (!runtime.submitted || state.lease || this.#held.get(binding.taskId) || this.effects.pending(binding.taskId).length) throw new Error("Add allowedPaths only after the current Worker report, while the Worker is quiescent");
		for (const path of paths) workspacePath(runtime.root, path.trim());
		const added = [...new Set(paths.map((path) => path.trim()).filter(Boolean))].filter((path) => !order.allowedPaths.includes(path));
		if (!added.length) return feedback;
		const allowedPaths = [...order.allowedPaths, ...added];
		let changeBase = runtime.changeBase;
		if (changeBase) {
			const known = changeBase.contents;
			const fresh = {
				...runtime.base,
				entries: runtime.base.entries.filter((entry) => !Object.hasOwn(known, entry.path))
			};
			let extra;
			try {
				extra = captureChangeBase(this.store, binding.taskId, fresh, added);
			} catch (error) {
				throw new Error(`Files under the added paths already differ from the delegation base, so their original bytes cannot be recorded: ${error.message}. Inspect those changes before widening the scope.`);
			}
			changeBase = {
				...changeBase,
				contents: {
					...known,
					...extra.contents
				}
			};
		}
		this.store.writeDocument(`scope-expansion:${binding.taskId}:${randomUUID()}`, 0, {
			schemaVersion: 1,
			taskId: binding.taskId,
			workOrderId: order.id,
			causeId: exec.callId,
			reason: feedback,
			before: order.allowedPaths,
			added,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		this.append(binding.taskId, "work-order/scope-expanded", {
			workOrderId: order.id,
			allowedPaths,
			added,
			reason: feedback
		});
		this.#saveRuntime({
			...this.#runtime(binding.taskId),
			...changeBase ? { changeBase } : {}
		});
		return `${feedback}\n\nThe Lead added these paths to the frozen allowedPaths: ${JSON.stringify(added)}. You may now change: ${JSON.stringify(allowedPaths)}`;
	}
	/**
	* The freeze stops a Worker from weakening acceptance; it does not bind the
	* Lead, who owns acceptance. A Lead may correct a broken check (for example
	* an interpreter this host lacks) between reports, but every previously
	* protected definition file stays protected and byte-identical to the base.
	*/
	#amendAcceptance(binding, runtime, feedback, definitions, exec) {
		const state = this.state(binding.taskId), order = state.currentWorkOrder;
		if (order.mode === "explore" || order.mode === "text") throw new Error("This assignment has no workspace acceptance checks to amend");
		if (!runtime.submitted || state.lease || this.#held.get(binding.taskId) || this.effects.pending(binding.taskId).length) throw new Error("Amend acceptance checks only after the current Worker report, while the Worker is quiescent");
		const protectedPaths = [...new Set(runtime.checks.flatMap((check) => check.definition.definitionPaths))];
		const kept = new Set(definitions.flatMap((definition) => definition.definitionPaths));
		const dropped = protectedPaths.filter((path) => !kept.has(path));
		if (dropped.length) throw new Error(`Amended checks must keep every protected definition path: ${JSON.stringify(dropped)}`);
		const current = snapshotWorkspace(runtime.root);
		const digest = (entries, path) => entries.find((entry) => entry.path === path)?.digest;
		const changed = protectedPaths.filter((path) => digest(runtime.base.entries, path) !== digest(current.entries, path));
		if (changed.length) throw new Error(`Protected acceptance files changed since delegation; amendment refused: ${JSON.stringify(changed)}`);
		const checks = freezeChecks(order, runtime.root, definitions).map((check) => {
			if (!check.definition.baseline) return check;
			const prior = runtime.checks.find((item) => item.definition.id === check.definition.id && item.plan.allowedFailures);
			if (!prior) throw new Error(`Check ${check.definition.id}: a baseline can only be measured at delegation, on the untouched workspace; amend it without baseline or keep its id`);
			return {
				...check,
				plan: {
					...check.plan,
					allowedFailures: prior.plan.allowedFailures
				}
			};
		});
		const acceptance = checks.map((check) => ({
			id: check.definition.id,
			description: check.definition.description,
			mandatory: true,
			verificationKind: check.plan.kind,
			planId: check.plan.id,
			planDigest: digestOf(check.plan)
		}));
		this.store.writeDocument(`acceptance-amendment:${binding.taskId}:${randomUUID()}`, 0, {
			schemaVersion: 1,
			taskId: binding.taskId,
			workOrderId: order.id,
			causeId: exec.callId,
			reason: feedback,
			before: runtime.checks.map((check) => check.definition),
			after: checks.map((check) => check.definition),
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		this.append(binding.taskId, "work-order/acceptance-amended", {
			workOrderId: order.id,
			acceptance,
			reason: feedback
		});
		this.#saveRuntime({
			...this.#runtime(binding.taskId),
			checks
		});
		return `${feedback}\n\nThe Lead amended the frozen acceptance commands. The Host will verify your next report with:\n${JSON.stringify(definitions)}`;
	}
	async rework(agent, feedback, exec, block = true, checks, addAllowedPaths) {
		const binding = this.#binding(agent, "lead"), state = this.state(binding.taskId);
		if (!state.acceptedChild || !state.currentWorkOrder) throw new Error("No accepted Worker to continue");
		const childId = state.acceptedChild;
		if (!feedback.trim()) throw new Error("Specific Lead-authored feedback is required");
		this.#acknowledgeUserRetry(agent, binding.taskId);
		this.#rememberWorkerFailure(agent, binding);
		if (this.#workerQuotaStop(binding.taskId)) {
			this.#release(binding.taskId);
			this.#saveRuntime({
				...this.#runtime(binding.taskId),
				background: false
			});
			throw new Error("worker-quota-exhausted: the Worker provider reported exhausted quota. No feedback was sent. Explain this provider limit, preserve the unfinished task and wait for user input; do not retry, take over or claim completion.");
		}
		let runtime = this.#runtime(binding.taskId);
		this.#assertWorkerCapacity(binding.taskId);
		const feedbackKind = runtime.submitted ? "rework" : "continuation";
		const continuationRounds = runtime.continuationRounds ?? 0;
		if (binding.profile.interactionMode !== "model-like" && feedbackKind === "rework" && runtime.reworkRounds >= state.currentWorkOrder.policy.maxReworkRounds) throw new Error("Rework limit reached; request a user decision");
		if (binding.profile.interactionMode !== "model-like" && feedbackKind === "continuation" && continuationRounds >= state.currentWorkOrder.policy.maxWorkerSteps) throw new Error("Continuation limit reached; request a user decision");
		if (addAllowedPaths?.length) {
			feedback = this.#expandScope(binding, runtime, feedback, addAllowedPaths, exec);
			runtime = this.#runtime(binding.taskId);
		}
		if (checks) {
			feedback = this.#amendAcceptance(binding, runtime, feedback, checks, exec);
			runtime = this.#runtime(binding.taskId);
		}
		const held = this.#held.get(binding.taskId);
		if (held) {
			if (held.holder !== state.acceptedChild || !this.leases.stillHeld(held)) throw new Error("Worker does not own the current writer lease");
		} else if (!["explore", "text"].includes(state.currentWorkOrder.mode ?? "")) this.#acquire(binding, runtime.root, state.acceptedChild, state.currentWorkOrder.operationId);
		const child = this.ctx.agents.get(SessionId$1(state.acceptedChild));
		const liveGeneration = this.store.listDocumentIds(`usage:${binding.taskId}:`).some((id) => {
			const row = this.store.readDocument(id)?.value;
			return row.sessionId === state.acceptedChild && row.purpose === "conversation" && row.endedAt === null;
		});
		const delivery = child?.status !== "idle" && child ? (liveGeneration || this.effects.waitingForJob(child)) && (!this.effects.pending(binding.taskId).length || this.effects.onlyBackgroundPending(binding.taskId)) ? "interrupt-generation" : "next-step" : "continuation";
		const deliveryId = `worker-delivery:${binding.taskId}:${randomUUID()}`;
		try {
			const briefRevision = (runtime.briefRevision ?? 0) + 1;
			const payload = this.store.putArtifact(binding.taskId, Buffer.from(feedback), "text/plain");
			this.store.writeDocument(deliveryId, 0, {
				schemaVersion: 1,
				taskId: binding.taskId,
				childId: state.acceptedChild,
				workOrderId: state.currentWorkOrder.id,
				state: "prepared",
				briefRevision,
				delivery,
				feedbackKind,
				payloadRef: payload.id,
				causeId: exec.callId
			});
			this.#saveRuntime({
				...runtime,
				briefRevision,
				background: !block,
				takeover: false,
				submitted: void 0,
				explorationSubmitted: void 0,
				verification: void 0,
				verificationReasons: void 0,
				workerFailure: void 0,
				reworkRounds: runtime.reworkRounds + (feedbackKind === "rework" ? 1 : 0),
				continuationRounds: continuationRounds + (feedbackKind === "continuation" ? 1 : 0)
			});
			this.activity.link(agent.session, childId, binding.taskId, exec.callId);
			const accepted = delivery === "interrupt-generation" ? await this.transport.interruptAndContinue(agent, state.acceptedChild, feedback, exec.signal) : await this.transport.continue(agent, state.acceptedChild, feedback, exec.signal);
			this.append(binding.taskId, "child/accepted", {
				operationId: state.currentWorkOrder.operationId,
				child: state.acceptedChild,
				messageId: accepted.messageId
			});
			const prepared = this.store.readDocument(deliveryId);
			this.store.writeDocument(deliveryId, prepared.revision, {
				...prepared.value,
				state: "accepted",
				messageId: accepted.messageId
			});
		} catch (error) {
			try {
				await this.#stopJobs(binding.taskId, () => this.transport.stop(agent, childId));
				if (!this.effects.pending(binding.taskId).length) this.#release(binding.taskId);
			} catch (stopError) {
				this.#trackingFailed(agent, `Worker feedback stop failed: ${String(stopError)}`);
			}
			this.#trackingFailed(agent, `Worker feedback delivery requires reconciliation: ${String(error)}`);
			throw error;
		}
		if (!block) return this.#runningReply(binding, delivery);
		return this.#waitWorker(agent, binding, exec);
	}
	async #validate(agent, binding, exec) {
		const runtime = this.#runtime(binding.taskId), state = this.state(binding.taskId), order = state.currentWorkOrder;
		if (!runtime.submitted) {
			const waiting = this.modelControl.waiting(binding, "worker");
			if (waiting) return JSON.stringify({
				status: "needs-decision",
				reasonCode: "worker-unavailable",
				failureCode: waiting.code,
				childId: state.acceptedChild,
				workerRunning: false,
				quotaResetAt: waiting.quotaResetAt,
				...waiting.retryNotBefore ? { retryNotBefore: waiting.retryNotBefore } : {},
				next: "Explain which role is unavailable. Use local Fusion controls to continue or replace its model; do not retry delegation or take over automatically."
			});
			const failure = runtime.workerFailure;
			if (failure?.workOrderId === order.id && failure.childId === state.acceptedChild) {
				const quota = failure.category === "quota-exhausted";
				return JSON.stringify({
					status: "needs-decision",
					reasonCode: quota ? "worker-quota-exhausted" : "worker-provider-error",
					reason: "Worker stopped without fusion_submit_result because its provider request failed",
					childId: state.acceptedChild,
					workerRunning: false,
					provider: this.modelControl.route(binding, "worker").provider,
					model: this.modelControl.route(binding, "worker").model,
					failureCode: failure.code,
					next: quota ? "The Worker provider explicitly reported exhausted quota. Do not retry feedback, request takeover or claim completion. Explain this provider limit and await user input after quota is restored. Existing work is retained." : "Explain the provider failure without claiming a report or completion. A specific bounded retry may be appropriate for a transient error."
				});
			}
			const spent = this.#workerStepLimit(binding.taskId);
			if (spent) this.#recordWorkerStepStop(binding.taskId, spent);
			return JSON.stringify({
				status: "needs-decision",
				reason: "Worker stopped without fusion_submit_result; its turn is incomplete",
				childId: state.acceptedChild,
				...spent ? {
					reasonCode: "worker-step-limit",
					workerRunning: false,
					...spent,
					next: "No further Worker request can be admitted. Do not retry fusion_rework or claim completion. Explain the incomplete work and await a user decision; existing files and evidence are retained."
				} : {}
			});
		}
		const candidate = this.#candidate(runtime);
		if (order.mode === "explore") {
			const report = runtime.explorationSubmitted;
			if (!report || report.workOrderId !== order.id || report.snapshot !== candidate.id) throw new Error("Exploration report or workspace changed; inspect before continuing");
			this.store.transact(binding.taskId, state.seq, (persisted) => ({
				events: [{
					schemaVersion: 1,
					id: randomUUID(),
					taskId: binding.taskId,
					seq: state.seq + 1,
					revision: state.revision,
					type: "exploration/recorded",
					createdAt: (/* @__PURE__ */ new Date()).toISOString(),
					causeId: exec.callId,
					payload: { report }
				}],
				outbox: persisted.outbox.map((row) => row.operationId === order.operationId ? {
					...row,
					state: "acknowledged",
					resultDigest: digestOf(report)
				} : row)
			}));
			this.#saveRuntime({
				...runtime,
				background: false
			});
			const complete = report.status === "completed";
			return JSON.stringify({
				status: complete ? "exploration-ready" : "exploration-blocked",
				report,
				verification: "unverified",
				excerpts: report.sources.map((source) => ({
					...source,
					text: Buffer.from(this.store.readArtifact(binding.taskId, source.excerpt.id)).toString("utf8")
				})),
				next: complete ? "Use these source findings to make your own plan, then fusion_delegate to this same Worker. For missing facts use fusion_rework; for a read-only question use fusion_finish_direct. Exploration does not complete implementation." : "Exploration did not finish. If specific feedback can resolve the blocker, use fusion_rework with the same Worker. Otherwise explain the blocker and end this turn to await the missing input. No Worker is still running; fusion_wait will not retry it. Do not call fusion_finish_direct, fusion_review_result or fusion_delegate on this incomplete report."
			});
		}
		const changes = changedPaths(runtime.base, candidate);
		const outside = changes.filter((path) => !pathAllowed(path, order.allowedPaths));
		if (outside.length) return JSON.stringify({
			status: "rework-required",
			reason: "Changes outside frozen allowedPaths",
			paths: outside
		});
		const manifest = saveChangeManifest(this.store, binding.taskId, runtime.base, candidate, runtime.changeBase);
		const report = {
			schemaVersion: 1,
			workOrderId: order.id,
			revision: order.revision,
			...runtime.submitted,
			snapshot: candidate.id,
			changeManifest: manifest,
			coverage: [],
			verification: [],
			questions: []
		};
		if (order.mode !== "text") this.#acquire(binding, runtime.root, agent.id, OperationId(randomUUID()));
		let checked;
		try {
			checked = await this.roleSandbox.whileChecking(agent, binding, () => runNativeChecks({
				ctx: this.ctx,
				store: this.store,
				root: runtime.root,
				order,
				report,
				uncertain: (evidence) => {
					if (!this.state(binding.taskId).control.outcomeUnknown) this.append(binding.taskId, "effect/outcome-unknown", {
						operationId: evidence.operationId,
						reason: "Native acceptance command did not provide a definite terminal outcome"
					});
				},
				checks: runtime.checks,
				nativeTimeout: binding.profile.interactionMode === "model-like",
				exec,
				authorizeNested: (id) => {
					this.#nestedChecks.set(id, {
						agent,
						parent: exec.token
					});
					return () => {
						this.#nestedChecks.delete(id);
					};
				}
			}));
		} finally {
			this.#release(binding.taskId);
		}
		this.#saveRuntime({
			...runtime,
			verification: checked.verdict.verification,
			verificationReasons: checked.verdict.reasons
		});
		this.append(binding.taskId, "report/submitted", {
			operationId: order.operationId,
			report: checked.report
		});
		this.append(binding.taskId, "report/validated", {
			operationId: order.operationId,
			report: checked.report
		});
		const checkpoint = {
			schemaVersion: 1,
			epochId: EpochId(randomUUID()),
			taskId: binding.taskId,
			revision: order.revision,
			goal: order.goal,
			mandatoryConstraints: order.constraints,
			snapshot: candidate.id,
			decisions: order.decisions,
			coverage: checked.report.coverage,
			pendingApprovalIds: [],
			openQuestions: [],
			evidence: checked.report.verification,
			sourceSurfaceSeqs: [],
			digest: digestOf("pending")
		};
		this.append(binding.taskId, "checkpoint/committed", { checkpoint: {
			...checkpoint,
			digest: digestOf(checkpoint)
		} });
		const payload = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify({
			report: checked.report,
			verdict: checked.verdict
		})), "application/json");
		const ticket = persistReviewRequest(this.store, binding.taskId, {
			ticketId: randomUUID(),
			requestId: randomUUID()
		}, payload.id);
		const row = this.store.outbox(binding.taskId).find((row) => row.operationId === order.operationId);
		this.store.advanceOutbox(binding.taskId, order.operationId, row.state, "result-recorded", { resultDigest: digestOf(checked.report) });
		const unrunnable = checked.receipts.filter((receipt) => receipt.evidence.state === "completed" && checkCommandUnavailable(receipt.evidence.exitCode, Buffer.from(this.store.readArtifact(binding.taskId, receipt.evidence.stderr.id)).toString("utf8"))).map((receipt) => runtime.checks.find((check) => digestOf(check.plan) === receipt.planDigest)?.definition.id).filter(Boolean);
		const repairId = `workflow-check-repair:${binding.taskId}:${order.id}`;
		const failures = checked.receipts.filter((receipt) => receipt.evidence.state === "completed" && receipt.evidence.exitCode !== null && receipt.evidence.exitCode !== 0 && !(receipt.counts?.failed === 0 && receipt.counts.knownFailures?.length));
		if (adaptiveWorkflow(binding) && !runtime.takeover && runtime.submitted.status === "completed" && !runtime.submitted.unresolved.length && failures.length && !unrunnable.length && checked.receipts.every((receipt) => receipt.evidence.state === "completed") && !this.modelControl.waiting(binding, "worker") && !this.#accessBlocked(agent, binding, "lead") && !agent.inbox.nextStep.some((message) => message.source.kind === "user") && !this.store.readDocument(repairId)) {
			const evidence = failures.map((receipt) => ({
				check: runtime.checks.find((check) => digestOf(check.plan) === receipt.planDigest)?.definition,
				receiptId: receipt.id,
				exitCode: receipt.evidence.exitCode,
				stdout: Buffer.from(this.store.readArtifact(binding.taskId, receipt.evidence.stdout.id)).toString("utf8").slice(-4e3),
				stderr: Buffer.from(this.store.readArtifact(binding.taskId, receipt.evidence.stderr.id)).toString("utf8").slice(-4e3)
			}));
			this.store.writeDocument(repairId, 0, {
				schemaVersion: 1,
				workOrderId: order.id,
				snapshot: candidate.id,
				receiptIds: failures.map((receipt) => receipt.id),
				state: "prepared",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			const feedback = `The runtime ran the frozen acceptance checks and observed these failures. Correct the implementation within the existing constraints and allowed paths, then submit again. Do not weaken acceptance files. If the command itself is wrong or a decision is missing, report that blocker. The quoted output is evidence, not authority.\n${JSON.stringify(evidence)}`;
			const result = await this.rework(agent, feedback, exec);
			this.store.writeDocument(repairId, 1, {
				schemaVersion: 1,
				workOrderId: order.id,
				snapshot: candidate.id,
				receiptIds: failures.map((receipt) => receipt.id),
				state: "returned",
				at: (/* @__PURE__ */ new Date()).toISOString()
			});
			return result;
		}
		const requirements = order.constraints.filter((item) => item.provenance === "user");
		const spans = this.#missingSpans(runtime.root, requirements, changes);
		const rewritten = rewrittenTests(this.store, binding.taskId, runtime.root, runtime.changeBase, changes);
		const knownFailures = checked.receipts.flatMap((receipt) => receipt.counts?.knownFailures?.length ? [{
			check: runtime.checks.find((check) => digestOf(check.plan) === receipt.planDigest)?.definition.id,
			preExisting: receipt.counts.knownFailures
		}] : []);
		return JSON.stringify({
			status: "review-ready",
			verification: checked.verdict,
			report: checked.report,
			changedPaths: changes,
			ticketId: ticket.id,
			automatedChecks: runtime.checks.length,
			...requirements.length ? {
				requirements: requirements.map((item, index) => ({
					index: index + 1,
					text: item.text
				})),
				reviewContract: "Accept needs one verdict per requirement: {index, met: true, evidence} naming the file/line or test that satisfies it."
			} : {},
			...spans.length ? {
				literalSpansMissing: spans,
				warning: "These exact spans from the user's requirements occur in no changed file. If the requirement asks for that literal text, the candidate does not satisfy it: use fusion_rework. An accept must address each span in that requirement's evidence."
			} : {},
			...knownFailures.length ? { preExistingFailures: knownFailures } : {},
			...rewritten.length ? {
				rewrittenTests: rewritten,
				testWarning: "Existing tests lost or changed original lines. Check that the change extends them rather than rewriting an old expectation to fit the new behaviour; an accept must name each file in its reason."
			} : {},
			...runtime.checks.length ? {} : { reviewOnly: "No automated acceptance check ran for this work order. Your review of the diff is the only verification; say so plainly in the final answer." },
			...unrunnable.length ? { checkDefinitionProblem: {
				checks: unrunnable,
				reason: "The acceptance command could not execute on this host (program not found or not executable)",
				next: "This is not a code defect. After recording the review, correct the command with fusion_rework checks, keeping every protected definition path."
			} } : {},
			next: "Inspect relevant changes and evidence. Record fusion_review_result; use fusion_rework for corrections."
		});
	}
	/** Literal `code` spans from user requirements that appear in none of the changed files. */
	#missingSpans(root, requirements, changes) {
		const texts = changes.flatMap((path) => {
			try {
				return [readFileSync(workspacePath(root, path), "utf8")];
			} catch {
				return [];
			}
		});
		return requirements.flatMap((item, index) => literalSpans(item.text).filter((span) => !texts.some((text) => text.includes(span))).map((span) => ({
			requirement: index + 1,
			span
		})));
	}
	review(agent, decision, reason, exec, verdicts = []) {
		const binding = this.#binding(agent, "lead"), runtime = this.#runtime(binding.taskId);
		if (this.state(binding.taskId).phase !== "REVIEWING") throw new Error("Wait for the current Worker report and checks before recording a review");
		if (!substantiveReview(reason)) throw new Error("Record what you checked: name the requirements, evidence or diff parts behind this decision (at least a sentence). A stub such as \"placeholder\" is not a review.");
		const proof = nativeReviewProof(this.store, binding.taskId, exec);
		const snapshot = this.#candidate(runtime);
		assertCurrentSubject(this.state(binding.taskId), proof.ticket, snapshot.id);
		if (decision === "accept" && runtime.verification !== "verified") throw new Error(`Acceptance checks do not prove completion: ${runtime.verificationReasons?.join("; ")}`);
		if (decision === "accept") this.#assertRequirementVerdicts(runtime, verdicts);
		if (decision === "accept" && runtime.changeBase) {
			const unnamed = rewrittenTests(this.store, runtime.taskId, runtime.root, runtime.changeBase, changedPaths(runtime.base, snapshotWorkspace(runtime.root))).filter((item) => !reason.includes(item.path));
			if (unnamed.length) throw new Error(`Existing tests lost or changed original lines: ${JSON.stringify(unnamed)}. Confirm each change keeps the old expectation (or is required by the user), and name each file in the accept reason; otherwise send a rework.`);
		}
		const classification = classifyReview({
			executionPath: "fusion_auto",
			finishReason: proof.finishReason,
			rawText: JSON.stringify(exec.arguments),
			parsed: {
				schemaVersion: 1,
				decision,
				reason
			}
		});
		appendCapturedReviewResult(this.store, binding.taskId, proof.ticket, {
			requestId: proof.ticket.requestId,
			terminalEvidenceRef: proof.terminalEvidenceRef,
			classification
		});
		const reviewRow = this.store.outbox(binding.taskId).find((row) => row.requestId === proof.ticket.requestId);
		this.store.advanceOutbox(binding.taskId, reviewRow.operationId, reviewRow.state, "acknowledged");
		if (decision === "accept") this.append(binding.taskId, "task/completed", {
			snapshot: snapshot.id,
			verification: "verified"
		});
		return JSON.stringify({
			decision,
			taskId: binding.taskId,
			phase: this.state(binding.taskId).phase,
			verification: this.state(binding.taskId).verification
		});
	}
	/** Every frozen user requirement needs a met verdict with concrete evidence; spans absent from the diff must be addressed. */
	#assertRequirementVerdicts(runtime, verdicts) {
		const order = this.state(runtime.taskId).currentWorkOrder;
		const requirements = order.constraints.filter((item) => item.provenance === "user");
		if (!requirements.length) return;
		const byIndex = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
		const problems = requirements.flatMap((item, i) => {
			const verdict = byIndex.get(i + 1);
			if (!verdict) return [`${i + 1}: no verdict`];
			if (!verdict.met) return [`${i + 1}: marked not met`];
			if (verdict.evidence.trim().length < 12) return [`${i + 1}: evidence must name the file/line or test that satisfies it`];
			return [];
		});
		const changes = order.mode === "text" ? [] : changedPaths(runtime.base, snapshotWorkspace(runtime.root));
		for (const { requirement, span } of order.mode === "text" ? [] : this.#missingSpans(runtime.root, requirements, changes)) if (!byIndex.get(requirement)?.evidence.includes(span)) problems.push(`${requirement}: literal \`${span}\` occurs in no changed file; quote it in the evidence where the candidate satisfies it, or send a rework`);
		if (problems.length) throw new Error(`Accept needs one met verdict per user requirement ({index, met, evidence}). Unresolved: ${problems.join("; ")}. Requirements: ${JSON.stringify(requirements.map((item, i) => ({
			index: i + 1,
			text: item.text
		})))}`);
	}
	async pause(agent) {
		const binding = this.bindings.read(agent.id)?.binding;
		if (!binding?.selected) throw new Error("Fusion is not selected");
		if (this.state(binding.taskId).control.mode === "completed") return;
		this.append(binding.taskId, "task/stop-requested", { intent: "pause" });
		const auxiliaryStopped = this.keepalive.stopTask(binding.taskId, "pause");
		agent.cancel({ kind: "user" }, { keepInbox: true });
		await agent.whenIdle();
		await this.#backgroundStops.get(binding.taskId);
		const state = this.state(binding.taskId);
		const child = (state.acceptedChild ?? state.reservedChild) && this.ctx.agents.get(SessionId$1(state.acceptedChild ?? state.reservedChild));
		await this.#stopJobs(binding.taskId, child ? () => this.transport.stop(agent, child.id) : void 0);
		if (!this.effects.pending(binding.taskId).length) {
			this.#release(binding.taskId);
			if (this.store.readDocument(`runtime:${binding.taskId}`)) this.#saveRuntime({
				...this.#runtime(binding.taskId),
				background: false
			});
		}
		if (this.state(binding.taskId).control.mode !== "paused") this.append(binding.taskId, "task/paused", { reason: "User paused Fusion" });
		await auxiliaryStopped;
		await agent.whenIdle();
		await this.activity.flush();
	}
	async resume(agent, authorizationId) {
		const binding = this.bindings.read(agent.id)?.binding;
		if (!binding?.selected) throw new Error("Fusion is not selected");
		await this.keepalive.stopTask(binding.taskId, "resume");
		await this.#backgroundStops.get(binding.taskId);
		await agent.whenIdle();
		await agent.runMaintenance(async () => {
			const state = this.state(binding.taskId);
			if (this.#trackingErrors.has(binding.taskId) || state.control.recovering || state.control.outcomeUnknown) throw new Error("Review the interrupted effects and use /fusion recover <inspection note>");
			if (this.#installErrors.has(agent.id)) {
				this.scopes.detach(agent);
				this.#attachKnown(agent);
				const failed = this.#installErrors.get(agent.id);
				if (failed) throw new Error(`Fusion Agent scope could not be restored: ${failed}`);
			}
			if (state.control.budgetBlocked) this.append(binding.taskId, "budget/unblocked", { authorizationId });
			if (this.state(binding.taskId).control.mode === "paused") this.append(binding.taskId, "task/resumed", { reason: "User resumed the native Fusion task" });
			this.#clearWorkerFailure(binding.taskId);
		});
	}
	/** Human command only. Never exposed as an LLM tool or triggered by a dead PID alone. */
	async reconcile(agent, inspection) {
		const binding = this.bindings.read(agent.id)?.binding;
		if (!binding?.selected || inspection.note.trim().length < 12 || !inspection.commandId) throw new Error("Record what interrupted file/process effects you inspected; no automatic replay is performed");
		await this.keepalive.stopTask(binding.taskId, "reconcile");
		await this.#backgroundStops.get(binding.taskId);
		await agent.whenIdle();
		await agent.runMaintenance(async () => {
			const state = this.state(binding.taskId);
			this.effects.assertInspection(binding.taskId, inspection.effectsStopped === true);
			const recorded = this.store.readDocument(`runtime:${binding.taskId}`);
			if (!recorded && (binding.profile.interactionMode === "model-like" ? state.currentWorkOrder || state.acceptedChild || state.reservedChild : state.intent || state.currentWorkOrder || state.lease || state.acceptedChild || state.reservedChild)) throw new Error("Fusion execution state is missing its runtime record; inspect the damaged store before recovery");
			const root = recorded ? this.#runtime(binding.taskId).root : agent.session.header.cwd;
			if (!root && binding.profile.interactionMode !== "model-like") throw new Error("Fusion recovery requires the recorded native workspace");
			const textOnly = state.currentWorkOrder?.mode === "text" || !root;
			const child = (state.acceptedChild ?? state.reservedChild) && this.ctx.agents.get(SessionId$1(state.acceptedChild ?? state.reservedChild));
			await this.#stopJobs(binding.taskId);
			if (child) await this.transport.release(agent, child.id);
			const lease = textOnly ? void 0 : this.leases.current(root);
			if (lease && lease.taskId !== binding.taskId) throw new Error("Another task owns the workspace lease");
			if (lease && lease.pid !== process.pid) try {
				process.kill(lease.pid, 0);
				throw new Error("The old Host is still live; settle it before reconciling this lease");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
			const snapshot = textOnly ? {
				schemaVersion: 1,
				root: root ?? `native:${agent.id}`,
				entries: [],
				excludedDirectoryNames: [],
				id: SnapshotId(`inspection:${randomUUID()}`)
			} : snapshotWorkspace(root);
			const evidence = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify({
				schemaVersion: 1,
				kind: "human-effect-reconciliation",
				nativeCommandId: inspection.commandId,
				inspection: inspection.note,
				snapshot,
				priorLease: lease ?? null,
				residentWorkerQuiescent: !child || child.status === "idle",
				effectQuiescenceBasis: this.effects.pending(binding.taskId).length ? "explicit-user-inspection" : "no-unfinished-native-dispatch",
				at: (/* @__PURE__ */ new Date()).toISOString()
			})), "application/json");
			this.approvals.reconcile(binding.taskId, evidence.id);
			this.effects.inspected(binding.taskId, evidence.id, inspection.effectsStopped === true);
			for (const [prefix, unfinished] of [
				["context-recovery:", "started"],
				["task-checkpoint:", "prepared"],
				["worker-delivery:", "prepared"]
			]) for (const id of this.store.listDocumentIds(`${prefix}${binding.taskId}:`)) {
				const row = this.store.readDocument(id), value = row.value;
				if (value.state !== unfinished) continue;
				const notApplied = prefix === "worker-delivery:" && (value.briefRevision ?? 0) > (this.#runtime(binding.taskId).briefRevision ?? 0);
				this.store.writeDocument(id, row.revision, {
					...value,
					state: notApplied ? "not-applied-after-interruption" : "inspected-after-interruption",
					inspectionEvidence: evidence.id,
					inspectedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
			if (lease) this.leases.release(lease);
			this.#held.delete(binding.taskId);
			if (state.lease) this.append(binding.taskId, "lease/released", {
				workspaceId: state.lease.workspaceId,
				generation: state.lease.generation
			});
			if (state.control.outcomeUnknown) this.append(binding.taskId, "effects/reconciled", {
				snapshot: snapshot.id,
				evidenceRef: evidence.id,
				quiescent: true
			});
			if (state.control.recovering) this.append(binding.taskId, "recovery/reconciled", {
				snapshot: snapshot.id,
				evidenceRef: evidence.id
			});
			if (this.state(binding.taskId).control.mode !== "paused") this.append(binding.taskId, "task/paused", { reason: "Effects inspected; resume when ready" });
			this.modelControl.reconcileDelivery(agent, binding, evidence.id);
			this.#trackingErrors.delete(binding.taskId);
			if (recorded) this.#saveRuntime({
				...this.#runtime(binding.taskId),
				background: false
			});
		});
		await agent.whenIdle();
	}
	#tools(scope, agent, role) {
		const dispose = [scope.tools.register(defineTool({
			name: "fusion_read_evidence",
			description: "Read owned evidence, including check receipt IDs from report coverage. Receipts include the frozen check, actual result and stdout/stderr references. Change manifests contain complete patch and before/after content references. Follow nextOffset until null to read a long artifact; binary content is explicitly base64.",
			parameters: {
				id: {
					type: "string",
					required: true
				},
				offset: {
					type: "integer",
					description: "Text offset in UTF-16 code units; use nextOffset from the previous page. Default 0."
				},
				limit: {
					type: "integer",
					description: "Maximum page length, from 2 to 24000 UTF-16 code units. Default 24000."
				}
			},
			output: textOutput,
			execute: async (args) => {
				const binding = this.#binding(agent, role);
				const bytes = readNativeEvidence(this.store, binding.taskId, args.id);
				return JSON.stringify({
					id: args.id,
					...evidencePage(bytes, args.offset, args.limit)
				});
			}
		}))];
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_submit_result",
			description: role === "lead" ? "Lead use only after fusion_takeover: submit your own correction so the frozen checks run again. To judge a Sidekick report, use fusion_review_result instead." : "Submit the current work-order report and conclude this Worker turn. Read-only exploration requires source ranges; implementation retains frozen checks and Lead review.",
			parameters: {
				summary: {
					type: "string",
					description: "Changes and findings; put nonblocking observations here.",
					required: true
				},
				status: {
					type: "string",
					enum: [
						"completed",
						"blocked",
						"needs-decision"
					],
					required: true
				},
				unresolved: {
					...stringList,
					description: "Remaining requirement failures, blocking risks or decisions. Every item prevents final acceptance. Nonblocking observations belong in summary; never omit an actual unresolved requirement."
				},
				sources: {
					type: "array",
					description: "Required for completed exploration: 1–12 workspace-relative file ranges, each at most 80 lines. Host captures exact text; no invented snippets.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							path: {
								type: "string",
								required: true
							},
							startLine: {
								type: "integer",
								required: true
							},
							endLine: {
								type: "integer",
								required: true
							}
						}
					}
				}
			},
			output: textOutput,
			execute: async (args, exec) => {
				const binding = this.#binding(agent, role), runtime = this.#runtime(binding.taskId);
				if (role === "lead" && (!runtime.takeover || !this.state(binding.taskId).currentWorkOrder)) throw new Error("Lead submission requires takeover of an existing work order");
				if (this.effects.pending(binding.taskId).length) throw new Error("Collect or stop every native job and settle effects before submitting a report");
				if (args.summary.length > 16e3 || args.unresolved.length > 30) throw new Error("Worker report is too large");
				const submitted = {
					summary: args.summary,
					unresolved: args.unresolved,
					status: args.status
				};
				const order = this.state(binding.taskId).currentWorkOrder;
				const explorationSubmitted = order.mode === "explore" ? captureExploration(this.store, order, snapshotWorkspace(runtime.root), submitted, args.sources ?? []) : void 0;
				this.#saveRuntime({
					...runtime,
					submitted,
					explorationSubmitted
				});
				if (role === "lead") {
					this.#release(binding.taskId);
					return this.#validate(agent, binding, exec);
				}
				exec.concludeTurn();
				return "Report persisted. The Lead will review after this Worker becomes quiescent.";
			}
		})));
		if (this.owner(agent)?.binding.profile.interactionMode === "model-like") dispose.push(scope.tools.register(defineTool({
			name: "fusion_read_state",
			description: "Read this task from durable storage only when needed, especially after compaction. Follow nextOffset until null to restore constraints before effectful tools.",
			parameters: {
				offset: { type: "integer" },
				limit: { type: "integer" }
			},
			output: textOutput,
			execute: async (args) => JSON.stringify(this.onDemand.read(agent, this.#binding(agent, role), role, args.offset, args.limit))
		})));
		if (role === "worker") return dispose;
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_takeover",
			description: this.owner(agent) && enforcedWorkflow(this.owner(agent).binding) ? "Acquire exclusive write ownership for a Lead correction only after the current implementation report and a recorded rework review. Preserve the frozen checks; submit the correction and review it again." : "Acquire exclusive write ownership for a small direct task, or for a Lead correction after the current Worker report. A delegated task keeps its frozen acceptance checks and review. Takeover is recorded separately from Worker implementation.",
			parameters: { reason: {
				type: "string",
				required: true
			} },
			output: textOutput,
			execute: async (args, exec) => {
				if (!args.reason.trim()) throw new Error("Takeover reason required");
				const binding = this.#binding(agent, "lead"), state = this.state(binding.taskId);
				const escalation = this.#escalation(binding);
				if (roleSeparated(binding) && !escalation) throw new Error("FUSION_LEAD_READ_ONLY: the Host has not unlocked takeover for this work order");
				if (!escalation && enforcedWorkflow(binding) && (!state.currentWorkOrder || state.reviewResult?.decision !== "rework")) throw new Error("FUSION_TAKEOVER_REQUIRES_REWORK: delegate first, inspect the current report and record a rework review before taking over");
				if (state.currentWorkOrder?.mode === "text") throw new Error("Use fusion_rework to revise the text report");
				if (state.currentWorkOrder?.mode === "explore") throw new Error("Exploration cannot grant a writer; send the implementation plan with fusion_delegate first");
				const stalled = escalation === "worker-step-limit" || escalation === "worker-stalled";
				if (state.currentWorkOrder && !this.#runtime(binding.taskId).submitted && !stalled && !this.#runtime(binding.taskId).takeover) throw new Error("Lead takeover waits for the current Worker report; use fusion_rework on the same Worker");
				if (state.acceptedChild) {
					const child = this.ctx.agents.get(SessionId$1(state.acceptedChild));
					if (child) await this.#stopJobs(binding.taskId, () => this.transport.stop(agent, child.id));
					else if (state.lease) throw new Error("Absent Worker still owns a recorded lease; reconcile first");
				}
				exec.signal.throwIfAborted();
				this.scopes.assertReady(agent);
				if (this.effects.pending(binding.taskId).length) throw new Error("Inspect unfinished Worker effects before takeover");
				this.#release(binding.taskId);
				const base = snapshotWorkspace(agent.session.header.cwd);
				const runtime = state.currentWorkOrder ? this.#runtime(binding.taskId) : {
					schemaVersion: 1,
					taskId: binding.taskId,
					root: base.root,
					base,
					checks: [],
					reworkRounds: 0,
					continuationRounds: 0
				};
				const leadSubmissions = (runtime.leadSubmissions ?? 0) + 1;
				this.#saveRuntime({
					...runtime,
					takeover: true,
					background: false,
					submitted: void 0,
					...escalation ? {
						escalation,
						leadSubmissions
					} : {}
				});
				if (escalation && state.currentWorkOrder) {
					const key = `lead-takeover:${binding.taskId}:${state.currentWorkOrder.id}`, prior = this.store.readDocument(key);
					this.store.writeDocument(key, prior?.revision ?? 0, {
						schemaVersion: 1,
						taskId: binding.taskId,
						workOrderId: state.currentWorkOrder.id,
						reason: escalation,
						reworkRounds: runtime.reworkRounds,
						leadSubmissions,
						at: (/* @__PURE__ */ new Date()).toISOString(),
						note: args.reason
					});
				}
				if (!state.currentWorkOrder) this.append(binding.taskId, "intent/chosen", { intent: "DIRECT" });
				this.#acquire(binding, base.root, agent.id, OperationId(randomUUID()));
				return "Lead owns the write lease. For an existing work order call fusion_submit_result after the correction. For direct work, fusion_delegate can transfer the lease after preparation; call fusion_finish_direct only when the entire user task is complete.";
			}
		})));
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_finish_direct",
			description: "Complete the entire direct user task or an answered read-only exploration. This closes the task; it is not a lease-release helper before delegation. Never use for an implementation work order. This does not claim independently verified acceptance.",
			parameters: {},
			output: textOutput,
			execute: async () => {
				const binding = this.#binding(agent, "lead"), state = this.state(binding.taskId);
				if (state.currentWorkOrder?.mode === "explore" && state.exploration?.status !== "completed") throw new Error("Exploration is incomplete. Use fusion_rework with specific feedback. Explain the blocker and end this turn if missing input is required; do not record an implementation review or completion.");
				const explored = state.currentWorkOrder?.mode === "explore" && state.phase === "PLANNING" && state.exploration?.workOrderId === state.currentWorkOrder.id && state.exploration.status === "completed";
				if (!explored && (state.currentWorkOrder || state.intent !== "DIRECT")) throw new Error("Use the bound report and review flow for delegated work");
				if (this.effects.pending(binding.taskId).length) throw new Error("Collect or stop every native job before completing the direct task");
				const snapshot = snapshotWorkspace(this.#runtime(binding.taskId).root);
				if (explored) {
					if (snapshot.id !== state.exploration.snapshot || state.lease) throw new Error("Read-only exploration workspace changed");
					this.append(binding.taskId, "intent/chosen", { intent: "DIRECT" });
				}
				this.#release(binding.taskId);
				this.append(binding.taskId, "task/completed", {
					snapshot: snapshot.id,
					verification: "unverified"
				});
				return "Direct task recorded; describe the checks you actually ran and any remaining uncertainty.";
			}
		})));
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_explore",
			description: "Optionally ask the persistent Worker for read-only code exploration before you plan implementation. It returns source-backed findings without changing files or running commands. Later fusion_delegate continues the same Worker.",
			parameters: {
				goal: {
					type: "string",
					required: true
				},
				brief: {
					type: "string",
					required: true
				},
				constraints: stringList,
				block: {
					type: "boolean",
					description: "Default true. False returns while exploration runs; use fusion_wait to collect findings."
				}
			},
			output: textOutput,
			execute: (args, exec) => this.delegate(agent, {
				...args,
				allowedPaths: [],
				checks: []
			}, exec, "explore")
		})));
		if (this.owner(agent)?.binding.profile.interactionMode === "model-like") dispose.push(scope.tools.register(defineTool({
			name: "fusion_delegate_text",
			description: "Delegate writing, synthesis or analysis of supplied material to the persistent Sidekick. No workspace, test runner or external tools required. Include the complete relevant material and success criteria in the brief. Review the report before delivering.",
			parameters: {
				goal: {
					type: "string",
					required: true
				},
				brief: {
					type: "string",
					required: true
				},
				constraints: stringList,
				block: { type: "boolean" }
			},
			output: textOutput,
			execute: (args, exec) => this.delegate(agent, {
				...args,
				allowedPaths: [],
				checks: []
			}, exec, "text")
		})));
		const checkItem = {
			type: "object",
			additionalProperties: false,
			properties: {
				command: {
					type: "string",
					required: true
				},
				id: {
					type: "string",
					description: "Default check-N."
				},
				description: {
					type: "string",
					description: "Default: the command."
				},
				parser: {
					type: "string",
					enum: [...TEST_PARSERS, "exit-code"],
					description: "A test runner with a count parser (go needs `go test -v`) is verified by its counts; omitted means exit code only."
				},
				kind: {
					type: "string",
					enum: ["test", "static-check"],
					description: "Usually inferred from parser."
				},
				timeoutSeconds: {
					type: "integer",
					description: `Optional per-check limit, 1–${MAX_CHECK_SECONDS} seconds.`
				},
				definitionPaths: {
					...optionalStringList,
					description: "Existing acceptance files whose bytes must remain unchanged; default none. Do not list files the Worker will create or edit."
				},
				baseline: {
					type: "string",
					enum: ["no-new-failures"],
					description: `For a broad regression suite (${BASELINE_PARSERS.join(", ")}) that may already have unrelated failing tests: the Host runs it once on the untouched workspace and then requires no new failures. Omit for the tests this task must make pass.`
				}
			}
		};
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_delegate",
			description: "Delegate a bounded implementation to an independent persistent Worker. After direct Lead preparation, validated delegation transfers the quiescent write lease without completing the task. By default wait for its report and native checks; block=false returns while the Worker runs.",
			parameters: {
				goal: {
					type: "string",
					description: "The complete implementation outcome, including all planned stages.",
					required: true
				},
				brief: {
					type: "string",
					description: "The current stage plan. Put temporary deferrals and sequencing here; later feedback may advance this stage.",
					required: true
				},
				constraints: {
					...optionalStringList,
					description: "Default none. Only durable requirements that remain true across every planned implementation stage. Do not freeze a temporary deferral such as not implementing stage two yet."
				},
				allowedPaths: {
					...stringList,
					description: "Workspace-relative allowed changes for all planned stages, including regression tests. The Worker cannot expand this set; after a report you can add paths with fusion_rework addAllowedPaths."
				},
				block: {
					type: "boolean",
					description: "Default true. False permits read-only Lead work while the Worker retains write ownership."
				},
				checks: {
					type: "array",
					required: true,
					items: checkItem,
					description: "Acceptance commands the Host runs after the Worker reports; [] for review-only work."
				},
				requirements: {
					...optionalStringList,
					description: "The user's hard requirements as exact quotes of their messages (required behaviour, names, strings, formats, acceptance criteria), 1-20 items. The Host verifies each quote against the user's words, freezes them for the Sidekick, and your accept must give one verdict per item."
				}
			},
			output: textOutput,
			execute: (args, exec) => this.delegate(agent, {
				...args,
				constraints: args.constraints ?? [],
				checks: normalizeChecks(args.checks),
				requirements: args.requirements ?? []
			}, exec)
		})));
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_rework",
			description: "Send specific Lead-authored feedback to the same persistent Worker, including advancing a planned implementation stage. Before a report this continues unfinished work within the Worker-step budget; after a report it consumes a rework round. Active generation and native job waits can be replaced without restarting a tracked job; an active foreground tool finishes before the new brief. Keep durable requirements unchanged. Do not suggest files outside the frozen allowed paths unless you add them with addAllowedPaths.",
			parameters: {
				feedback: {
					type: "string",
					required: true
				},
				block: {
					type: "boolean",
					description: "Default true. False returns after delivery; call fusion_wait for the report and checks."
				},
				addAllowedPaths: {
					...optionalStringList,
					description: "After a Worker report, when the task needs changes outside the frozen allowedPaths (for example an existing test elsewhere that encodes the old behaviour): workspace-relative paths to add. Paths are only added; the change is recorded and consumes this rework round."
				},
				checks: {
					type: "array",
					items: checkItem,
					description: "Omit to keep the frozen acceptance checks. Only when a frozen check itself is wrong (for example its interpreter does not exist on this host), pass the complete corrected set after the Worker report. Every existing definitionPath must stay protected; the amendment is recorded and consumes this rework round."
				}
			},
			output: textOutput,
			execute: (args, exec) => this.rework(agent, args.feedback, exec, args.block ?? true, args.checks && normalizeChecks(args.checks), args.addAllowedPaths)
		})));
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_wait",
			description: "Wait for the background Worker to become quiescent. Exploration returns source findings for planning; implementation runs its frozen native checks. Call sequentially after a handoff or feedback.",
			parameters: {},
			output: textOutput,
			execute: (_args, exec) => this.wait(agent, exec)
		})));
		dispose.push(scope.tools.register(defineTool({
			name: "fusion_review_result",
			description: "Record a completed Lead review bound to the candidate this native request received. Accept requires passing evidence.",
			parameters: {
				decision: {
					type: "string",
					enum: [
						"accept",
						"rework",
						"needs-decision"
					],
					required: true
				},
				reason: {
					type: "string",
					required: true
				},
				requirements: {
					type: "array",
					description: "Required to accept when the work order has user requirements: one verdict per requirement index.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							index: {
								type: "integer",
								required: true
							},
							met: {
								type: "boolean",
								required: true
							},
							evidence: {
								type: "string",
								required: true,
								description: "Where the candidate satisfies it: file and line, or the test that proves it."
							}
						}
					}
				}
			},
			output: textOutput,
			execute: async (args, exec) => this.review(agent, args.decision, args.reason, exec, args.requirements ?? [])
		})));
		return dispose;
	}
	async close() {
		await this.modelControl.close();
		this.#closing = true;
		const auxiliaryStopped = this.keepalive.close();
		for (const binding of this.bindings.selected()) {
			const parent = this.ctx.agents.get(SessionId$1(binding.sessionId));
			if (!parent) continue;
			if (parent.status !== "idle") parent.cancel({
				kind: "hook",
				reason: "Fusion runtime is unloading"
			}, { keepInbox: true });
			await parent.whenIdle();
			await this.#backgroundStops.get(binding.taskId);
			const state = this.state(binding.taskId);
			const workerId = binding.workerId ?? state.acceptedChild;
			const child = workerId && this.ctx.agents.get(SessionId$1(workerId));
			await this.#stopJobs(binding.taskId);
			if (child) {
				await this.transport.release(parent, child.id);
				this.scopes.detach(child);
			}
			if (!this.effects.pending(binding.taskId).length) this.#release(binding.taskId);
			await parent.whenIdle();
			this.scopes.detach(parent);
		}
		await Promise.all(this.#backgroundStops.values());
		await auxiliaryStopped;
		await this.activity.close();
		for (const dispose of this.#dispose.reverse()) dispose();
	}
};
//#endregion
//#region src/host/native-budget.ts
function nativeAuthorization(raw) {
	const keys = new Set([
		"schemaVersion",
		"kind",
		"approved",
		"authorizationId",
		"approvedBy",
		"expiresAt",
		"routes",
		"maxNativeRequests",
		"maxReservedOutputTokens",
		"costPolicy"
	]);
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.has(key))) throw new Error("Unknown authorization fields; this authorization cannot enforce a money limit");
	const value = raw;
	if (!value || value.schemaVersion !== 1 || value.kind !== "native-fusion-requests" || value.approved !== true || !value.authorizationId?.trim() || !value.approvedBy?.trim() || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() || !Number.isSafeInteger(value.maxNativeRequests) || value.maxNativeRequests <= 0 || !Number.isSafeInteger(value.maxReservedOutputTokens) || value.maxReservedOutputTokens <= 0 || value.costPolicy !== "unknown-cost-acknowledged" || !Array.isArray(value.routes) || !value.routes.length || value.routes.some((route) => !route.provider?.trim() || !route.model?.trim())) throw new Error("An unexpired, explicit native request spending authorization is required");
	return structuredClone(value);
}
const UNLIMITED_HOURS = 24 * 365 * 100;
/** Called only by explicit human settings actions (save or limits), never by a model tool. */
function authorizeConfiguredPair(store, routes, limits) {
	const input = limits;
	if (!input || input.acknowledgeAccountUsage !== true || input.acknowledgeUnknownCost !== true) throw new Error("请确认使用模型账号额度，以及次数限制并非金额上限");
	const integer = (key, max, fallback) => {
		const value = input[key];
		if (value === void 0 || value === null) return fallback;
		if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${key} 超出允许范围`);
		return Number(value);
	};
	const auth = nativeAuthorization({
		schemaVersion: 1,
		kind: "native-fusion-requests",
		approved: true,
		authorizationId: randomUUID(),
		approvedBy: "local-user-settings",
		expiresAt: new Date(Date.now() + integer("validHours", UNLIMITED_HOURS, UNLIMITED_HOURS) * 36e5).toISOString(),
		routes,
		maxNativeRequests: integer("maxNativeRequests", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
		maxReservedOutputTokens: integer("maxReservedOutputTokens", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
		costPolicy: "unknown-cost-acknowledged"
	});
	const prior = store.readDocument("settings:authorization");
	store.writeDocument("settings:authorization", prior?.revision ?? 0, auth);
	return auth;
}
var NativeRequestBudget = class {
	store;
	authorizationFile;
	constructor(store, authorizationFile) {
		this.store = store;
		this.authorizationFile = authorizationFile;
	}
	check(routes) {
		const raw = this.authorizationFile ? JSON.parse(readFileSync(this.authorizationFile, "utf8")) : this.store.readDocument("settings:authorization")?.value;
		if (!raw) throw new Error("请前往设置 → Fusion 启用调用额度");
		const auth = nativeAuthorization(raw);
		if (routes.some((route) => !auth.routes.some((allowed) => allowed.provider === route.provider && allowed.model === route.model))) throw new Error("The frozen model configuration is outside this spending authorization");
		const prior = this.store.readDocument(`budget:${auth.authorizationId}`)?.value;
		if (prior && prior.digest !== digestOf(auth)) throw new Error("Authorization changed under an existing id; record a new human authorization");
		if (Number(prior?.requests ?? 0) >= auth.maxNativeRequests || Number(prior?.reservedOutputTokens ?? 0) >= auth.maxReservedOutputTokens) throw new Error("Approved native request budget exhausted");
		return auth;
	}
	install(ctx, owner, onBlocked) {
		const budget = this;
		return ctx.on("llm/stream", async function* (request, next) {
			const agent = nativeRequestAgent(ctx, request), binding = agent && owner(agent);
			if (binding) try {
				budget.reserve({
					provider: request.provider,
					model: request.model
				}, request.maxTokens ?? 0);
			} catch (error) {
				onBlocked?.(binding.binding, error);
				throw error;
			}
			yield* next();
		}, { prepend: true });
	}
	reserve(route, maxOutputTokens) {
		const auth = this.check([route]);
		if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("A bounded output reservation is required");
		const key = `budget:${auth.authorizationId}`, prior = this.store.readDocument(key);
		const row = prior?.value;
		const requests = (row?.requests ?? 0) + 1, reservedOutputTokens = (row?.reservedOutputTokens ?? 0) + maxOutputTokens;
		if (requests > auth.maxNativeRequests || reservedOutputTokens > auth.maxReservedOutputTokens) throw new Error("This request exceeds the approved request/output budget");
		this.store.writeDocument(key, prior?.revision ?? 0, {
			schemaVersion: 1,
			digest: digestOf(auth),
			requests,
			reservedOutputTokens,
			lastReservationId: randomUUID(),
			actualBilledUsd: null,
			apiEquivalentUsd: null,
			maximumDollarCost: null
		});
	}
};
//#endregion
//#region src/host/http.ts
function trustedRequest(req) {
	if (![
		"127.0.0.1",
		"::1",
		"::ffff:127.0.0.1"
	].includes(req.socket.remoteAddress ?? "")) return false;
	if (req.headers["sec-fetch-site"] === "cross-site" || !req.headers.host) return false;
	try {
		const target = new URL(`http://${req.headers.host}`);
		if (![
			"localhost",
			"127.0.0.1",
			"[::1]"
		].includes(target.hostname)) return false;
		return !req.headers.origin || new URL(req.headers.origin).host === target.host;
	} catch {
		return false;
	}
}
function json(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	res.end(JSON.stringify(body));
}
async function readJson(req) {
	if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new Error("JSON content type required");
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 256 * 1024) throw new Error("Request body exceeds 256 KiB");
		chunks.push(Buffer.from(chunk));
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
	return value;
}
//#endregion
//#region src/host/status.ts
/** English copies of the stage and detail texts; the client shows them when DSH runs in English. */
const EN = {
	"正在停止": "Stopping",
	"正在等待已启动的操作收尾。": "Waiting for started operations to finish.",
	"等待检查": "Needs inspection",
	"请先核对中断的操作，再使用 /fusion recover 提交检查记录。": "Check the interrupted operations, then record the inspection with /fusion recover.",
	"已取消": "Cancelled",
	"等待确认": "Waiting for approval",
	"请在 DSH 的权限提示中处理待确认操作。": "Handle the pending approval in DSH's permission prompt.",
	"等待额度": "Waiting for quota",
	"请前往设置 → Fusion 查看额度，处理后使用 /fusion resume。": "See Settings → Fusion for the quota, then use /fusion resume.",
	"已暂停": "Paused",
	"使用 /fusion status 查看状态，确认后可用 /fusion resume 继续。": "Check /fusion status, then continue with /fusion resume.",
	"完成": "Done",
	"验证": "Verifying",
	"Worker 模型服务提示额度已耗尽，当前任务和文件已保留。恢复额度后发送消息继续。": "The Sidekick provider reported exhausted quota; the task and files are kept. Send a message to continue once quota is back.",
	"等待反馈": "Needs your input",
	"Worker 已达到本任务的执行次数上限，现有结果已保留。请查看会话中的未完成说明。": "The Sidekick reached this task's step limit; its results are kept. See the unfinished notes in the conversation.",
	"就绪": "Ready",
	"探索尚未完成，请查看会话中的阻塞说明；补充信息后会继续原 Worker。": "Exploration is unfinished: see the blocker in the conversation; the same Sidekick continues once you add the information.",
	"分析": "Analysing",
	"执行": "Working",
	"修改": "Revising",
	"审查": "Reviewing",
	"请处理 DSH 的待确认操作。": "Handle the pending DSH approval.",
	"请查看会话中的问题或阻塞说明。": "See the question or blocker in the conversation.",
	"请前往设置 → Fusion 查看调用额度。": "See Settings → Fusion for the request quota.",
	"请查看 /fusion status 并核对中断的操作。": "Check /fusion status and the interrupted operations.",
	"确认任务状态后，使用 /fusion resume 继续。": "Confirm the task state, then continue with /fusion resume.",
	"未完成": "Unfinished",
	"请查看会话中的错误和 /fusion status。": "See the error in the conversation and /fusion status.",
	"完成状态尚未确认，请查看 /fusion status。": "Completion is unconfirmed; see /fusion status.",
	"需要调整做法": "Needs a different approach",
	"等待模型": "Waiting for the model",
	"继续消息的投递结果尚未确认。检查会话后使用 /fusion recover 提交检查记录。": "Delivery of the continuation is unconfirmed. Check the conversation, then use /fusion recover."
};
const english = (text) => text == null ? text : EN[text] ?? text;
function taskStage(state, checking, workerStepLimitReached = false, workerQuotaExhausted = false) {
	const control = state.control;
	const value = (stage, detail = null, attention = false) => ({
		stage,
		detail,
		attention
	});
	if (control.mode === "stop-requested") return value("正在停止", "正在等待已启动的操作收尾。", true);
	if (control.recovering || control.outcomeUnknown) return value("等待检查", "请先核对中断的操作，再使用 /fusion recover 提交检查记录。", true);
	if (control.mode === "cancelled") return value("已取消");
	if (control.pendingApprovalIds.length) return value("等待确认", "请在 DSH 的权限提示中处理待确认操作。", true);
	if (control.budgetBlocked) return value("等待额度", "请前往设置 → Fusion 查看额度，处理后使用 /fusion resume。", true);
	if (control.mode === "paused") return value("已暂停", "使用 /fusion status 查看状态，确认后可用 /fusion resume 继续。", true);
	if (control.mode === "completed" && state.phase === "COMPLETED") return value("完成");
	if (checking) return value("验证");
	if (workerQuotaExhausted && [
		"WORKER_RUNNING",
		"REWORK",
		"PLANNING",
		"NEEDS_DECISION"
	].includes(state.phase)) return value("等待额度", "Worker 模型服务提示额度已耗尽，当前任务和文件已保留。恢复额度后发送消息继续。", true);
	if (workerStepLimitReached && [
		"WORKER_RUNNING",
		"REWORK",
		"PLANNING",
		"NEEDS_DECISION"
	].includes(state.phase)) return value("等待反馈", "Worker 已达到本任务的执行次数上限，现有结果已保留。请查看会话中的未完成说明。", true);
	switch (state.phase) {
		case "READY": return value("就绪");
		case "PLANNING": return state.currentWorkOrder?.mode === "explore" && state.exploration && state.exploration.status !== "completed" ? value("等待反馈", "探索尚未完成，请查看会话中的阻塞说明；补充信息后会继续原 Worker。", true) : value("分析");
		case "DIRECT":
		case "WORKER_RUNNING": return value("执行");
		case "REWORK": return value("修改");
		case "REVIEWING": return value("审查");
		case "WAITING_APPROVAL": return value("等待确认", "请处理 DSH 的待确认操作。", true);
		case "WAITING_USER":
		case "NEEDS_DECISION": return value("等待反馈", "请查看会话中的问题或阻塞说明。", true);
		case "WAITING_BUDGET": return value("等待额度", "请前往设置 → Fusion 查看调用额度。", true);
		case "RECOVERING": return value("等待检查", "请查看 /fusion status 并核对中断的操作。", true);
		case "PAUSED": return value("已暂停", "确认任务状态后，使用 /fusion resume 继续。", true);
		case "STOPPING": return value("正在停止", null, true);
		case "FAILED": return value("未完成", "请查看会话中的错误和 /fusion status。", true);
		case "CANCELLED": return value("已取消");
		case "COMPLETED": return value("等待检查", "完成状态尚未确认，请查看 /fusion status。", true);
	}
}
function subtotal(counts) {
	const known = counts.filter((count) => count?.state === "known");
	return {
		knownTokens: known.reduce((sum, count) => sum + count.tokens, 0),
		reportedRequests: known.length,
		totalRequests: counts.length
	};
}
/** Reads existing durable facts only. Polling never constructs a runtime or calls a model. */
function readFusionStatus(store, sessionId) {
	const binding = new BindingRepository(store).read(sessionId)?.binding;
	const base = {
		schemaVersion: 1,
		sessionId,
		selected: Boolean(binding?.selected),
		observedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	if (!binding?.selected) return base;
	const taskId = binding.taskId, state = store.load(taskId);
	if (!state || state.parent !== sessionId || state.profileDigest !== binding.profile.digest) throw new Error("Fusion 任务记录不一致，请检查存档");
	const rows = (prefix) => store.listDocumentIds(`${prefix}:${taskId}:`).map((id) => {
		const row = store.readDocument(id)?.value;
		if (!row || row.schemaVersion !== 1 || row.taskId !== taskId) throw new Error("Fusion 状态记录需要检查");
		return {
			id,
			row
		};
	});
	const usage = rows("usage").map(({ id, row }) => ({
		id,
		row,
		projection: projectLedger(restoreLedger(row.ledger))
	}));
	const effects = rows("native-effect");
	const checking = store.listDocumentIds(`check-invocation:${taskId}:`).some((id) => {
		const row = store.readDocument(id)?.value;
		if (!row?.evidence || row.evidence.taskId !== taskId) throw new Error("Fusion 验证记录需要检查");
		return row.evidence.state === "started";
	});
	const contexts = rows("context-request").sort((a, b) => b.row.checkedAt.localeCompare(a.row.checkedAt));
	const runtime = store.readDocument(`runtime:${taskId}`)?.value;
	const stop = runtime?.workerStepStop;
	const workerStepLimitReached = runtime?.schemaVersion === 1 && runtime.taskId === taskId && Boolean(stop && state.currentWorkOrder && stop.workOrderId === state.currentWorkOrder.id && stop.limit > 0 && stop.requests >= stop.limit);
	const failure = runtime?.workerFailure;
	const workerQuotaExhausted = runtime?.schemaVersion === 1 && runtime.taskId === taskId && Boolean(failure && state.currentWorkOrder && failure.workOrderId === state.currentWorkOrder.id && failure.childId === state.acceptedChild && failure.category === "quota-exhausted");
	const modelControl = readModelControl(store, binding);
	const waiting = modelControl && Object.entries(modelControl.waits).filter(([, wait]) => wait?.taskId === taskId);
	const modelStage = waiting?.length && state.control.mode !== "completed" && state.control.mode !== "cancelled" && !state.control.budgetBlocked && !checking && !state.control.recovering && !state.control.outcomeUnknown && !state.control.pendingApprovalIds.length ? {
		stage: waiting.some(([, wait]) => ["NO_PROGRESS", "WORKFLOW_INCOMPLETE"].includes(wait.code)) ? "需要调整做法" : "等待模型",
		detail: `${waiting.map(([role]) => role === "lead" ? "Lead" : "Sidekick").join("、")} 已暂停。请查看原因后继续。`,
		detailEn: `${waiting.map(([role]) => role === "lead" ? "Lead" : "Sidekick").join(" and ")} paused. See the reason, then continue.`,
		attention: true
	} : {};
	const pendingDelivery = modelControl?.operation && ["prepared", "dispatching"].includes(modelControl.operation.state) ? {
		stage: "等待检查",
		detail: "继续消息的投递结果尚未确认。检查会话后使用 /fusion recover 提交检查记录。",
		attention: true
	} : {};
	const stage = {
		...taskStage(state, checking, workerStepLimitReached, workerQuotaExhausted),
		...modelStage,
		...pendingDelivery
	};
	return {
		...base,
		task: {
			id: taskId,
			revision: state.revision,
			...stage,
			stageEn: english(stage.stage),
			detailEn: "detailEn" in stage && stage.detailEn ? stage.detailEn : english(stage.detail) ?? null,
			...modelControl ? { modelControl } : {},
			verification: state.verification,
			workerId: state.acceptedChild ?? binding.workerId ?? null,
			models: {
				lead: modelControl?.routes.lead ?? binding.profile.lead,
				worker: modelControl?.routes.worker ?? binding.profile.worker,
				compactor: binding.profile.compactor?.route ?? null
			},
			usage: {
				calls: usage.length,
				finalCalls: usage.filter((item) => item.projection.authority === "final").length,
				provisionalCalls: usage.filter((item) => item.projection.authority === "provisional").length,
				unreportedCalls: usage.filter((item) => item.projection.authority === "none").length,
				compactionCalls: usage.filter((item) => item.row.purpose === "compaction").length,
				keepaliveCalls: usage.filter((item) => item.row.purpose === "cache-keepalive").length,
				input: subtotal(usage.map((item) => item.projection.bill?.uncachedInput)),
				cacheRead: subtotal(usage.map((item) => item.projection.bill?.cacheRead)),
				output: subtotal(usage.map((item) => item.projection.bill?.output)),
				actualBilledUsd: null,
				upstreamHttpCalls: null,
				byRole: Object.fromEntries(["lead", "worker"].map((role) => {
					const own = usage.filter((item) => item.row.role === role);
					return [role, {
						calls: own.length,
						input: subtotal(own.map((item) => item.projection.bill?.uncachedInput)),
						cacheRead: subtotal(own.map((item) => item.projection.bill?.cacheRead)),
						output: subtotal(own.map((item) => item.projection.bill?.output))
					}];
				}))
			},
			automatedChecks: Array.isArray(runtime?.checks) && runtime?.taskId === taskId ? runtime.checks.length : null,
			requests: usage.sort((a, b) => b.row.startedAt.localeCompare(a.row.startedAt)).slice(0, 12).map(({ id, row, projection }) => ({
				id,
				role: row.role,
				purpose: row.purpose,
				provider: row.ledger.key.provider,
				model: row.ledger.key.model,
				outcome: row.outcome,
				authority: projection.authority,
				startedAt: row.startedAt
			})),
			tools: effects.sort((a, b) => b.row.startedAt.localeCompare(a.row.startedAt)).slice(0, 8).map(({ id, row }) => ({
				id,
				role: row.role,
				name: row.toolName,
				state: row.state,
				failed: row.nativeIsError === true,
				startedAt: row.startedAt
			})),
			contexts: ["lead", "worker"].flatMap((role) => {
				const row = contexts.find((item) => item.row.role === role)?.row;
				return row ? [{
					role,
					purpose: row.purpose,
					inputTokens: row.measurement.inputTokens,
					budget: row.budget,
					quality: row.measurement.quality,
					admitted: row.admitted,
					checkedAt: row.checkedAt
				}] : [];
			}),
			pendingApprovals: state.control.pendingApprovalIds.length,
			unsettledTools: effects.filter(({ row }) => row.state === "dispatch-started" || row.state === "outcome-unknown").length
		}
	};
}
//#endregion
//#region src/usage/normalize.ts
function finite(value) {
	if (value === null || value === void 0) return null;
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`usage must be a finite nonnegative number, got ${value}`);
	return value;
}
function applicability(value, present) {
	if (!present) return "not_applicable";
	if (value === null || value === void 0) return "unknown";
	return "known";
}
function toCount(value, status) {
	if (status === "not_applicable") return na();
	if (status === "unknown" || value === null) return unknown();
	return known(value);
}
function fromCount(value) {
	return value.state === "known" ? value.tokens : null;
}
function reasoningFromRaw(raw) {
	const present = Object.prototype.hasOwnProperty.call(raw, "reasoningTokens");
	const tokens = finite(raw.reasoningTokens);
	if (raw.outputIncludesReasoning === true) return {
		kind: "included",
		tokens
	};
	if (raw.outputIncludesReasoning === false) return {
		kind: "separate",
		tokens
	};
	if (!present) return {
		kind: "not_applicable",
		tokens: null
	};
	return {
		kind: "unknown",
		tokens
	};
}
function normalizeUsage(raw) {
	const cacheReadPresent = Object.prototype.hasOwnProperty.call(raw, "cacheReadTokens");
	const cacheRead = finite(raw.cacheReadTokens);
	const input = finite(raw.inputTokens);
	const includesCache = raw.inputIncludesCacheRead ?? null;
	const cacheReadStatus = applicability(raw.cacheReadTokens, cacheReadPresent);
	const split = splitInput(toCount(input, input === null ? "unknown" : "known"), toCount(cacheRead, cacheReadStatus), includesCache);
	const cacheWritePresent = Object.prototype.hasOwnProperty.call(raw, "cacheWriteTokens") || Object.prototype.hasOwnProperty.call(raw, "cacheWriteByTtl");
	let cacheWrite = {};
	let cacheWriteStatus = {};
	if (raw.cacheWriteByTtl) {
		cacheWrite = Object.fromEntries(Object.entries(raw.cacheWriteByTtl).map(([ttl, tokens]) => [ttl, finite(tokens)]));
		cacheWriteStatus = Object.fromEntries(Object.entries(raw.cacheWriteByTtl).map(([ttl, tokens]) => [ttl, applicability(tokens, true)]));
	} else if (cacheWritePresent) {
		cacheWrite = { default: finite(raw.cacheWriteTokens) };
		cacheWriteStatus = { default: applicability(raw.cacheWriteTokens, true) };
	}
	const output = finite(raw.outputTokens);
	const reasoningBilling = reasoningFromRaw(raw);
	return {
		uncachedInput: fromCount(split),
		cacheRead,
		cacheReadStatus,
		cacheWrite,
		cacheWriteStatus,
		output,
		reasoningOutputSubset: reasoningBilling.kind === "included" ? reasoningBilling.tokens : null,
		reasoningSeparate: reasoningBilling.kind === "separate" ? reasoningBilling.tokens : null,
		reasoningUnspecified: reasoningBilling.kind === "unknown" ? reasoningBilling.tokens : null,
		reasoningBilling,
		inputIncludesCacheRead: includesCache
	};
}
function cacheWritesFromUsage(usage) {
	const keys = Object.keys(usage.cacheWrite);
	if (!keys.length) return { kind: "not_applicable" };
	if (keys.some((key) => usage.cacheWriteStatus[key] === "unknown" || usage.cacheWrite[key] === null)) {
		if (keys.length === 1 && keys[0] === "default") return usage.cacheWriteStatus.default === "unknown" || usage.cacheWrite.default === null ? { kind: "unknown" } : {
			kind: "aggregate",
			rateKey: "default",
			tokens: toCount(usage.cacheWrite.default ?? null, usage.cacheWriteStatus.default ?? "known")
		};
	}
	if (keys.length === 1 && keys[0] === "default") return {
		kind: "aggregate",
		rateKey: "default",
		tokens: toCount(usage.cacheWrite.default ?? null, usage.cacheWriteStatus.default ?? (usage.cacheWrite.default === null ? "unknown" : "known"))
	};
	return {
		kind: "details",
		buckets: Object.fromEntries(keys.map((key) => [key, {
			rateKey: key,
			tokens: toCount(usage.cacheWrite[key] ?? null, usage.cacheWriteStatus[key] ?? (usage.cacheWrite[key] === null ? "unknown" : "known"))
		}]))
	};
}
function billFromUsage(usage) {
	const billing = usage.reasoningBilling ?? (usage.reasoningOutputSubset !== null ? {
		kind: "included",
		tokens: usage.reasoningOutputSubset
	} : usage.reasoningSeparate !== null ? {
		kind: "separate",
		tokens: usage.reasoningSeparate
	} : usage.reasoningUnspecified !== null ? {
		kind: "unknown",
		tokens: usage.reasoningUnspecified
	} : {
		kind: "not_applicable",
		tokens: null
	});
	return {
		uncachedInput: toCount(usage.uncachedInput, usage.uncachedInput === null ? "unknown" : "known"),
		cacheRead: toCount(usage.cacheRead, usage.cacheReadStatus),
		output: toCount(usage.output, usage.output === null ? "unknown" : "known"),
		cacheWrite: cacheWritesFromUsage(usage),
		reasoning: {
			kind: billing.kind,
			tokens: billing.kind === "not_applicable" ? na() : toCount(billing.tokens, billing.tokens === null ? "unknown" : "known")
		}
	};
}
function observationMode(meta) {
	if (meta?.source === "final") return "final";
	if (meta?.cumulative === false) return "delta";
	return "snapshot";
}
function asObservation(usage, meta, key, side) {
	const bill = billFromUsage(usage);
	const sequence = meta?.sequence ?? (side === "first" ? 0 : 1);
	return {
		id: meta?.observationId ?? `anon:${side}:${sequence}:${JSON.stringify(bill)}`,
		key,
		sequence,
		mode: observationMode(meta),
		bill
	};
}
function observationFromNormalized(usage, key, meta) {
	return asObservation(usage, {
		...meta,
		observationId: meta.id ?? meta.observationId
	}, key, "first");
}
function millionths(tokens, rate) {
	const [whole, frac = ""] = rate.split(".");
	const digits = `${whole}${frac.padEnd(6, "0").slice(0, 6)}`;
	const perMillion = BigInt(digits);
	return BigInt(tokens) * perMillion / 1000000n;
}
function decimalFromMillionths(value) {
	const negative = value < 0n;
	const abs = negative ? -value : value;
	const whole = abs / 1000000n;
	const frac = (abs % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
	const text = frac ? `${whole.toString()}.${frac}` : whole.toString();
	return UsdDecimal(negative ? `-${text}` : text);
}
function priceBucket(tokens, rate, label, kind, parts, reasons) {
	if (tokens === null) {
		if (kind === "required") reasons.push(`${label} tokens unknown`);
		return;
	}
	if (tokens === 0) return;
	if (rate === null || rate === void 0) {
		reasons.push(`${label} rate missing`);
		return;
	}
	parts.push(millionths(tokens, rate));
}
function priceUsage(usage, card) {
	if (!card) return {
		status: "unknown",
		totalUsd: null,
		observedUsd: null,
		reasons: ["no price card"]
	};
	const parts = [];
	const reasons = [];
	const unreliableBound = usage.inputIncludesCacheRead === true && usage.cacheReadStatus !== "known";
	if (unreliableBound) reasons.push("input includes cache but the cache split is unknown; observed is not a reliable lower bound");
	priceBucket(usage.uncachedInput, card.uncachedInputPerMillion, "uncachedInput", "required", parts, reasons);
	if (usage.cacheReadStatus === "unknown") reasons.push("cacheRead tokens unknown");
	else if (usage.cacheReadStatus === "known") priceBucket(usage.cacheRead, card.cacheReadPerMillion, "cacheRead", "optional", parts, reasons);
	priceBucket(usage.output, card.outputPerMillion, "output", "required", parts, reasons);
	for (const [ttl, tokens] of Object.entries(usage.cacheWrite)) {
		const status = usage.cacheWriteStatus[ttl] ?? (tokens === null ? "unknown" : "known");
		if (status === "unknown") {
			reasons.push(`cacheWrite.${ttl} tokens unknown`);
			continue;
		}
		if (status === "not_applicable") continue;
		priceBucket(tokens, card.cacheWritePerMillion?.[ttl] ?? card.cacheWritePerMillion?.default, `cacheWrite.${ttl}`, "optional", parts, reasons);
	}
	if (usage.reasoningBilling?.kind === "separate" || usage.reasoningSeparate !== null) {
		const rate = card.reasoningPerMillion ?? card.outputPerMillion;
		priceBucket(usage.reasoningBilling?.tokens ?? usage.reasoningSeparate, rate, "reasoningSeparate", "required", parts, reasons);
	}
	if (usage.reasoningBilling?.kind === "unknown" || usage.reasoningUnspecified !== null && usage.reasoningUnspecified !== 0) reasons.push("reasoning contract unspecified; cannot add or omit as a complete total");
	const observed = !unreliableBound && parts.length ? decimalFromMillionths(parts.reduce((sum, part) => sum + part, 0n)) : !unreliableBound && !parts.length ? null : null;
	const primaryMissing = usage.uncachedInput === null && usage.output === null && usage.cacheReadStatus !== "known" && Object.values(usage.cacheWriteStatus).every((status) => status !== "known") && usage.reasoningSeparate === null && usage.reasoningOutputSubset === null && usage.reasoningUnspecified === null;
	if (reasons.length && primaryMissing) return {
		status: "unknown",
		totalUsd: null,
		observedUsd: observed,
		reasons
	};
	if (reasons.length) return {
		status: "incomplete",
		totalUsd: null,
		observedUsd: observed,
		reasons
	};
	const total = observed ?? UsdDecimal("0");
	return {
		status: "complete",
		totalUsd: total,
		observedUsd: total,
		reasons: []
	};
}
function apiEquivalentUsd(usage, card) {
	const priced = priceUsage(usage, card);
	return priced.status === "complete" ? priced.totalUsd : null;
}
//#endregion
//#region src/usage/pricing.ts
function requireThat(value, code) {
	if (!value) throw new FusionError(USAGE_LEDGER_REQUIRED, code);
}
/** 18 decimal places in USD: a rate with <=12 decimals per 1e6 tokens is exact. */
function rateUnits(rate) {
	requireThat(/^\d+(?:\.\d{1,12})?$/.test(rate), "INVALID_PRICE_RATE");
	const [whole, frac = ""] = rate.split(".");
	return BigInt(whole + frac.padEnd(12, "0"));
}
function decimal(units) {
	const div = 10n ** 18n;
	const fraction = (units % div).toString().padStart(18, "0").replace(/0+$/, "");
	return `${units / div}${fraction ? `.${fraction}` : ""}`;
}
function quoteLedger(ledger, rates, priceCardDigest = digestOf(rates)) {
	const projection = projectLedger(restoreLedger(ledger));
	const bill = projection.bill;
	const missing = [];
	let units = 0n;
	function add(count, rate, name) {
		if (count.state === "not_applicable") return;
		if (count.state === "unknown") {
			missing.push(`${name}:unknown`);
			return;
		}
		requireThat(Number.isSafeInteger(count.tokens) && count.tokens >= 0, "INVALID_COUNT");
		if (count.tokens === 0) return;
		if (rate === void 0) {
			missing.push(`${name}:rate-missing`);
			return;
		}
		units += BigInt(count.tokens) * rateUnits(rate);
	}
	if (!bill) return {
		authority: projection.authority,
		status: "unknown",
		totalUsd: null,
		estimateUsd: null,
		priceCardDigest,
		missing: ["no-bill"]
	};
	add(bill.uncachedInput, rates.input, "input");
	add(bill.cacheRead, rates.cachedInput, "cache-read");
	add(bill.output, rates.output, "output");
	if (bill.cacheWrite.kind === "unknown") missing.push("cache-write:unknown");
	if (bill.cacheWrite.kind === "aggregate") add(bill.cacheWrite.tokens, rates.cacheWrite?.[bill.cacheWrite.rateKey], "cache-write");
	if (bill.cacheWrite.kind === "details") for (const [key, bucket] of Object.entries(bill.cacheWrite.buckets)) add(bucket.tokens, rates.cacheWrite?.[bucket.rateKey], `cache-write:${key}`);
	if (bill.reasoning.kind === "unknown") missing.push("reasoning-contract:unknown");
	if (bill.reasoning.kind === "separate") add(bill.reasoning.tokens, rates.reasoning, "reasoning");
	const complete = projection.authority === "final" && missing.length === 0;
	return {
		authority: projection.authority,
		status: complete ? "complete" : projection.authority === "final" ? "incomplete" : "provisional",
		totalUsd: complete ? decimal(units) : null,
		estimateUsd: decimal(units),
		priceCardDigest,
		missing
	};
}
//#endregion
//#region src/usage/budget.ts
var BudgetLedger = class {
	authorization;
	#spent = 0;
	#reserved = 0;
	constructor(authorization) {
		this.authorization = authorization;
	}
	assertAuthorized(model) {
		if (!this.authorization.approved || !this.authorization.authorizationId) throw new FusionError(SPEND_UNAUTHORIZED, "no approved spending authorization");
		if (model && this.authorization.allowedModels.length && !this.authorization.allowedModels.includes(model)) throw new FusionError(SPEND_UNAUTHORIZED, `model ${model} is not on the authorization allowlist`);
	}
	reserve(estimatedUsd, model) {
		this.assertAuthorized(model);
		if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new TypeError("estimatedUsd must be finite and nonnegative");
		const cap = this.authorization.maximumTotal === null ? null : Number(this.authorization.maximumTotal);
		if (cap !== null && this.#spent + this.#reserved + estimatedUsd > cap) throw new FusionError(SPEND_UNAUTHORIZED, "budget reservation would exceed maximumTotal");
		this.#reserved += estimatedUsd;
		const remaining = cap === null ? null : (cap - this.#spent - this.#reserved).toString();
		return {
			authorizationId: this.authorization.authorizationId,
			reserved: estimatedUsd.toString(),
			remaining
		};
	}
	settle(reserved, actualUsd) {
		const reservedN = Number(reserved.reserved);
		if (actualUsd === null) return;
		this.#reserved = Math.max(0, this.#reserved - reservedN);
		if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new TypeError("actualUsd must be finite and nonnegative");
		const cap = this.authorization.maximumTotal === null ? null : Number(this.authorization.maximumTotal);
		if (cap !== null && this.#spent + actualUsd > cap) throw new FusionError(SPEND_UNAUTHORIZED, "actual spend would exceed maximumTotal");
		this.#spent += actualUsd;
	}
	get reserved() {
		return this.#reserved;
	}
	get spent() {
		return this.#spent;
	}
};
function loadSpendingAuthorization(raw) {
	const value = raw;
	if (!value || value.schemaVersion !== 1) throw new TypeError("unsupported spending authorization schema");
	return {
		schemaVersion: 1,
		approved: value.approved === true,
		authorizationId: value.authorizationId ?? null,
		currency: value.currency ?? "USD",
		maximumTotal: value.maximumTotal ?? null,
		allowedModels: Array.isArray(value.allowedModels) ? value.allowedModels : [],
		expiresAt: value.expiresAt ?? null,
		approvedBy: value.approvedBy ?? null
	};
}
//#endregion
//#region src/approval/logical.ts
function answerApproval(approval, state, decisionBy = "human") {
	if (approval.state !== "pending") throw new FusionError(APPROVAL_SCOPE, `approval ${approval.id} is ${approval.state}`);
	return {
		...approval,
		state,
		decisionBy
	};
}
function consumeApproval(approval, scope) {
	if (approval.state === "consumed") throw new FusionError(APPROVAL_SCOPE, `approval ${approval.id} already consumed`);
	if (approval.state !== "approved") throw new FusionError(APPROVAL_SCOPE, `approval ${approval.id} is ${approval.state}, not approved`);
	if (approval.argsDigest !== scope.argsDigest || approval.snapshot !== scope.snapshot || approval.permissionPolicyDigest !== scope.permissionPolicyDigest) throw new FusionError(APPROVAL_SCOPE, `approval ${approval.id} scope no longer matches`);
	return {
		...approval,
		state: "consumed"
	};
}
function neverMeansDeny(policy) {
	return policy === "never";
}
function pendingDoesNotExpire(_approval, _nowMs) {
	return true;
}
//#endregion
//#region src/recovery/reconcile.ts
function reconcile(scan) {
	if (scan.reportAlreadyRecorded && !scan.parentDelivered) return { action: "return-stored-result" };
	if (scan.reportAlreadyRecorded && scan.parentDelivered) return { action: "idle" };
	if (scan.effectKnown === null && (scan.outbox.state === "dispatched" || scan.outbox.state === "claimed")) return {
		action: "outcome-unknown",
		code: OUTCOME_UNKNOWN
	};
	if (scan.outbox.state === "prepared" && scan.childPersistence === "missing" && scan.outbox.reservedChild) return {
		action: "retry-prepare",
		child: scan.outbox.reservedChild
	};
	if (scan.outbox.state === "accepted" && scan.childPersistence !== "present") return {
		action: "needs-repair",
		code: NEEDS_REPAIR
	};
	if ((scan.outbox.state === "accepted" || scan.outbox.state === "claimed") && scan.outbox.reservedChild) return {
		action: "resume-child",
		child: scan.outbox.reservedChild
	};
	return { action: "idle" };
}
//#endregion
//#region src/benchmark/naive.ts
/** A declared benchmark treatment, never installed in product sessions. */
const naivePrompts = {
	lead: "Complete the user task. You may work directly or use naive_delegate for a bounded implementation or test task. Every delegation starts a fresh independent Worker, which sees only your brief and the shared workspace. Include the relevant requirements and constraints in that brief. Inspect the returned result, correct defects or delegate again as needed, and run relevant tests before finishing. Delegation and direct commands run sequentially under the same total allowance.",
	worker: "Complete the delegated task using the native tools. Inspect the code, implement the requested changes and run relevant tests. Preserve existing acceptance tests. Return a concise account of changes, verification and unresolved limitations. This is a fresh independent session; you have no earlier Worker conversation."
};
/** Simple sequential coordinator using the native one-shot child lifecycle. */
var NaiveCoordinator = class {
	ctx;
	parent;
	store;
	profile;
	workerMaxTokens;
	tools;
	delegations = [];
	#dispose = [];
	#operations = /* @__PURE__ */ new Set();
	#controllers = /* @__PURE__ */ new Set();
	#delegating = false;
	#writer;
	#closed = false;
	#cleanupFailure;
	constructor(ctx, parent, store, profile, workerMaxTokens, tools = [nativeShellTool]) {
		this.ctx = ctx;
		this.parent = parent;
		this.store = store;
		this.profile = profile;
		this.workerMaxTokens = workerMaxTokens;
		this.tools = tools;
		const provider = ctx.subagents.getProvider("spawn");
		if (!provider || provider.inheritsParentContext !== false) throw new Error("Naive requires a fresh-context native spawn provider");
		this.#dispose.push(parent.ctx.systemPrompt.section({
			name: "naive-benchmark",
			order: 90,
			text: naivePrompts.lead
		}));
		this.#dispose.push(ctx.on("tools/execute", async (exec, next) => {
			if (!exec.agent || !this.owns(exec.agent)) return next();
			this.assertReady();
			if (!isShellTool(exec.name)) return next();
			if (this.#writer || this.#delegating && exec.agent === parent) throw new Error("Naive requires one native writer at a time");
			this.#writer = exec.token;
			try {
				return await next();
			} finally {
				if (this.#writer === exec.token) this.#writer = void 0;
			}
		}, { prepend: true }));
		this.#dispose.push(parent.ctx.tools.register(defineTool({
			name: "naive_delegate",
			description: "Run one fresh independent Worker on a complete task brief. Wait for its result and dispose it. A subsequent delegation starts a new Worker without prior chat history. Use sequentially with other tools.",
			parameters: { brief: {
				type: "string",
				required: true
			} },
			output: {
				schema: { type: "string" },
				render: (_args, text) => [{
					type: "text",
					text
				}]
			},
			execute: async (args, exec) => {
				if (exec.agent !== parent || this.#closed || this.#delegating || this.#writer) throw new Error("Naive delegation requires an idle exclusive Lead tool slot");
				const operation = this.#delegate(args.brief, exec.callId, exec.signal);
				this.#operations.add(operation);
				try {
					return await operation;
				} finally {
					this.#operations.delete(operation);
				}
			}
		})));
	}
	owns(agent) {
		return agent === this.parent || agent.session.header.parentSession === this.parent.id;
	}
	assertReady() {
		if (this.#closed) throw new Error("Naive benchmark is closing");
		if (this.#cleanupFailure) throw new Error(`Naive recording or cleanup failed: ${String(this.#cleanupFailure)}`);
	}
	async #delegate(brief, callId, signal) {
		if (!brief.trim()) throw new Error("A nonempty Worker brief is required");
		signal.throwIfAborted();
		this.#delegating = true;
		const controller = new AbortController();
		this.#controllers.add(controller);
		const row = {
			ordinal: this.delegations.length + 1,
			callId,
			briefDigest: digestOf(brief),
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			endedAt: null,
			childSessionId: null,
			parentSessionId: this.parent.id,
			state: "starting",
			stopReason: null,
			disposed: false,
			failure: null
		};
		this.delegations.push(row);
		const key = `naive-delegation:${this.parent.id}:${row.ordinal}`;
		let revision = 0, run;
		const persist = () => {
			revision = this.store.writeDocument(key, revision, { ...row });
		};
		try {
			persist();
			const route = this.profile.worker;
			run = await this.ctx.subagents.start("spawn", {
				parent: this.parent,
				label: `Naive Worker ${row.ordinal}`,
				prompt: [{
					type: "text",
					text: brief
				}],
				persona: naivePrompts.worker,
				signal: AbortSignal.any([signal, controller.signal]),
				agentOptions: {
					provider: route.provider,
					model: route.model,
					...route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {},
					maxTokens: this.workerMaxTokens
				},
				toolFilter: { allow: [...this.tools] },
				maxDepth: (this.parent.session.header.delegationDepth ?? 0) + 1
			});
			run.result.catch(() => void 0);
			if (!run.localAgent || run.localAgent.session.header.parentSession !== this.parent.id) throw new Error("Naive requires an owned native child");
			if (this.delegations.some((other) => other !== row && other.childSessionId === run.id)) throw new Error("Naive child identity was reused");
			row.childSessionId = run.id;
			row.state = "running";
			persist();
			const result = await run.result;
			row.stopReason = result.stopReason;
			row.state = "settled";
			persist();
			if (result.stopReason !== "completed") throw new Error(`Naive Worker ended ${result.stopReason}; its output is incomplete`);
			return JSON.stringify({
				childSessionId: run.id,
				stopReason: result.stopReason,
				output: result.output
			});
		} catch (error) {
			row.state = "failed";
			row.failure = String(error);
			throw error;
		} finally {
			try {
				if (run) {
					await run.dispose();
					if (this.ctx.agents.get(run.id)) throw new Error("Naive child remained resident after disposal");
					row.disposed = true;
				}
				row.endedAt = (/* @__PURE__ */ new Date()).toISOString();
				persist();
			} catch (error) {
				this.#cleanupFailure = error;
				throw error;
			} finally {
				this.#controllers.delete(controller);
				this.#delegating = false;
			}
		}
	}
	async close() {
		this.#closed = true;
		for (const controller of this.#controllers) controller.abort(/* @__PURE__ */ new Error("Naive benchmark closing"));
		await Promise.allSettled([...this.#operations]);
		for (const dispose of this.#dispose.reverse()) dispose();
		if (this.#cleanupFailure) throw this.#cleanupFailure;
		if (this.#writer || this.#delegating || this.delegations.some((row) => row.childSessionId && !row.disposed)) throw new Error("Naive child/tool quiescence unproven");
	}
};
//#endregion
//#region src/benchmark/output-limits.ts
/** Run before preregistration, then compare the exact snapshot before spending.
* Every treatment uses the same role's automatic product allowance; the profile
* reservation is a fallback, not a universal per-request cap.
*/
async function resolveBenchmarkOutputLimits(ctx, profile) {
	const roles = {};
	for (const role of ["lead", "worker"]) {
		const { provider, model } = profile[role];
		const { contextWindow, defaultMaxTokens, testedOutputCap } = await resolveModelOutputLimits(ctx, provider, model);
		const fallback = profile.context[role].reserveOutputTokens;
		roles[role] = {
			provider,
			model,
			contextWindow,
			adapterDefault: defaultMaxTokens ?? null,
			testedCap: testedOutputCap ?? null,
			fallback,
			maxTokens: requestOutputReservation(contextWindow, void 0, defaultMaxTokens, testedOutputCap, fallback)
		};
	}
	return {
		policy: "role-route-auto-v1",
		roles
	};
}
//#endregion
//#region src/benchmark/native-run.ts
const selfReviewPrompt = `Perform a second self-review of your work against the original user request. Inspect the current implementation, look for defects or missed requirements, fix any you find, and run the relevant tests. Preserve the existing acceptance tests. Use the remaining allowance for this same attempt; no additional budget has been granted. Finish with the result of this review and any unresolved limitations.`;
/**
* Run one fresh attempt through the same native AgentLoop and FusionCoordinator
* as the product. The caller composes public Host services and a sandboxed shell;
* this function does not implement another LLM/tool loop or grade candidate code.
*/
async function runNativeBenchmark(ctx, options) {
	if (!/^[a-zA-Z0-9._-]{1,120}$/.test(options.runId)) throw new Error("Invalid run id");
	if (![
		"lead_only",
		"worker_only",
		"worker_selfreview",
		"naive",
		"fusion"
	].includes(options.variant) || !["real", "synthetic"].includes(options.dataKind)) throw new Error("Invalid benchmark mode");
	if (!options.prompt.trim() || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Bounded attempt limits required");
	if (options.dataKind === "real" && !options.outputLimits) throw new Error("Real attempts require preregistered role output limits");
	const { profile, prompts } = options.profile;
	const benchmarkTools = [
		nativeShellTool,
		"read",
		"glob",
		"grep"
	];
	for (const name of benchmarkTools) if (!ctx.tools.get(name)) throw new Error(`Native benchmark requires the ${name} tool before any model request`);
	if (!profile.enabled) throw new Error("Disabled benchmark profile");
	const workspace = realpathSync(options.workspace);
	const inWorkspace = (path) => {
		const rel = relative(workspace, resolve(path));
		return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
	};
	if (inWorkspace(options.output) || inWorkspace(options.budget.store.filename) || options.budget.authorizationFile && inWorkspace(options.budget.authorizationFile)) throw new Error("Benchmark controller state and authorization must be outside the candidate workspace");
	const selfReview = options.variant === "worker_selfreview";
	const role = options.variant === "worker_only" || selfReview ? "worker" : "lead";
	const route = profile[role];
	const nativeRoute = {
		provider: route.provider,
		model: route.model,
		...route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}
	};
	options.budget.check(options.variant === "fusion" ? profileRoutes(profile) : options.variant === "naive" ? [profile.lead, profile.worker] : [route]);
	const outputLimits = await resolveBenchmarkOutputLimits(ctx, profile);
	if (options.outputLimits && digestOf(options.outputLimits) !== digestOf(outputLimits)) throw new Error("Frozen role output limits changed; preregister the new conditions before model calls");
	mkdirSync(options.output, { mode: 448 });
	const before = snapshotWorkspace(workspace);
	const store = new SqliteFusionStore(join(options.output, "fusion.sqlite"));
	const soloTask = TaskId(`benchmark-${options.runId}`);
	const startedAt = (/* @__PURE__ */ new Date()).toISOString(), started = performance.now();
	let requests = 0, timedOut = false, failure = null;
	let coordinator;
	let naive;
	let stopUsage;
	let stopGuard;
	let stopSessions;
	let timer;
	let workerSession;
	const childSessions = /* @__PURE__ */ new Map();
	const phases = [];
	const reserve = (actual, maxTokens) => {
		if (requests >= options.maxRequests) throw new Error("Attempt native request limit exhausted");
		options.budget.reserve(actual, maxTokens);
		requests++;
	};
	let parent;
	try {
		parent = (await ctx.agents.create({
			sessionId: SessionId$1(`bench-${options.runId}-${randomUUID()}`),
			meta: { cwd: workspace },
			agentOptions: {
				...nativeRoute,
				maxTokens: outputLimits.roles[role].maxTokens
			}
		})).agent;
		installModelSelection(parent.ctx, {
			current: nativeRoute,
			assembled: void 0
		});
	} catch (error) {
		store.close();
		throw error;
	}
	let taskId = soloTask;
	try {
		stopSessions = ctx.on("session/created", (session) => {
			if (session.header.parentSession === parent.id) childSessions.set(session.id, session);
		});
		if (options.variant === "fusion") {
			coordinator = new FusionCoordinator(ctx, store, {
				profile: options.profile,
				workerTools: benchmarkTools,
				leaseRoot: join(options.output, "leases"),
				maxWorkerSteps: options.maxRequests,
				commandMaxSeconds: 60,
				authorizeRequest: (_agent, binding) => {
					options.budget.check(profileRoutes(binding.profile));
				},
				reserveRequest: (request) => reserve(request, request.maxTokens ?? 0)
			});
			await coordinator.select(parent);
			taskId = coordinator.bindings.read(parent.id).binding.taskId;
		} else {
			if (options.variant === "naive") naive = new NaiveCoordinator(ctx, parent, store, profile, outputLimits.roles.worker.maxTokens, benchmarkTools);
			stopUsage = observeNativeUsage(ctx, store, (agent) => agent === parent ? {
				taskId,
				role
			} : naive?.owns(agent) ? {
				taskId,
				role: "worker"
			} : void 0);
		}
		stopGuard = ctx.on("llm/stream", async function* (request, next) {
			const agent = nativeRequestAgent(ctx, request);
			if (!agent || (coordinator ? !coordinator.owner(agent) : naive ? !naive.owns(agent) : agent !== parent)) throw new Error("Benchmark refuses unowned auxiliary model calls");
			naive?.assertReady();
			if (isAgentLoopRequest(request) && request.purpose === void 0) {
				const requestRole = coordinator?.owner(agent)?.role ?? (agent === parent ? role : "worker");
				const frozen = outputLimits.roles[requestRole];
				if (request.provider !== frozen.provider || request.model !== frozen.model || request.maxTokens !== frozen.maxTokens) throw new Error(`Benchmark ${requestRole} request diverged from frozen role output limits`);
			}
			if (!coordinator) reserve(request, request.maxTokens ?? 0);
			yield* next();
		}, { prepend: true });
		const frozen = {
			schemaVersion: 1,
			runId: options.runId,
			variant: options.variant,
			dataKind: options.dataKind,
			startedAt,
			pluginVersion: options.engineVersion ?? "unknown",
			profile,
			promptsDigest: digestOf(prompts),
			taskPromptDigest: digestOf(options.prompt),
			initialSnapshot: before,
			maxRequests: options.maxRequests,
			timeoutMs: options.timeoutMs,
			outputLimits,
			protocol: {
				requiredStages: selfReview ? ["implementation", "self_review"] : ["implementation"],
				selfReviewPromptDigest: selfReview ? digestOf(selfReviewPrompt) : null,
				...naive ? {
					delegationMode: "fresh-one-shot",
					rolePromptsDigest: digestOf(naivePrompts),
					completionRule: "parent-completed-and-children-quiescent"
				} : {}
			},
			tools: benchmarkTools,
			readToolSemantics: "readonly-command-vm-python-regex-fnmatch-v1",
			commandNetwork: "caller-must-attest",
			authorizationId: options.budget.check([route]).authorizationId
		};
		writeFileSync(join(options.output, "manifest.json"), JSON.stringify(frozen, null, 2), {
			mode: 384,
			flag: "wx"
		});
		timer = setTimeout(() => {
			timedOut = true;
			parent.cancel({
				kind: "hook",
				reason: "Benchmark attempt deadline"
			});
			for (const childId of childSessions.keys()) ctx.agents.get(SessionId$1(childId))?.cancel({
				kind: "hook",
				reason: "Benchmark attempt deadline"
			});
		}, options.timeoutMs);
		const turn = async (stage, text) => {
			const start = parent.session.snapshotEvents().length;
			const requestsBefore = requests;
			parent.followup(createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: { kind: "user" }
			}));
			await parent.whenIdle();
			const end = parent.session.snapshotEvents().slice(start).findLast((event) => event.type === "turn/end");
			const endReason = end?.type === "turn/end" ? end.data.reason : null;
			phases.push({
				stage,
				completed: endReason?.kind === "completed",
				nativeRequests: requests - requestsBefore,
				endReason
			});
		};
		await turn("implementation", options.prompt);
		if (selfReview && phases[0]?.completed && !timedOut) await turn("self_review", selfReviewPrompt);
	} catch (error) {
		failure = String(error);
	} finally {
		if (timer) clearTimeout(timer);
		const childId = coordinator?.bindings.read(parent.id)?.binding.workerId;
		workerSession = childId ? childSessions.get(childId) : void 0;
		try {
			await coordinator?.close();
			await naive?.close();
		} catch (error) {
			store.close();
			throw error;
		} finally {
			stopGuard?.();
			stopUsage?.();
			stopSessions?.();
		}
	}
	try {
		const state = coordinator?.state(taskId);
		const events = parent.session.snapshotEvents();
		const end = events.findLast((event) => event.type === "turn/end");
		const endReason = end?.type === "turn/end" ? end.data.reason : null;
		const protocolComplete = !timedOut && !failure && endReason?.kind === "completed" && phases.length === (selfReview ? 2 : 1) && phases.every((phase) => phase.completed) && (state ? state.phase === "COMPLETED" && state.verification === "verified" && !state.outcomeUnknown : true);
		const usage = store.listDocumentIds(`usage:${taskId}:`).map((id) => store.readDocument(id).value);
		const delivered = snapshotWorkspace(workspace);
		const workers = naive ? [...childSessions.values()] : workerSession ? [workerSession] : [];
		const workerSessions = workers.map((session, index) => ({
			sessionId: session.id,
			parentSessionId: session.header.parentSession,
			eventsFile: naive ? `worker-events-${String(index + 1).padStart(3, "0")}.json` : "worker-events.json"
		}));
		const result = {
			schemaVersion: 1,
			runId: options.runId,
			variant: options.variant,
			dataKind: options.dataKind,
			startedAt,
			endedAt: (/* @__PURE__ */ new Date()).toISOString(),
			wallSeconds: (performance.now() - started) / 1e3,
			parentSessionId: parent.id,
			workerSessionId: coordinator?.bindings.read(parent.id)?.binding.workerId ?? null,
			taskId,
			nativeRequests: requests,
			protocolComplete,
			artifactPass: null,
			workerParentSessionId: workerSession?.header.parentSession ?? null,
			workerSessions,
			...naive ? { naiveDelegations: naive.delegations } : {},
			status: timedOut ? "timeout" : protocolComplete ? "completed" : "failed",
			failure,
			endReason,
			phases,
			deliveredSnapshot: delivered,
			fusionState: state ?? null,
			usage,
			actualBilledUsd: null,
			apiEquivalentUsd: null,
			upstreamHttpCalls: null
		};
		writeFileSync(join(options.output, "parent-events.json"), JSON.stringify(events, null, 2), {
			mode: 384,
			flag: "wx"
		});
		workers.forEach((session, index) => writeFileSync(join(options.output, workerSessions[index].eventsFile), JSON.stringify(session.snapshotEvents(), null, 2), {
			mode: 384,
			flag: "wx"
		}));
		writeFileSync(join(options.output, "result.json"), JSON.stringify(result, null, 2), {
			mode: 384,
			flag: "wx"
		});
		return result;
	} finally {
		store.close();
	}
}
//#endregion
//#region src/dsh-model-fusion.ts
const name = "dsh-model-fusion";
const inject = [
	"agents",
	"sessions",
	"llm",
	"tools",
	"subagents",
	"systemPrompt",
	"webServer",
	"sessionController",
	"sessionQuery",
	"commands",
	"agentDefaultModel",
	"tokenMeter"
];
const defaultWorkerTools = [
	nativeShellTool,
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"job_output",
	"job_kill"
];
const Config = z.object({
	profilePath: z.string(),
	authorizationPath: z.string(),
	databasePath: z.string(),
	workerTools: z.array(z.string()).default(defaultWorkerTools)
});
async function apply(ctx, config = {}) {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const database = config.databasePath || join(dshHome, "plugins", "dsh-model-fusion", "state.sqlite");
	if (!isAbsolute(database)) throw new Error("Fusion databasePath must be absolute");
	const store = new SqliteFusionStore(database), bindings = new BindingRepository(store);
	const cachePolicy = new CachePolicy(store);
	backfillHistory(store);
	const budget = new NativeRequestBudget(store, config.authorizationPath);
	let defaultProfile;
	const physicalCatalog = async () => {
		const catalog = await ctx.sessionController.modelCatalog();
		return {
			...catalog,
			groups: catalog.groups.filter((group) => group.id !== FUSION_PROVIDER)
		};
	};
	const configuredProfile = async () => {
		defaultProfile = void 0;
		const saved = store.readDocument("settings:profile");
		if (!saved && (!config.profilePath || !isAbsolute(config.profilePath))) throw new Error(bi("请先在设置的 Fusion 页面选择 Lead 和 Worker", "Open Settings → Fusion and choose a Lead and a Sidekick first"));
		const raw = saved?.value ?? loadJsonObject(config.profilePath);
		const catalog = await physicalCatalog();
		const pair = validatePairChoice(raw, catalog);
		const next = saved ? modelProfileFromChoice(pair) : raw;
		defaultProfile = resolveProfile(next, next.interactionMode === "model-like" ? loadModelPromptBundle() : loadPromptBundle(), { authorizedRoutes: catalog.groups.flatMap((group) => group.models.map((model) => ({
			provider: group.id,
			model: model.id
		}))) });
		return defaultProfile;
	};
	const needsBudget = (profile) => Boolean(config.authorizationPath) || profile.interactionMode !== "model-like";
	let runtime;
	const effectiveRoutes = (binding) => profileRoutes({
		...binding.profile,
		lead: runtime?.modelControl.route(binding, "lead") ?? binding.profile.lead,
		worker: runtime?.modelControl.route(binding, "worker") ?? binding.profile.worker
	});
	let creating;
	const getRuntime = (frozen) => {
		if (runtime) return Promise.resolve(runtime);
		if (creating) return creating;
		creating = (async () => {
			runtime = new FusionCoordinator(ctx, store, {
				profile: frozen ?? await configuredProfile(),
				workerTools: config.workerTools ?? defaultWorkerTools,
				resumeAuthorization: (binding) => needsBudget(binding.profile) ? budget.check(effectiveRoutes(binding)).authorizationId : "native-account",
				authorizeRequest: (_agent, binding) => {
					if (!needsBudget(binding.profile)) return;
					try {
						budget.check(effectiveRoutes(binding));
					} catch (error) {
						const state = store.load(binding.taskId);
						if (state?.control.mode === "running" && !state.control.budgetBlocked) runtime?.append(binding.taskId, "budget/blocked", { reason: String(error) });
						throw error;
					}
				},
				reserveRequest: (request, binding) => {
					if (!needsBudget(binding.profile)) return;
					try {
						budget.reserve({
							provider: request.provider,
							model: request.model
						}, request.maxTokens ?? 0);
					} catch (error) {
						const state = store.load(binding.taskId);
						if (state?.control.mode === "running" && !state.control.budgetBlocked) runtime?.append(binding.taskId, "budget/blocked", { reason: String(error) });
						throw error;
					}
				}
			});
			return runtime;
		})().finally(() => {
			creating = void 0;
		});
		return creating;
	};
	ctx.effect(() => ctx.llm.registerAdapter([FUSION_PROVIDER], new FusionCatalogAdapter()));
	ctx.effect(() => installNativeFusionSelection(ctx, {
		coordinator: () => runtime,
		profile: () => defaultProfile,
		selection: (agent) => {
			const selection = agent.session.snapshotEvents().findLast((event) => event.type === "model/selection");
			if (selection?.type === "model/selection") return selection.data;
			if (bindings.read(agent.id)?.binding.selected) return {
				provider: FUSION_PROVIDER,
				model: FUSION_MODEL
			};
			const header = agent.session.requestHeader();
			return header ? {
				provider: header.config.provider,
				model: header.config.model
			} : ctx.agentDefaultModel.currentSelection();
		}
	}));
	const restoreFailure = /* @__PURE__ */ new Map();
	ctx.effect(() => ctx.on("agent/pre-step", async (payload, next) => {
		const binding = bindings.read(payload.agent.id)?.binding;
		if (!binding?.selected) return next();
		try {
			await getRuntime({
				profile: binding.profile,
				prompts: binding.prompts
			});
			if (restoreFailure.has(payload.agent.id)) restoreFailure.delete(payload.agent.id);
		} catch (error) {
			restoreFailure.set(payload.agent.id, String(error));
			return { kind: "reject" };
		}
		return next();
	}, { prepend: true }));
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/model-fusion",
		handler: async (req, res) => {
			if (!trustedRequest(req)) return json(res, 403, { error: "forbidden" });
			try {
				const url = new URL(req.url ?? "/", "http://localhost");
				if (req.method === "GET") {
					if (url.searchParams.get("view") === "history") return json(res, 200, readHistory(store, url.searchParams.get("cursor") ?? ""));
					if (url.searchParams.get("view") === "activity") return json(res, 200, await readHistoricalFusionActivity(ctx, store, url.searchParams.get("sessionId") ?? "", url.searchParams.get("callId") ?? "", Number(url.searchParams.get("after") ?? -1)));
					if (url.searchParams.get("view") === "status") return json(res, 200, readFusionStatus(store, url.searchParams.get("sessionId") ?? ""));
					if (url.searchParams.get("view") === "catalog") return json(res, 200, await ctx.sessionController.modelCatalog());
					if (url.searchParams.get("view") === "cache") {
						let profile;
						try {
							profile = await configuredProfile();
						} catch {
							profile = void 0;
						}
						return json(res, 200, {
							checked: CACHE_DEFAULTS_CHECKED,
							models: cacheView(cachePolicy, profile ? {
								lead: profile.profile.lead,
								worker: profile.profile.worker
							} : void 0, profile?.profile.cacheKeepalive)
						});
					}
					if (url.searchParams.get("view") === "settings") {
						const saved = store.readDocument("settings:profile");
						let profile, reason, authorized = false;
						try {
							profile = await configuredProfile();
							if (needsBudget(profile.profile)) budget.check(profileRoutes(profile.profile));
							authorized = true;
						} catch (error) {
							reason = error instanceof Error ? error.message : String(error);
						}
						return json(res, 200, {
							revision: saved?.revision ?? 0,
							catalog: await physicalCatalog(),
							pair: profile ? choiceFromProfile(profile.profile) : null,
							authorized,
							reason,
							managedAuthorization: Boolean(config.authorizationPath),
							policy: profile?.profile.interactionMode ?? "legacy",
							actualBilledUsd: null,
							apiEquivalentUsd: null
						});
					}
					const sessionId = url.searchParams.get("sessionId") ?? "";
					const binding = sessionId && bindings.read(sessionId)?.binding;
					let available = false, reason;
					try {
						const profile = binding && binding.selected ? {
							profile: binding.profile,
							prompts: binding.prompts
						} : await configuredProfile();
						(await getRuntime(profile)).transport.assertAvailable();
						if (needsBudget(profile.profile)) budget.check(profileRoutes(profile.profile));
						available = true;
					} catch (error) {
						reason = error instanceof Error ? error.message : String(error);
					}
					const state = binding && store.load(binding.taskId);
					return json(res, 200, {
						selected: Boolean(binding && binding.selected),
						available,
						...reason ? { reason } : {},
						...state ? { task: {
							id: state.taskId,
							phase: state.phase,
							verification: state.verification,
							workerId: state.acceptedChild
						} } : {}
					});
				}
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				const body = await readJson(req);
				if ([
					"continue",
					"switch-role",
					"schedule",
					"cancel-schedule"
				].includes(String(body.action))) {
					if (typeof body.sessionId !== "string" || typeof body.taskId !== "string" || !Number.isSafeInteger(body.revision)) throw new Error(bi("恢复参数无效", "Invalid recovery parameters"));
					const saved = bindings.read(body.sessionId);
					if (!saved?.binding.selected || saved.binding.taskId !== body.taskId || saved.binding.profile.interactionMode !== "model-like") throw new Error(bi("当前任务不支持此恢复操作", "This task does not support that recovery action"));
					const binding = saved.binding;
					const controller = await getRuntime({
						profile: binding.profile,
						prompts: binding.prompts
					});
					if (needsBudget(binding.profile)) budget.check(effectiveRoutes(binding));
					if (body.action === "cancel-schedule") {
						if (store.readDocument(`model-control:${body.sessionId}`)?.revision !== body.revision) throw new Error(bi("状态已变化，请刷新", "The state changed; refresh"));
						controller.modelControl.cancel(binding);
					} else if (body.action === "schedule") {
						if (typeof body.dueAt !== "string") throw new Error(bi("请选择继续时间", "Choose when to continue"));
						await controller.modelControl.schedule(body.sessionId, body.taskId, Number(body.revision), body.dueAt);
					} else {
						let change;
						if (body.action === "switch-role") {
							if (body.role !== "lead" && body.role !== "worker") throw new Error(bi("请选择要更换的角色", "Choose the role to switch"));
							const pair = validatePairChoice({
								lead: body.route,
								worker: body.route
							}, await physicalCatalog());
							change = {
								role: body.role,
								route: pair.lead
							};
							if (needsBudget(binding.profile)) budget.check(profileRoutes({
								...binding.profile,
								lead: controller.modelControl.route(binding, "lead"),
								worker: controller.modelControl.route(binding, "worker"),
								[change.role]: change.route
							}));
						}
						await controller.modelControl.continue(body.sessionId, body.taskId, Number(body.revision), change);
					}
					return json(res, 200, { ok: true });
				}
				if (body.action === "cache-setting") {
					if (typeof body.provider !== "string" || typeof body.model !== "string" || !body.provider || !body.model) throw new Error(bi("请选择模型", "Choose a model"));
					const setting = body.reset === true ? null : {
						...body.mode === void 0 || body.mode === null ? {} : { mode: body.mode },
						...body.intervalSeconds === void 0 || body.intervalSeconds === null ? {} : { intervalSeconds: Number(body.intervalSeconds) }
					};
					cachePolicy.save(body.provider, body.model, setting);
					return json(res, 200, { ok: true });
				}
				if (body.action === "configure") {
					if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error(bi("配置版本无效，请刷新后重试", "Invalid settings revision; refresh and retry"));
					const pair = validatePairChoice(body.pair, await physicalCatalog());
					const revision = store.writeDocument("settings:profile", Number(body.revision), modelProfileFromChoice(pair));
					await getRuntime(await configuredProfile());
					return json(res, 200, {
						ok: true,
						revision
					});
				}
				if (body.action === "authorize") {
					if (config.authorizationPath) throw new Error(bi("运行额度由外部授权文件管理，不能在此覆盖", "Run limits are managed by an external authorization file and cannot be overridden here"));
					const saved = store.readDocument("settings:profile");
					if (!saved || saved.revision !== body.revision) throw new Error(bi("模型组合已变化，请刷新后再启用额度", "The pair changed; refresh before enabling limits"));
					const profile = await configuredProfile();
					if (store.readDocument("settings:profile")?.revision !== body.revision) throw new Error(bi("模型组合已变化，请刷新后再启用额度", "The pair changed; refresh before enabling limits"));
					return json(res, 200, {
						ok: true,
						expiresAt: authorizeConfiguredPair(store, profileRoutes(profile.profile), body.limits).expiresAt
					});
				}
				throw new Error(bi("请使用原模型菜单选择 Fusion 或切换普通模型", "Use the model menu to select Fusion or another model"));
			} catch (error) {
				return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}));
	ctx.effect(() => ctx.commands.register({
		name: "fusion",
		description: bi("Fusion 状态、暂停、恢复与退出（不调用模型）", "Fusion status, pause, resume and exit (no model call)"),
		input: { hint: bi("status | pause | resume | recover [--effects-stopped] <检查记录> | off", "status | pause | resume | recover [--effects-stopped] <inspection note> | off") },
		handler: async (invocation) => {
			const [action = "status", ...note] = invocation.rawInput.trim().split(/\s+/);
			try {
				const binding = bindings.read(invocation.agent.id)?.binding;
				if (!binding?.selected) return {
					kind: "success",
					text: bi("当前会话未启用 Fusion。请在模型选择器中选择 Fusion · 自动。", "Fusion is not selected in this conversation. Choose Fusion · auto in the model menu.")
				};
				if (action === "status" || action === "") {
					const controller = await getRuntime({
						profile: binding.profile,
						prompts: binding.prompts
					});
					const state = store.load(binding.taskId);
					const unfinishedEffects = controller.effects.pending(binding.taskId).map(({ record }) => ({
						role: record.role,
						tool: record.toolName
					}));
					const usage = store.listDocumentIds(`usage:${state.taskId}:`).map((id) => store.readDocument(id).value);
					return {
						kind: "success",
						text: JSON.stringify({
							taskId: state.taskId,
							phase: state.phase,
							verification: state.verification,
							control: state.control,
							workerId: state.acceptedChild,
							modelCalls: usage.length,
							cacheKeepaliveCalls: usage.filter((row) => row.purpose === "cache-keepalive").length,
							compactionCalls: usage.filter((row) => row.purpose === "compaction").length,
							unfinishedEffects,
							...unfinishedEffects.length ? { recoveryHint: bi("请核对中断的工具操作，确认对应命令及子进程已停止；Host 退出不代表这些操作已结束。", "Check the interrupted tool operations and confirm their commands and child processes stopped; a Host exit does not end them.") } : {},
							actualBilledUsd: null,
							apiEquivalentUsd: null
						}, null, 2)
					};
				}
				const controller = await getRuntime({
					profile: binding.profile,
					prompts: binding.prompts
				});
				if (action === "pause") {
					controller.modelControl.cancel(binding);
					await controller.pause(invocation.agent);
				} else if (action === "resume") {
					const authorizationId = needsBudget(binding.profile) ? budget.check(effectiveRoutes(binding)).authorizationId : "native-account";
					if (binding.profile.interactionMode === "model-like") await controller.modelControl.continue(binding.sessionId, binding.taskId, store.readDocument(`model-control:${binding.sessionId}`)?.revision ?? 0);
					else await controller.resume(invocation.agent, authorizationId);
				} else if (action === "recover") await controller.reconcile(invocation.agent, {
					commandId: invocation.commandId,
					effectsStopped: note[0] === "--effects-stopped",
					note: (note[0] === "--effects-stopped" ? note.slice(1) : note).join(" ")
				});
				else if (action === "off") {
					await controller.clear(invocation.agent);
					await ctx.sessionController.selectModel({
						sessionId: SessionId$1(invocation.agent.id),
						...binding.profile.lead
					});
				} else throw new Error(bi("使用 /fusion status、pause、resume、recover <检查记录> 或 off", "Use /fusion status, pause, resume, recover <inspection note> or off"));
				return {
					kind: "success",
					text: action === "resume" ? binding.profile.interactionMode === "model-like" ? bi("已通过原生收件箱提交一次继续操作。", "One continuation was submitted through the native inbox.") : bi("Fusion 已恢复。发送下一条消息继续当前任务。", "Fusion resumed. Send a message to continue the task.") : bi(`Fusion ${action} 已完成。`, `Fusion ${action} done.`)
				};
			} catch (error) {
				return {
					kind: "error",
					text: error instanceof Error ? error.message : String(error)
				};
			}
		}
	}));
	ctx.effect(() => async () => {
		if (creating) await creating.catch(() => void 0);
		if (runtime) await runtime.close();
		store.close();
	});
	try {
		await getRuntime(await configuredProfile());
	} catch {
		const selected = bindings.selected()[0];
		if (selected) await getRuntime({
			profile: selected.profile,
			prompts: selected.prompts
		});
	}
	ctx.logger.info("[my-plugins/dsh-model-fusion] loaded");
}
//#endregion
export { ArtifactId, BudgetLedger, Config, DEFAULT_TEST_VERIFIERS, EpochId, FUSION_CONTEXT_BUDGET, FileFusionStore, FusionError, NEEDS_REPAIR, NativeRequestBudget, OUTCOME_UNKNOWN, OperationId, SPEND_UNAUTHORIZED, STORE_MIGRATION_REQUIRED, STORE_PROJECTION_VERSION, SessionId, SnapshotId, SqliteFusionStore, TERMINAL_PHASES, TaskId, USAGE_LEDGER_REQUIRED, UsdDecimal, WORK_ORDER_CONFLICT, WorkOrderId, WorkspaceWriteLease, answerApproval, apiEquivalentUsd, appendCapturedReviewResult, apply, assertCurrentSubject, assertFinalBudget, assertPlannedCheck, boundedOverflowRecovery, captureTicket, checkPlanDigest, classifyEffect, classifyReview, completeProfile, consumeApproval, createReviewTicket, digestOf, evaluateReport, failingRenameIo, ingestDurable, ingestObservation, inject, inputBudget, invocationHeader, loadJsonObject, loadPromptBundle, loadReviewOutboxByRequestId, loadSpendingAuthorization, measureRequest, memoryVerificationRegistry, name, neverMeansDeny, newLedger, normalizeTermination, normalizeUsage, observationFromNormalized, pendingDoesNotExpire, persistReviewRequest, priceUsage, projectLedger, promptDigests, promptManifest, quoteLedger, reconcile, reduce, reduceAll, reportSubject, requireStorageProjectionVersion, resolveBenchmarkOutputLimits, resolveInvocation, resolveProfile, restoreLedger, resultFromCapturedTicket, reviewAttemptFields, reviewOutboxRow, reviewReadinessReceipt, reviewRequestedEvent, runNativeBenchmark, sha256Hex, snapshotWorkspace, splitInput, toReducerReviewDecision };

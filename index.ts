/**
 * pi-runware — generic Runware tools for Pi.
 *
 * The registered provider has no models. It exists only for Pi's /login flow.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";

const RUNWARE_API_URL = "https://api.runware.ai/v1";
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_WAIT_SECONDS = 600;
const MAX_LOCAL_SOURCE_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_EMBEDDED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 4;
const MAX_OUTPUT_TEXT_BYTES = 48_000;

const SCHEMAS_BASE_URL = "https://schemas.runware.ai";
const RUNWARE_DOCS_HOST = "runware.ai";
const PRICING_CACHE_TTL_MS = 15 * 60_000;
const MAX_PRICING_LOOKUPS = 20;
const PRICING_LOOKUP_CONCURRENCY = 4;

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain",
	".csv": "text/csv",
	".md": "text/markdown",
};

const anyRecordSchema = Type.Record(Type.String(), Type.Unknown());

const contentBlockSchema = Type.Object({
	type: Type.String({ description: "Content type." }),
	field: Type.Optional(Type.String({ description: "Optional target task field." })),
	value: Type.Optional(Type.Unknown({ description: "Arbitrary value." })),
	text: Type.Optional(Type.String({ description: "Text value." })),
	source: Type.Optional(Type.String({ description: "URL, data URI, Runware UUID, or local file path." })),
	mimeType: Type.Optional(Type.String({ description: "Optional MIME type." })),
	role: Type.Optional(Type.String({ description: "Optional message role." })),
	append: Type.Optional(Type.Boolean({ description: "Force this content value to append as an array item." })),
}, { additionalProperties: true });

const runwareInferSchema = Type.Object({
	model: Type.Optional(Type.String({ description: "Runware model or AIR identifier." })),
	taskType: Type.Optional(Type.String({ description: "Runware task type." })),
	prompt: Type.Optional(Type.String({ description: "Convenience positive prompt." })),
	task: Type.Optional(anyRecordSchema),
	input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary task fields." })),
	tasks: Type.Optional(Type.Array(anyRecordSchema, { minItems: 1, description: "Raw task batch." })),
	content: Type.Optional(Type.Array(contentBlockSchema, { description: "Free-form content blocks." })),
	moderation: Type.Optional(StringEnum(["none", "low", "auto"] as const, {
		description: "Model moderation level. Defaults to none; falls back to low if none is rejected.",
	})),
	safety: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Raw Runware safety fields." })),
	providerSafety: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Raw provider-specific safety fields." })),
	moderationFields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
		description: "Arbitrary moderation field paths and values.",
	})),
	deliveryMethod: Type.Optional(Type.String({ description: "Runware delivery method." })),
	waitForCompletion: Type.Optional(Type.Boolean({ description: "Poll async tasks internally." })),
	pollIntervalMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60_000, description: "Polling interval." })),
	maxWaitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Maximum async wait." })),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "HTTP timeout." })),
	includeCost: Type.Optional(Type.Boolean({ description: "Request Runware cost." })),
	outputDir: Type.Optional(Type.String({ description: "Optional output download directory." })),
	embedOutputImages: Type.Optional(Type.Boolean({ description: "Embed small image outputs in tool content." })),
	maxEmbeddedImageBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 20 * 1024 * 1024, description: "Per-image embed limit." })),
});

const runwareModelsSchema = Type.Object({
	action: Type.Optional(StringEnum(["search", "inspect"] as const, { description: "Search or inspect." })),
	query: Type.Optional(Type.String({ description: "Search query." })),
	model: Type.Optional(Type.String({ description: "Model or AIR identifier to inspect." })),
	source: Type.Optional(Type.String({ description: "Model source filter." })),
	category: Type.Optional(Type.String({ description: "Category filter." })),
	architecture: Type.Optional(Type.String({ description: "Architecture filter." })),
	capabilities: Type.Optional(Type.Array(Type.String({ description: "Capability." }), { description: "Capability filters." })),
	visibility: Type.Optional(Type.String({ description: "Visibility filter." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Result limit." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Result offset." })),
	sort: Type.Optional(Type.String({ description: "Sort value." })),
	filters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Additional search fields." })),
	includeRaw: Type.Optional(Type.Boolean({ description: "Include raw model records." })),
});

type RunwareContentBlock = Static<typeof contentBlockSchema>;
type RunwareInferInput = Static<typeof runwareInferSchema>;
type RunwareModelsInput = Static<typeof runwareModelsSchema>;
type AnyRecord = Record<string, unknown>;
type RunwareEnvelope = { data?: AnyRecord[]; errors?: AnyRecord[]; [key: string]: unknown };
type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

type ModelPricing = {
	source: string;
	summary?: string;
	minimumUsd?: number;
	rates?: Array<{ configuration: string; usd: number }>;
};

type PricingCacheEntry = { expiresAt: number; pricing: ModelPricing };
const pricingCache = new Map<string, PricingCacheEntry>();

type ModerationState = {
	mode: "none" | "low" | "auto";
	injectedModeration: boolean;
	injectedCheckContent: boolean;
	/** True only when the plugin created settings solely for its default moderation field. */
	autoInjectedSettings: boolean;
};

function isRecord(value: unknown): value is AnyRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactText(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_TEXT_BYTES) return text;
	let result = text;
	while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_TEXT_BYTES - 128) {
		result = result.slice(0, Math.floor(result.length * 0.9));
	}
	return `${result}\n\n[Output truncated by pi-runware.]`;
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
	} catch {
		return undefined;
	}
}

function mimeTypeForPath(file: string, explicit?: string): string {
	if (explicit?.trim()) return explicit.trim();
	return MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function sourceToRunwareValue(source: string, cwd: string, mimeType?: string): Promise<string> {
	if (/^(?:https?:\/\/|data:)/i.test(source)) return source;
	const local = resolve(cwd, source);
	if (!existsSync(local)) return source;
	const info = await stat(local);
	if (!info.isFile()) throw new Error(`Content source is not a file: ${source}`);
	if (info.size > MAX_LOCAL_SOURCE_BYTES) {
		throw new Error(`Content source exceeds ${MAX_LOCAL_SOURCE_BYTES / 1024 / 1024} MiB: ${source}`);
	}
	const bytes = await readFile(local);
	return `data:${mimeTypeForPath(local, mimeType)};base64,${bytes.toString("base64")}`;
}

function recordAtPath(target: AnyRecord, parts: string[]): AnyRecord {
	let cursor = target;
	for (const part of parts) {
		if (!isRecord(cursor[part])) cursor[part] = {};
		cursor = cursor[part] as AnyRecord;
	}
	return cursor;
}

function setAtPath(target: AnyRecord, field: string, value: unknown): void {
	const parts = field.split(".").map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) throw new Error("Field path cannot be empty.");
	const parent = recordAtPath(target, parts.slice(0, -1));
	parent[parts[parts.length - 1]] = value;
}

function deleteAtPath(target: AnyRecord, field: string): void {
	const parts = field.split(".").map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) return;
	let cursor: AnyRecord | undefined = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor || !isRecord(cursor[part])) return;
		cursor = cursor[part] as AnyRecord;
	}
	if (cursor) delete cursor[parts[parts.length - 1]];
}

function appendAtPath(target: AnyRecord, field: string, value: unknown, forceArray = false): void {
	const parts = field.split(".").map((part) => part.trim()).filter(Boolean);
	if (parts.length === 0) throw new Error("content.field cannot be empty.");
	const parent = recordAtPath(target, parts.slice(0, -1));
	const last = parts[parts.length - 1];
	const existing = parent[last];
	const inferredArray = /(?:images?|videos?|audios?|files?|messages?|references?|frames?|elements?|items?)$/i.test(last);
	const asArray = forceArray || inferredArray;
	if (existing === undefined) parent[last] = asArray ? [value] : value;
	else if (Array.isArray(existing)) existing.push(value);
	else if (!asArray && typeof existing === "string" && typeof value === "string" && /(prompt|text|instruction)$/i.test(last)) {
		parent[last] = `${existing}\n${value}`;
	} else parent[last] = [existing, value];
}

function deepMerge(base: AnyRecord, override: AnyRecord): AnyRecord {
	const result: AnyRecord = { ...base };
	for (const [key, value] of Object.entries(override)) {
		result[key] = isRecord(result[key]) && isRecord(value)
			? deepMerge(result[key] as AnyRecord, value)
			: value;
	}
	return result;
}

async function valueForContentField(block: RunwareContentBlock, cwd: string): Promise<unknown> {
	const source = block.source ? await sourceToRunwareValue(block.source, cwd, block.mimeType) : undefined;
	const field = block.field ?? "";
	if ((field === "messages" || field.endsWith(".messages")) && block.role) {
		const messageContent = block.value ?? block.text ?? (source
			? { type: block.type, source, ...(block.mimeType ? { mimeType: block.mimeType } : {}) }
			: { type: block.type });
		return { role: block.role, content: messageContent };
	}
	if (block.value !== undefined) return block.value;
	if (source !== undefined) return source;
	if (block.text !== undefined) return block.text;
	return { type: block.type, ...(block.role ? { role: block.role } : {}) };
}

async function applyContent(task: AnyRecord, content: RunwareContentBlock[] | undefined, cwd: string): Promise<void> {
	for (const block of content ?? []) {
		const source = block.source ? await sourceToRunwareValue(block.source, cwd, block.mimeType) : undefined;
		if (block.field) {
			appendAtPath(task, block.field, await valueForContentField(block, cwd), block.append ?? false);
			continue;
		}
		const stored: AnyRecord = { type: block.type };
		if (block.role !== undefined) stored.role = block.role;
		if (block.text !== undefined) stored.text = block.text;
		if (source !== undefined) stored.source = source;
		if (block.mimeType !== undefined) stored.mimeType = block.mimeType;
		if (block.append !== undefined) stored.append = block.append;
		if (block.value !== undefined) stored.value = block.value;
		if (task.content === undefined) task.content = [stored];
		else if (Array.isArray(task.content)) (task.content as unknown[]).push(stored);
		else task.content = [task.content, stored];
	}
}

function applyModeration(task: AnyRecord, params: RunwareInferInput): ModerationState {
	const hadSettings = isRecord(task.settings);
	const hasExplicitSettingsOverride = Object.keys(params.moderationFields ?? {}).some((field) => field === "settings" || field.startsWith("settings."));
	const settings = recordAtPath(task, ["settings"]);
	const safety = recordAtPath(task, ["safety"]);
	if (params.safety) Object.assign(safety, params.safety);
	const injectedCheckContent = safety.checkContent === undefined;
	if (injectedCheckContent) safety.checkContent = false;

	const mode = params.moderation ?? (typeof settings.moderation === "string"
		? settings.moderation as ModerationState["mode"]
		: "none");
	const injectedModeration = params.moderation !== undefined || settings.moderation === undefined;
	if (injectedModeration) settings.moderation = mode;

	if (params.providerSafety) {
		task.providerSettings = deepMerge(
			isRecord(task.providerSettings) ? task.providerSettings as AnyRecord : {},
			params.providerSafety,
		);
	}
	for (const [field, value] of Object.entries(params.moderationFields ?? {})) {
		setAtPath(task, field, value);
	}
	return {
		mode,
		injectedModeration,
		injectedCheckContent,
		autoInjectedSettings: !hadSettings && params.moderation === undefined && !hasExplicitSettingsOverride,
	};
}

function applyCommonTaskFields(task: AnyRecord, params: RunwareInferInput): { task: AnyRecord; moderation: ModerationState } {
	const result: AnyRecord = { ...task, ...(params.input ?? {}) };
	if (params.model !== undefined) result.model = params.model;
	if (params.taskType !== undefined) result.taskType = params.taskType;
	if (params.prompt !== undefined && result.positivePrompt === undefined && result.prompt === undefined) {
		result.positivePrompt = params.prompt;
	}
	if (params.deliveryMethod !== undefined) result.deliveryMethod = params.deliveryMethod;
	if (params.includeCost !== undefined) result.includeCost = params.includeCost;
	else if (result.includeCost === undefined) result.includeCost = true;
	if (result.taskType === undefined) result.taskType = "imageInference";
	if (result.taskUUID === undefined) result.taskUUID = randomUUID();
	const moderation = typeof result.model === "string" && result.model.trim()
		? applyModeration(result, params)
		: { mode: "auto" as const, injectedModeration: false, injectedCheckContent: false, autoInjectedSettings: false };
	return { task: result, moderation };
}

async function buildTasks(params: RunwareInferInput, cwd: string): Promise<{ tasks: AnyRecord[]; moderation: ModerationState[] }> {
	const rawTasks = params.tasks?.length ? params.tasks : [params.task ?? {}];
	const tasks: AnyRecord[] = [];
	const moderation: ModerationState[] = [];
	for (const rawTask of rawTasks) {
		const built = applyCommonTaskFields({ ...rawTask }, params);
		await applyContent(built.task, params.content, cwd);
		tasks.push(built.task);
		moderation.push(built.moderation);
	}
	return { tasks, moderation };
}

async function resolveApiKey(ctx: ExtensionContext): Promise<string> {
	const environmentKey = process.env.RUNWARE_API_KEY?.trim();
	if (environmentKey) return environmentKey;
	try {
		const credential = readStoredCredential("runware");
		if (credential?.type === "api_key" && credential.key) return credential.key;
		if (credential?.type === "oauth" && credential.access) return credential.access;
	} catch {
		// Provider auth below covers normal /login storage.
	}
	const resolved = await ctx.modelRegistry.getProviderAuth("runware");
	const storedKey = resolved?.auth.apiKey?.trim();
	if (storedKey) return storedKey;
	throw new Error("Runware API key is not configured. Run /login runware or set RUNWARE_API_KEY.");
}

function combinedSignal(signal: AbortSignal | undefined, timeoutSeconds: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function runwareRequest(
	tasks: AnyRecord[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	timeoutSeconds: number,
): Promise<RunwareEnvelope> {
	const apiKey = await resolveApiKey(ctx);
	const response = await fetch(RUNWARE_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(tasks),
		signal: combinedSignal(signal, timeoutSeconds),
	});
	const text = await response.text();
	let body: RunwareEnvelope;
	try {
		body = text ? JSON.parse(text) as RunwareEnvelope : {};
	} catch {
		body = { errors: [{ code: "invalidResponse", message: text || `HTTP ${response.status}` }] };
	}
	if (!response.ok && (!Array.isArray(body.errors) || body.errors.length === 0)) {
		throw new Error(`Runware HTTP ${response.status}: ${compactText(body)}`);
	}
	return body;
}

function taskUUIDs(tasks: AnyRecord[]): string[] {
	return tasks
		.map((task) => typeof task.taskUUID === "string" ? task.taskUUID : undefined)
		.filter((value): value is string => Boolean(value));
}

function responseHasOnlyErrors(response: RunwareEnvelope): boolean {
	return (!response.data || response.data.length === 0) && Boolean(response.errors?.length);
}

function errorText(response: RunwareEnvelope): string {
	return (response.errors ?? []).map((error) =>
		`${String(error.parameter ?? "")} ${String(error.code ?? "")} ${String(error.message ?? "")}`.toLowerCase(),
	).join("\n");
}

function isModerationFieldError(response: RunwareEnvelope): boolean {
	if (!responseHasOnlyErrors(response)) return false;
	return (response.errors ?? []).some((error) => {
		const code = String(error.code ?? "").toLowerCase();
		if (code === "invalidprovidercontent" || code === "contentpolicyviolation") return false;
		const param = String(error.parameter ?? "").toLowerCase();
		const msg = String(error.message ?? "").toLowerCase();
		return /moderation|safety|checkcontent/.test(param) ||
			(/parameter|unsupported|invalid value/i.test(msg) && /moderation|safety|checkcontent/.test(msg));
	});
}

function isSettingsReferenceConflict(response: RunwareEnvelope): boolean {
	if (!responseHasOnlyErrors(response)) return false;
	return (response.errors ?? []).some((error) => {
		const fields = [error.parameter1, error.parameter2, error.message]
			.map((value) => String(value ?? "").toLowerCase())
			.join(" ");
		return /settings/.test(fields) && /referenceimages|inputs\.referenceimages/.test(fields);
	});
}

function cloneForRetry(tasks: AnyRecord[]): AnyRecord[] {
	return tasks.map((task) => ({ ...structuredClone(task), taskUUID: randomUUID() }));
}

async function runWithModerationFallback(
	initialTasks: AnyRecord[],
	states: ModerationState[],
	params: RunwareInferInput,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	timeoutSeconds: number,
): Promise<{ response: RunwareEnvelope; tasks: AnyRecord[]; warnings: string[] }> {
	let tasks = initialTasks;
	let response = await runwareRequest(tasks, ctx, signal, timeoutSeconds);
	const warnings: string[] = [];
	const shouldFallback = states.some((state) => state.mode === "none");
	if (shouldFallback && isModerationFieldError(response)) {
		tasks = cloneForRetry(tasks);
		for (const task of tasks) setAtPath(task, "settings.moderation", "low");
		warnings.push("Runware rejected moderation:none; retried with moderation:low.");
		response = await runwareRequest(tasks, ctx, signal, timeoutSeconds);
	}
	if (isModerationFieldError(response)) {
		const retried = cloneForRetry(tasks);
		for (const task of retried) deleteAtPath(task, "settings.moderation");
		warnings.push("Runware rejected the model moderation field; retried without that model-specific field while retaining other supplied safety fields.");
		tasks = retried;
		response = await runwareRequest(tasks, ctx, signal, timeoutSeconds);
	}
	if (responseHasOnlyErrors(response) && /checkcontent/.test(errorText(response))) {
		const retried = cloneForRetry(tasks);
		for (const task of retried) deleteAtPath(task, "safety.checkContent");
		warnings.push("Runware rejected safety.checkContent; retried without that unsupported field.");
		tasks = retried;
		response = await runwareRequest(tasks, ctx, signal, timeoutSeconds);
	}
	if (isSettingsReferenceConflict(response) && states.some((state) => state.autoInjectedSettings)) {
		const retried = cloneForRetry(tasks);
		for (let index = 0; index < retried.length; index++) {
			if (states[index]?.autoInjectedSettings) deleteAtPath(retried[index], "settings");
		}
		warnings.push("Runware model rejects settings together with referenceImages; retried without the plugin-injected settings object.");
		tasks = retried;
		response = await runwareRequest(tasks, ctx, signal, timeoutSeconds);
	}
	return { response, tasks, warnings };
}

const TERMINAL_TASK_STATUSES = new Set([
	"success", "succeeded", "completed", "failed", "error", "cancelled", "canceled", "expired", "deleted",
]);

function responseIsTerminal(response: RunwareEnvelope): boolean {
	if (Array.isArray(response.errors) && response.errors.length > 0) return true;
	const data = response.data ?? [];
	if (data.length === 0) return false;
	return data.every((item) => {
		const status = typeof item.status === "string" ? item.status.toLowerCase() : undefined;
		if (status) return TERMINAL_TASK_STATUSES.has(status);
		// Initial async acknowledgements contain only taskUUID/taskType. They are
		// not complete until a poll returns an actual output resource.
		return collectOutputUrls(item).length > 0;
	});
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(resolvePromise, milliseconds);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Runware request aborted"));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForAsyncTasks(
	tasks: AnyRecord[],
	initial: RunwareEnvelope,
	params: RunwareInferInput,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<RunwareEnvelope> {
	if (!params.waitForCompletion || responseIsTerminal(initial)) return initial;
	const ids = taskUUIDs(tasks);
	if (ids.length === 0) return initial;
	const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const maxWait = (params.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS) * 1000;
	const started = Date.now();
	let interval = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	let latest = initial;
	while (Date.now() - started < maxWait) {
		await sleep(interval, signal);
		latest = await runwareRequest(
			ids.map((taskUUID) => ({ taskType: "getResponse", taskUUID })),
			ctx,
			signal,
			timeoutSeconds,
		);
		if (responseIsTerminal(latest)) return latest;
		interval = Math.min(Math.round(interval * 1.5), 15_000);
	}
	return latest;
}

function collectOutputUrls(value: unknown, urls = new Set<string>(), seen = new WeakSet<object>()): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectOutputUrls(item, urls, seen);
		return [...urls];
	}
	if (!isRecord(value)) return [...urls];
	if (seen.has(value)) return [...urls];
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		if (typeof child === "string" && /(?:url|uri)$/i.test(key)) {
			const url = httpUrl(child);
			if (url) urls.add(url);
		}
		collectOutputUrls(child, urls, seen);
	}
	return [...urls];
}

function mediaExtension(url: string, mediaType?: string | null): string {
	const extensions: Record<string, string> = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/webp": ".webp",
		"image/gif": ".gif",
		"video/mp4": ".mp4",
		"video/webm": ".webm",
		"audio/mpeg": ".mp3",
		"audio/wav": ".wav",
		"audio/ogg": ".ogg",
		"model/gltf-binary": ".glb",
		"application/octet-stream": ".bin",
	};
	const normalized = mediaType?.split(";")[0].toLowerCase();
	if (normalized && extensions[normalized]) return extensions[normalized];
	try {
		const extension = extname(new URL(url).pathname);
		return extension && extension.length <= 12 ? extension : ".bin";
	} catch {
		return ".bin";
	}
}

async function saveOutputUrls(urls: string[], outputDir: string, taskId: string, signal?: AbortSignal): Promise<string[]> {
	const directory = resolve(outputDir);
	await mkdir(directory, { recursive: true });
	const saved: string[] = [];
	for (let index = 0; index < urls.length; index++) {
		const response = await fetch(urls[index], { signal });
		if (!response.ok) throw new Error(`Failed to download Runware output ${index + 1}: HTTP ${response.status}`);
		const extension = mediaExtension(urls[index], response.headers.get("content-type"));
		const destination = resolve(directory, `runware-${taskId}-${index + 1}${extension}`);
		await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
		saved.push(destination);
	}
	return saved;
}

async function embedOutputImages(
	urls: string[],
	maxBytes: number,
	signal: AbortSignal | undefined,
): Promise<{ images: ToolContent[]; warnings: string[] }> {
	const images: ToolContent[] = [];
	const warnings: string[] = [];
	for (const url of urls) {
		if (images.length >= MAX_EMBEDDED_IMAGES) break;
		try {
			const response = await fetch(url, { signal });
			if (!response.ok) continue;
			const mediaType = response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
			const expectedSize = Number(response.headers.get("content-length") ?? 0);
			if (!mediaType.startsWith("image/") || (expectedSize > 0 && expectedSize > maxBytes)) continue;
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > maxBytes) {
				warnings.push(`Skipped embedding image larger than ${maxBytes} bytes: ${url}`);
				continue;
			}
			images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mediaType });
		} catch {
			warnings.push(`Could not embed output image: ${url}`);
		}
	}
	return { images, warnings };
}

async function formatInferenceResult(
	response: RunwareEnvelope,
	tasks: AnyRecord[],
	params: RunwareInferInput,
	warnings: string[],
	signal: AbortSignal | undefined,
): Promise<{ content: ToolContent[]; details: AnyRecord }> {
	const urls = collectOutputUrls(response.data ?? []);
	const ids = taskUUIDs(tasks);
	const saved = params.outputDir && urls.length
		? await saveOutputUrls(urls, params.outputDir, ids[0] ?? "output", signal)
		: [];
	const embedded = params.embedOutputImages
		? await embedOutputImages(urls, params.maxEmbeddedImageBytes ?? DEFAULT_MAX_EMBEDDED_IMAGE_BYTES, signal)
		: { images: [] as ToolContent[], warnings: [] as string[] };
	const allWarnings = [...warnings, ...embedded.warnings];
	const details: AnyRecord = {
		service: "runware",
		taskUUIDs: ids,
		outputUrls: urls,
		saved,
		warnings: allWarnings,
		response,
	};
	const text = compactText({
		taskUUIDs: ids,
		status: Array.isArray(response.errors) && response.errors.length ? "error" : "completed-or-pending",
		outputUrls: urls,
		saved,
		warnings: allWarnings,
		data: response.data ?? [],
		errors: response.errors ?? [],
	});
	return { content: [{ type: "text", text }, ...embedded.images], details };
}

async function fetchModelSchema(air: string, signal?: AbortSignal): Promise<{ requestSchema?: AnyRecord; responseSchema?: AnyRecord; documentation?: string } | null> {
	const url = `${SCHEMAS_BASE_URL}/resolve/${encodeURIComponent(air.trim())}`;
	try {
		const response = await fetch(url, { signal });
		if (!response.ok) return null;
		const data = await response.json() as { requestSchema?: AnyRecord; responseSchema?: AnyRecord; documentation?: string };
		return data;
	} catch {
		return null;
	}
}

function textFromHtml(value: string): string {
	return value
		.replace(/<\/(?:p|div|span|dt|dd|h\d|li|section|footer)>/gi, " ")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&(nbsp|#160);/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, "\"")
		.replace(/&#(?:39|x27);/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function usdFromText(value: string): number | undefined {
	const match = value.match(/\$\s*([\d,]+(?:\.\d+)?)/);
	if (!match) return undefined;
	const parsed = Number(match[1].replace(/,/g, ""));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function costSection(html: string): string | undefined {
	const match = /<section\b[^>]*\bid=(["'])cost-and-speed\1[^>]*>/i.exec(html);
	if (!match || match.index === undefined) return undefined;
	const start = match.index;
	const next = html.indexOf('<section class="component-SpecsCard"', start + match[0].length);
	return html.slice(start, next >= 0 ? next : start + 40_000);
}

function parseOfficialPricing(html: string, source: string): ModelPricing | undefined {
	const section = costSection(html);
	if (!section) return undefined;
	const lede = /<div\b[^>]*\bclass=(["'])[^"']*\blede\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/i.exec(section)?.[2];
	const summary = lede ? textFromHtml(lede) : undefined;
	const ratesHtml = /<h4[^>]*>\s*Rates[\s\S]*?<\/h4>\s*<dl[^>]*>([\s\S]*?)<\/dl>/i.exec(section)?.[1];
	const rates: Array<{ configuration: string; usd: number }> = [];
	if (ratesHtml) {
		for (const match of ratesHtml.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
			const configuration = textFromHtml(match[1]);
			const usd = usdFromText(textFromHtml(match[2]));
			if (configuration && usd !== undefined) rates.push({ configuration, usd });
		}
	}
	const minimumUsd = summary ? usdFromText(summary) : undefined;
	if (!summary && minimumUsd === undefined && rates.length === 0) return undefined;
	return {
		source,
		...(summary ? { summary } : {}),
		...(minimumUsd !== undefined ? { minimumUsd } : {}),
		...(rates.length ? { rates } : {}),
	};
}

async function fetchOfficialPricing(documentation: string, signal?: AbortSignal): Promise<ModelPricing | undefined> {
	try {
		const url = new URL(documentation);
		if (url.hostname !== RUNWARE_DOCS_HOST) return undefined;
		const cached = pricingCache.get(url.href);
		if (cached && cached.expiresAt > Date.now()) return cached.pricing;
		const response = await fetch(url, {
			signal,
			headers: { Accept: "text/html" },
		});
		if (!response.ok) return undefined;
		const pricing = parseOfficialPricing(await response.text(), url.href);
		if (pricing) pricingCache.set(url.href, { pricing, expiresAt: Date.now() + PRICING_CACHE_TTL_MS });
		return pricing;
	} catch {
		return undefined;
	}
}

async function fetchPricingForModels(results: AnyRecord[], signal?: AbortSignal): Promise<Map<string, ModelPricing>> {
	const airs = [...new Set(results
		.map((result) => typeof result.air === "string" ? result.air : undefined)
		.filter((air): air is string => Boolean(air)))].slice(0, MAX_PRICING_LOOKUPS);
	const pricing = new Map<string, ModelPricing>();
	let next = 0;
	const worker = async () => {
		while (next < airs.length) {
			const air = airs[next++];
			const schema = await fetchModelSchema(air, signal);
			if (!schema?.documentation) continue;
			const item = await fetchOfficialPricing(schema.documentation, signal);
			if (item) pricing.set(air, item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PRICING_LOOKUP_CONCURRENCY, airs.length) }, worker));
	return pricing;
}

function simplifySchemaProperty(key: string, property: unknown, requiredSet: Set<string>): AnyRecord {
	if (!isRecord(property)) return { required: requiredSet.has(key) };
	const result: AnyRecord = { required: requiredSet.has(key) };
	if (typeof property.type === "string") result.type = property.type;
	if (typeof property.description === "string") result.description = property.description;
	if (property.default !== undefined) result.default = property.default;
	if (typeof property.minimum === "number") result.min = property.minimum;
	if (typeof property.maximum === "number") result.max = property.maximum;
	if (typeof property.minItems === "number") result.minItems = property.minItems;
	if (typeof property.maxItems === "number") result.maxItems = property.maxItems;
	if (Array.isArray(property.enum)) result.allowedValues = property.enum;
	if (isRecord(property.properties)) {
		const subRequired = new Set(Array.isArray(property.required) ? property.required.filter((k): k is string => typeof k === "string") : []);
		const subProps: AnyRecord = {};
		for (const [subKey, subVal] of Object.entries(property.properties)) {
			subProps[subKey] = simplifySchemaProperty(subKey, subVal, subRequired);
		}
		result.properties = subProps;
	}
	return result;
}

function parseModelParameters(schema?: AnyRecord): AnyRecord | undefined {
	if (!schema || !isRecord(schema.properties)) return undefined;
	const requiredSet = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
	const parsed: AnyRecord = {};
	for (const [key, prop] of Object.entries(schema.properties)) {
		parsed[key] = simplifySchemaProperty(key, prop, requiredSet);
	}
	return parsed;
}

function modelSearchResults(response: RunwareEnvelope): AnyRecord[] {
	const results: AnyRecord[] = [];
	for (const item of response.data ?? []) {
		if (Array.isArray(item.results)) {
			for (const result of item.results) if (isRecord(result)) results.push(result);
		}
	}
	return results;
}

export default function piRunware(pi: ExtensionAPI): void {
	// Auth-only provider. It intentionally registers no models.
	pi.registerProvider("runware", {
		name: "Runware",
		baseUrl: RUNWARE_API_URL,
		apiKey: "$RUNWARE_API_KEY",
		api: "openai-completions",
		models: [],
	});

	pi.registerTool({
		name: "runware_infer",
		label: "Runware Infer",
		description: "Call any Runware task or model.",
		parameters: runwareInferSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const built = await buildTasks(params, ctx.cwd);
			const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
			const completed = await runWithModerationFallback(
				built.tasks,
				built.moderation,
				params,
				ctx,
				signal,
				timeoutSeconds,
			);
			const response = await waitForAsyncTasks(completed.tasks, completed.response, params, ctx, signal);
			return await formatInferenceResult(response, completed.tasks, params, completed.warnings, signal);
		},
	});

	pi.registerTool({
		name: "runware_models",
		label: "Runware Models",
		description: "Search, filter, or inspect Runware models.",
		parameters: runwareModelsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action ?? (params.model ? "inspect" : "search");
			const query = action === "inspect" ? (params.model ?? params.query) : params.query;
			if (action === "inspect" && !query?.trim()) {
				throw new Error("runware_models action=inspect requires model or query.");
			}
			const task: AnyRecord = {
				taskType: "modelSearch",
				taskUUID: randomUUID(),
				search: query ?? "",
				limit: params.limit ?? 20,
				offset: params.offset ?? 0,
				...(params.source !== undefined ? { source: params.source } : {}),
				...(params.category !== undefined ? { category: params.category } : {}),
				...(params.architecture !== undefined ? { architecture: params.architecture } : {}),
				...(params.capabilities?.length ? { capabilities: params.capabilities } : {}),
				...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
				...(params.sort !== undefined ? { sort: params.sort } : {}),
				...(params.filters ?? {}),
			};
			const response = await runwareRequest([task], ctx, signal, DEFAULT_TIMEOUT_SECONDS);
			const results = modelSearchResults(response);
			let schemaInfo: { documentation?: string; parameters?: AnyRecord; rawSchema?: AnyRecord; pricing?: ModelPricing } | undefined;
			let pricingByAir = new Map<string, ModelPricing>();
			if (action === "inspect") {
				const targetAir = (params.model ?? (results[0] && typeof results[0].air === "string" ? results[0].air : query))?.trim();
				if (targetAir) {
					const schemaData = await fetchModelSchema(targetAir, signal);
					const pricing = schemaData?.documentation
						? await fetchOfficialPricing(schemaData.documentation, signal)
						: undefined;
					if (pricing) pricingByAir.set(targetAir, pricing);
					if (schemaData) {
						schemaInfo = {
							documentation: schemaData.documentation,
							parameters: parseModelParameters(schemaData.requestSchema),
							...(pricing ? { pricing } : {}),
							...(params.includeRaw ? { rawSchema: schemaData.requestSchema } : {}),
						};
					}
				}
			} else {
				pricingByAir = await fetchPricingForModels(results, signal);
			}
			const displayResults = results.map((result) => {
				const price = typeof result.air === "string" ? pricingByAir.get(result.air) : undefined;
				const base = params.includeRaw
					? { ...result }
					: {
						name: result.name,
						air: result.air,
						category: result.category,
						architecture: result.architecture,
						capabilities: result.capabilities,
						source: result.source,
						provider: result.provider,
						private: result.private,
						shortDescription: result.shortDescription,
					};
				return { ...base, ...(price ? { pricing: price } : {}) };
			});
			const totalResults = (response.data ?? []).find((item) => typeof item.totalResults === "number")?.totalResults;
			const pricingNotice = action === "search" && results.length > MAX_PRICING_LOOKUPS
				? `Official pricing was fetched for the first ${MAX_PRICING_LOOKUPS} returned models.`
				: undefined;
			const details: AnyRecord = {
				service: "runware-model-search",
				action,
				query: query ?? "",
				count: results.length,
				totalResults,
				schema: schemaInfo,
				...(pricingNotice ? { pricingNotice } : {}),
				response,
			};
			return {
				content: [{
					type: "text",
					text: compactText({
						action,
						query: query ?? "",
						count: results.length,
						totalResults,
						schema: schemaInfo,
						results: displayResults,
						...(pricingNotice ? { pricingNotice } : {}),
						errors: response.errors ?? [],
					}),
				}],
				details,
			};
		},
	});
}

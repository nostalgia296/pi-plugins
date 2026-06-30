/**
 * /provider - Add, list, and remove third-party API providers
 *
 * Usage:
 *   /provider add         — Wizard to add a provider (auto-discovers models from API)
 *   /provider add --manual — Skip auto-discovery, enter models manually
 *   /provider list        — Show all custom providers from models.json
 *   /provider remove      — Interactive selection to remove a provider
 *
 * Persists to ~/.pi/agent/models.json. Registers immediately at runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ModelsJson {
  providers: Record<string, ProviderJsonConfig>;
}

interface ProviderJsonConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: ModelJsonConfig[];
  modelOverrides?: Record<string, object>;
  compat?: Record<string, unknown>;
}

interface ModelJsonConfig {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
}

const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");

const API_TYPES: { value: string; label: string; description: string }[] = [
  { value: "openai-completions", label: "OpenAI Completions", description: "OpenAI Chat Completions API and compatibles (Ollama, vLLM, most proxies)" },
  { value: "anthropic-messages", label: "Anthropic Messages", description: "Anthropic Claude API and compatibles" },
  { value: "google-generative-ai", label: "Google Generative AI", description: "Google AI Studio / Gemini API" },
  { value: "mistral-conversations", label: "Mistral Conversations", description: "Mistral SDK Conversations/Chat streaming" },
  { value: "openai-responses", label: "OpenAI Responses", description: "OpenAI Responses API" },
  { value: "azure-openai-responses", label: "Azure OpenAI Responses", description: "Azure OpenAI Responses API" },
  { value: "openai-codex-responses", label: "OpenAI Codex Responses", description: "OpenAI Codex Responses API" },
  { value: "google-vertex", label: "Google Vertex AI", description: "Google Vertex AI API" },
  { value: "bedrock-converse-stream", label: "Amazon Bedrock Converse", description: "AWS Bedrock Converse API" },
];

async function readModelsJson(): Promise<ModelsJson> {
  try {
    const raw = await readFile(MODELS_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { providers: {} };
    }
    return {
      providers: typeof parsed.providers === "object" && parsed.providers !== null && !Array.isArray(parsed.providers)
        ? parsed.providers
        : {},
    };
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { providers: {} };
    }
    throw error;
  }
}

async function writeModelsJson(data: ModelsJson): Promise<void> {
  const json = JSON.stringify(data, null, 2) + "\n";
  await writeFile(MODELS_JSON_PATH, json, "utf-8");
}

function mergeProvider(
  existing: ModelsJson,
  providerId: string,
  config: ProviderJsonConfig,
): ModelsJson {
  const providers = { ...existing.providers };

  if (providers[providerId]) {
    const existingConfig = providers[providerId];
    providers[providerId] = {
      ...existingConfig,
      ...config,
      models: config.models
        ? upsertModels(existingConfig.models || [], config.models)
        : existingConfig.models,
    };
  } else {
    providers[providerId] = config;
  }

  return {
    ...existing,
    providers,
  };
}

function upsertModels(
  existing: ModelJsonConfig[],
  incoming: ModelJsonConfig[],
): ModelJsonConfig[] {
  const index = new Map(existing.map((m) => [m.id, m]));
  for (const model of incoming) {
    index.set(model.id, { ...index.get(model.id), ...model });
  }
  return Array.from(index.values());
}

async function wizardCollectProvider(
  pi: ExtensionAPI,
  ctx: any,
): Promise<{ providerId: string; config: ProviderJsonConfig } | null> {
  const providerId = await ctx.ui.input(
    "Provider ID (slug, e.g. 'my-ollama', 'deepseek'):",
    "my-provider",
  );
  if (!providerId || !providerId.trim()) {
    ctx.ui.notify("Cancelled: provider ID is required", "warning");
    return null;
  }
  const trimmedId = providerId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const existing = await readModelsJson();
  if (existing.providers[trimmedId]) {
    const overwrite = await ctx.ui.confirm(
      "Provider exists",
      `"${trimmedId}" already exists in models.json. Overwrite?`,
    );
    if (!overwrite) {
      ctx.ui.notify("Cancelled", "info");
      return null;
    }
  }

  const displayName = await ctx.ui.input(
    "Display name (optional, defaults to provider ID):",
    trimmedId,
  );

  const apiTypeLabels = API_TYPES.map((t) => `${t.label} — ${t.description}`);
  const selectedApiLabel = await ctx.ui.select("Select API type:", apiTypeLabels);
  if (!selectedApiLabel) {
    ctx.ui.notify("Cancelled: API type is required", "warning");
    return null;
  }
  const apiIndex = apiTypeLabels.indexOf(selectedApiLabel);
  const apiType = API_TYPES[apiIndex].value;

  const defaultBaseUrls: Record<string, string> = {
    "openai-completions": "http://localhost:11434/v1",
    "anthropic-messages": "https://api.anthropic.com",
    "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
    "mistral-conversations": "https://api.mistral.ai/v1",
    "google-vertex": "https://us-central1-aiplatform.googleapis.com/v1",
    "bedrock-converse-stream": "",
  };

  const baseUrl = await ctx.ui.input(
    "Base URL:",
    defaultBaseUrls[apiType] || "https://api.example.com/v1",
  );
  if (!baseUrl || !baseUrl.trim()) {
    ctx.ui.notify("Cancelled: base URL is required", "warning");
    return null;
  }

  const apiKey = await ctx.ui.input(
    "API key (plain text or $ENV_VAR, leave empty if using /login):",
    "$MY_API_KEY",
  );

  const config: ProviderJsonConfig = {
    name: displayName?.trim() || trimmedId,
    baseUrl: baseUrl.trim(),
    api: apiType,
    apiKey: apiKey?.trim() || undefined,
  };

  return { providerId: trimmedId, config };
}

async function wizardCollectModels(ctx: any): Promise<ModelJsonConfig[]> {
  const models: ModelJsonConfig[] = [];

  let addMore = true;
  while (addMore) {
    const modelId = await ctx.ui.input(
      "Model ID (e.g. 'gpt-4o', 'claude-sonnet-4-20250514', 'llama3.1:8b'):",
      "",
    );
    if (!modelId || !modelId.trim()) {
      ctx.ui.notify("Model ID is required - skipping this model", "warning");
      addMore = await ctx.ui.confirm("Add models", "Add another model?");
      continue;
    }

    const modelName = await ctx.ui.input(
      "Display name (optional, defaults to model ID):",
      modelId.trim(),
    );

    const reasoningInput = await ctx.ui.input(
      "Supports reasoning/thinking? (y/n):",
      "n",
    );
    const reasoning = reasoningInput?.toLowerCase().startsWith("y") ?? false;

    const inputTypeChoice = await ctx.ui.select("Input types:", [
      "text only",
      "text + image",
    ]);
    const input: ("text" | "image")[] = inputTypeChoice === "text + image"
      ? ["text", "image"]
      : ["text"];

    const contextWindowStr = await ctx.ui.input(
      "Context window (tokens, default 128000):",
      "128000",
    );
    const contextWindow = parseInt(contextWindowStr || "128000", 10) || 128000;

    const maxTokensStr = await ctx.ui.input(
      "Max output tokens (default 16384):",
      "16384",
    );
    const maxTokens = parseInt(maxTokensStr || "16384", 10) || 16384;

    const inputCostStr = await ctx.ui.input(
      "Input cost ($/million tokens, default 0):",
      "0",
    );
    const outputCostStr = await ctx.ui.input(
      "Output cost ($/million tokens, default 0):",
      "0",
    );

    const model: ModelJsonConfig = {
      id: modelId.trim(),
      name: modelName?.trim() || modelId.trim(),
      reasoning,
      input,
      contextWindow,
      maxTokens,
      cost: {
        input: parseFloat(inputCostStr || "0") || 0,
        output: parseFloat(outputCostStr || "0") || 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };

    models.push(model);
    ctx.ui.notify(`Added model: ${model.id}`, "info");

    addMore = await ctx.ui.confirm("Add models", "Add another model?");
  }

  return models;
}

async function selectDiscoveredModels(
  discovered: ModelJsonConfig[],
  ctx: any,
): Promise<ModelJsonConfig[]> {
  ctx.ui.notify(`Discovered ${discovered.length} model(s) from API`, "info");

  const modelList = discovered.map((m, i) => `  ${i + 1}. ${m.id}`);

  const addAll = await ctx.ui.confirm(
    "Discovered models",
    `Found ${discovered.length} model(s):\n${modelList.join("\n")}\n\nAdd all of them?`,
  );

  if (addAll) return discovered;

  const input = await ctx.ui.input(
    "Enter model numbers to add (e.g. 1,3,5-8), 'all', or leave empty to skip:",
    "",
  );

  if (!input || !input.trim()) return [];

  const trimmed = input.trim().toLowerCase();
  if (trimmed === "all") return discovered;

  const indices = new Set<number>();
  for (const part of trimmed.split(/\s*,\s*/)) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) indices.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) indices.add(n);
    }
  }

  const selected = discovered.filter((_, i) => indices.has(i + 1));

  if (selected.length === 0) {
    ctx.ui.notify("No valid model numbers selected", "warning");
    return [];
  }

  ctx.ui.notify(`Selected ${selected.length} model(s)`, "info");
  return selected;
}

function resolveEnvVars(value: string): string | undefined {
  let hasUnresolved = false;
  const resolved = value
    .replace(/\$\{([^}]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) hasUnresolved = true;
      return v ?? "";
    })
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) hasUnresolved = true;
      return v ?? "";
    });
  return hasUnresolved ? undefined : resolved;
}

function buildDiscoveryRequest(config: {
  baseUrl: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
}): { url: string; headers: Record<string, string> } {
  const base = config.baseUrl.replace(/\/+$/, "");
  const api = config.api || "openai-completions";
  const resolvedKey = config.apiKey ? resolveEnvVars(config.apiKey) : undefined;

  const headers: Record<string, string> = { "Content-Type": "application/json" };

  switch (api) {
    case "google-generative-ai":
    case "google-vertex": {
      let url = `${base}/v1beta/models`;
      if (resolvedKey) {
        url += `?key=${encodeURIComponent(resolvedKey)}`;
      }
      return { url, headers };
    }

    case "anthropic-messages": {
      if (resolvedKey) {
        headers["x-api-key"] = resolvedKey;
      }
      return { url: `${base}/models`, headers };
    }

    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
    case "mistral-conversations":
    case "bedrock-converse-stream":
    default: {
      if (resolvedKey) {
        headers["Authorization"] = `Bearer ${resolvedKey}`;
      }
      if (!headers["Authorization"] && config.authHeader && resolvedKey) {
        headers["Authorization"] = `Bearer ${resolvedKey}`;
      }
      return { url: `${base}/models`, headers };
    }
  }
}

function parseModelListResponse(
  payload: any,
  api: string,
): Array<{ id: string }> {
  if (api === "google-generative-ai" || api === "google-vertex") {
    if (payload.models && Array.isArray(payload.models)) {
      return payload.models.map((m: any) => ({
        id: typeof m.name === "string" ? m.name.replace(/^models\//, "") : m.id,
      }));
    }
  }

  if (payload.data && Array.isArray(payload.data)) {
    return payload.data.map((m: any) => ({ id: m.id }));
  }

  return [];
}

async function autoDiscoverModels(
  config: {
    baseUrl: string;
    api?: string;
    apiKey?: string;
    authHeader?: boolean;
  },
  ctx: any,
): Promise<ModelJsonConfig[] | null> {
  const api = config.api || "openai-completions";
  const { url, headers } = buildDiscoveryRequest(config);

  ctx.ui.notify(`Discovering models from API (${url}) ...`, "info");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      ctx.ui.notify(
        `Model discovery returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        "warning",
      );
      return null;
    }

    const payload = await response.json();
    const discovered = parseModelListResponse(payload, api);

    if (discovered.length === 0) {
      ctx.ui.notify("No models found in response", "warning");
      return null;
    }

    return discovered.map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
  } catch (error: any) {
    if (error.name === "AbortError") {
      ctx.ui.notify("Model discovery request timed out", "warning");
    } else {
      ctx.ui.notify(`Failed to reach model endpoint: ${error.message}`, "warning");
    }
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("provider", {
    description: "Add (auto-discovers models), list, or remove third-party API providers",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "add";
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "add":
          await handleAdd(pi, ctx, rest);
          break;
        case "list":
          await handleList(pi, ctx);
          break;
        case "remove":
          await handleRemove(pi, ctx);
          break;
        default:
          ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: add, list, remove`, "error");
      }
    },
  });
}

async function handleAdd(pi: ExtensionAPI, ctx: any, flags: string): Promise<void> {
  const isManual = flags.includes("--manual");

  const result = await wizardCollectProvider(pi, ctx);
  if (!result) return;

  let models: ModelJsonConfig[];

  if (isManual) {
    ctx.ui.notify("Skipping auto-discovery (--manual). Configure models manually.", "info");
    models = await wizardCollectModels(ctx);
  } else {
    const discovered = await autoDiscoverModels(
      {
        baseUrl: result.config.baseUrl!,
        api: result.config.api,
        apiKey: result.config.apiKey,
        authHeader: result.config.authHeader,
      },
      ctx,
    );

    if (discovered && discovered.length > 0) {
      models = await selectDiscoveredModels(discovered, ctx);
      if (models.length === 0) {
        const manualFallback = await ctx.ui.confirm(
          "No models selected",
          "You didn't select any models from discovery. Would you like to enter models manually instead?",
        );
        if (manualFallback) {
          models = await wizardCollectModels(ctx);
        }
      }
    } else {
      ctx.ui.notify("Auto-discovery didn't return results. Falling back to manual entry.", "info");
      models = await wizardCollectModels(ctx);
    }
  }

  if (models.length === 0) {
    ctx.ui.notify("No models configured — provider not saved", "warning");
    return;
  }

  result.config.models = models;

  const existing = await readModelsJson();
  const updated = mergeProvider(existing, result.providerId, result.config);
  await writeModelsJson(updated);

  pi.registerProvider(result.providerId, {
    name: result.config.name,
    baseUrl: result.config.baseUrl,
    apiKey: result.config.apiKey,
    api: result.config.api as any,
    models: result.config.models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: m.reasoning || false,
      input: m.input || ["text"],
      cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow || 128000,
      maxTokens: m.maxTokens || 16384,
    })),
  });

  ctx.ui.notify(
    `Provider "${result.providerId}" saved with ${models.length} model(s). Use /model to select.`,
    "info",
  );
}

async function handleList(pi: ExtensionAPI, ctx: any): Promise<void> {
  const data = await readModelsJson();
  const providerIds = Object.keys(data.providers);

  if (providerIds.length === 0) {
    ctx.ui.notify("No custom providers configured. Use /provider add to create one.", "info");
    return;
  }

  const items = providerIds.map((id) => {
    const p = data.providers[id];
    const modelCount = p.models ? p.models.length : (p.modelOverrides ? "overrides" : "0");
    const api = p.api || "unknown";
    const url = p.baseUrl || "(no base URL)";
    return `${id}  [${api}]  ${modelCount} model(s)  ${url}`;
  });

  const selected = await ctx.ui.select("Custom Providers:", items);

  if (selected) {
    const selectedId = selected.split("  ")[0];
    const p = data.providers[selectedId];

    const details: string[] = [
      `ID: ${selectedId}`,
      `Name: ${p.name || selectedId}`,
      `API: ${p.api || "(not set)"}`,
      `Base URL: ${p.baseUrl || "(not set)"}`,
      `API Key: ${p.apiKey ? "(configured)" : "(not set)"}`,
    ];

    if (p.models && p.models.length > 0) {
      details.push(`Models (${p.models.length}):`);
      for (const m of p.models) {
        details.push(`  • ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`);
      }
    }

    await ctx.ui.select("Provider Details:", details);
  }
}

async function handleRemove(pi: ExtensionAPI, ctx: any): Promise<void> {
  const data = await readModelsJson();
  const providerIds = Object.keys(data.providers);

  if (providerIds.length === 0) {
    ctx.ui.notify("No custom providers to remove. Use /provider add to create one.", "info");
    return;
  }

  const items = providerIds.map((id) => {
    const p = data.providers[id];
    const modelCount = p.models ? p.models.length : "0";
    return `${id}  [${p.api || "unknown"}]  ${modelCount} model(s)`;
  });

  const selected = await ctx.ui.select("Select provider to remove:", items);
  if (!selected) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const selectedId = selected.split("  ")[0];

  const confirmed = await ctx.ui.confirm(
    "Remove provider?",
    `Remove "${selectedId}" and all its models from models.json? This cannot be undone.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const { [selectedId]: _removed, ...remaining } = data.providers;
  await writeModelsJson({ providers: remaining });

  pi.unregisterProvider(selectedId);

  ctx.ui.notify(`Provider "${selectedId}" removed.`, "info");
}

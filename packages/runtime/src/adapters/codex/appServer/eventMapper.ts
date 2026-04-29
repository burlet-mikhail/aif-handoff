import type { RuntimeEvent, RuntimeRunInput, RuntimeUsage } from "../../../types.js";
import { classifyCodexAppServerError } from "./errors.js";

export interface CodexAppServerEventMapperLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface CodexAppServerEventMapperOptions {
  input: RuntimeRunInput;
  logger?: CodexAppServerEventMapperLogger;
  onTurnCompleted?: () => void;
  onTurnFailed?: (error: Error) => void;
}

const REDACTED_APPROVAL_FIELDS = new Set([
  "reasoning",
  "analysis",
  "thought",
  "thoughts",
  "chain_of_thought",
  "privateReasoning",
  "internalReasoning",
]);

export class CodexAppServerEventMapper {
  private readonly input: RuntimeRunInput;
  private readonly logger?: CodexAppServerEventMapperLogger;
  private readonly onTurnCompleted?: () => void;
  private readonly onTurnFailed?: (error: Error) => void;
  private readonly runtimeEvents: RuntimeEvent[] = [];
  private readonly deltaItemIds = new Set<string>();
  private outputText = "";
  private usage: RuntimeUsage | null = null;
  private rawUsage: unknown = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private completed = false;
  private failedError: Error | null = null;

  constructor(options: CodexAppServerEventMapperOptions) {
    this.input = options.input;
    this.logger = options.logger;
    this.onTurnCompleted = options.onTurnCompleted;
    this.onTurnFailed = options.onTurnFailed;
  }

  handleNotification(method: string, params: unknown): void {
    const normalizedMethod = normalizeNotificationMethod(method, params);
    const nowIso = new Date().toISOString();
    const payload = asRecord(params);

    switch (normalizedMethod) {
      case "thread/started":
      case "thread.started":
      case "thread/resumed": {
        const threadId = extractThreadId(payload);
        if (threadId) {
          this.threadId = threadId;
          this.emit({
            type: "system:init",
            timestamp: nowIso,
            level: "debug",
            message:
              normalizedMethod === "thread/resumed"
                ? "Codex thread resumed"
                : "Codex thread started",
            data: {
              sessionId: threadId,
              threadId,
            },
          });
        }
        return;
      }

      case "turn/started":
      case "turn.started": {
        const turnId = extractTurnId(payload);
        if (turnId) {
          this.turnId = turnId;
        }
        this.emit({
          type: "turn:started",
          timestamp: nowIso,
          level: "debug",
          message: "Codex turn started",
          data: turnId ? { turnId } : undefined,
        });
        return;
      }

      case "item/agentMessage/delta": {
        const delta = readDeltaString(payload?.delta);
        if (delta == null) {
          return;
        }
        const itemId = readString(payload?.itemId);
        if (itemId) {
          this.deltaItemIds.add(itemId);
        }
        this.outputText += delta;
        this.emit({
          type: "stream:text",
          timestamp: nowIso,
          level: "debug",
          message: delta,
          data: { text: delta },
        });
        return;
      }

      case "item/started": {
        const item = asRecord(payload?.item) ?? payload;
        const itemType = readString(item?.type) ?? "item";
        this.emit({
          type: "tool:started",
          timestamp: nowIso,
          level: "debug",
          message: `Codex item started: ${itemType}`,
          data: {
            itemType,
            itemId: readString(item?.id) ?? readString(payload?.itemId) ?? null,
          },
        });
        return;
      }

      case "item/completed":
      case "item.completed": {
        const item = asRecord(payload?.item);
        const itemType = readString(item?.type);
        if (!itemType) {
          return;
        }

        if (itemType === "agentMessage" || itemType === "agent_message") {
          const itemId = readString(item?.id);
          const text = readString(item?.text) ?? readString(payload?.text);
          if (text && (!itemId || !this.deltaItemIds.has(itemId))) {
            if (this.outputText) {
              this.outputText += "\n\n";
            }
            this.outputText += text;
            this.emit({
              type: "stream:text",
              timestamp: nowIso,
              level: "debug",
              message: text,
              data: { text },
            });
          }
          return;
        }

        if (itemType === "reasoning") {
          this.emit({
            type: "reasoning:summary",
            timestamp: nowIso,
            level: "debug",
            message: "Codex reasoning item completed",
          });
          return;
        }

        const toolSummary = summarizeToolUse(itemType, item);
        if (!toolSummary) {
          this.emit({
            type: "tool:completed",
            timestamp: nowIso,
            level: "debug",
            message: `Codex item completed: ${itemType}`,
            data: {
              itemType,
              itemId: readString(item?.id) ?? readString(payload?.itemId) ?? null,
            },
          });
          return;
        }
        this.input.execution?.onToolUse?.(toolSummary.name, toolSummary.detail);
        this.emit({
          type: "tool:summary",
          timestamp: nowIso,
          level: "info",
          message: toolSummary.detail
            ? `${toolSummary.name}: ${toolSummary.detail}`
            : toolSummary.name,
          data: {
            toolName: toolSummary.name,
            itemType,
          },
        });
        return;
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded": {
        this.emit({
          type: "reasoning:summary",
          timestamp: nowIso,
          level: "debug",
          message: "Codex reasoning summary updated",
        });
        return;
      }

      case "item/reasoning/textDelta": {
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
          },
          "DEBUG [runtime:codex] Suppressed private reasoning text delta from app-server",
        );
        return;
      }

      case "thread/tokenUsage/updated": {
        this.rawUsage = payload?.tokenUsage ?? payload;
        this.usage = normalizeUsageFromTokenUsage(payload);
        if (this.usage) {
          this.logger?.debug?.(
            {
              runtimeId: this.input.runtimeId,
              profileId: this.input.profileId ?? null,
              transport: this.input.transport ?? "app-server",
              usage: this.usage,
            },
            "DEBUG [runtime:codex] App-server usage payload received",
          );
        }
        return;
      }

      case "account/rateLimits/updated": {
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            keys: Object.keys(payload ?? {}),
          },
          "DEBUG [runtime:codex] App-server account rate limits notification received",
        );
        return;
      }

      case "thread/status/changed": {
        const threadId = extractThreadId(payload);
        if (threadId) {
          this.threadId = threadId;
        }
        this.logger?.debug?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            threadId,
            status: payload?.status ?? null,
          },
          "DEBUG [runtime:codex] App-server thread status changed",
        );
        return;
      }

      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
      case "turn.approval_requested":
      case "approval.requested": {
        this.emitApprovalRequest(payload, nowIso);
        return;
      }

      case "warning":
      case "configWarning": {
        this.emit({
          type: "warning",
          timestamp: nowIso,
          level: "warn",
          message: readString(payload?.message) ?? "Codex app-server warning",
          data: sanitizeApprovalPayload(payload) ?? undefined,
        });
        return;
      }

      case "turn/completed":
      case "turn.completed": {
        this.handleTurnCompleted(payload, nowIso);
        return;
      }

      case "turn.failed":
      case "error": {
        const message = readString(payload?.message) ?? "Codex turn failed";
        this.failTurn(toErrorWithStructuredPayload(message, payload), nowIso);
        return;
      }

      default: {
        this.logger?.warn?.(
          {
            runtimeId: this.input.runtimeId,
            profileId: this.input.profileId ?? null,
            transport: this.input.transport ?? "app-server",
            method: normalizedMethod,
            keys: Object.keys(payload ?? {}),
          },
          "WARN [runtime:codex] Unknown non-fatal app-server notification received",
        );
      }
    }
  }

  handleServerRequest(method: string, params: unknown): unknown {
    const payload = asRecord(params);
    this.emitApprovalRequest(payload, new Date().toISOString());

    switch (method) {
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "applyPatchApproval":
        return { decision: "denied" };
      case "execCommandApproval":
        return { decision: "denied" };
      default:
        throw new Error(`Unsupported Codex app-server request: ${method}`);
    }
  }

  getEvents(): RuntimeEvent[] {
    return [...this.runtimeEvents];
  }

  getOutputText(): string {
    return this.outputText;
  }

  getUsage(): RuntimeUsage | null {
    return this.usage;
  }

  getRawUsage(): unknown {
    return this.rawUsage;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getTurnId(): string | null {
    return this.turnId;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  getFailure(): Error | null {
    return this.failedError;
  }

  private handleTurnCompleted(payload: Record<string, unknown> | null, nowIso: string): void {
    if (!this.usage) {
      this.rawUsage = payload?.usage ?? this.rawUsage;
      this.usage = normalizeUsageFromTokenUsage(payload);
    }

    const turn = asRecord(payload?.turn);
    const status = readString(turn?.status);
    const turnId = extractTurnId(payload);
    if (turnId) {
      this.turnId = turnId;
    }

    if (status === "failed") {
      const turnError = asRecord(turn?.error);
      const message = readString(turnError?.message) ?? "Codex turn failed";
      this.failTurn(toErrorWithStructuredPayload(message, turnError ?? payload), nowIso);
      return;
    }

    this.completed = true;
    this.emit({
      type: status === "interrupted" ? "result:cancelled" : "result:success",
      timestamp: nowIso,
      level: status === "interrupted" ? "warn" : "info",
      message: status === "interrupted" ? "Codex turn interrupted" : "Codex turn completed",
      data: this.usage ? { usage: this.usage, rawUsage: this.rawUsage } : undefined,
    });
    this.onTurnCompleted?.();
  }

  private failTurn(error: Error, nowIso: string): void {
    const failure = classifyCodexAppServerError(error);
    this.failedError = failure;
    this.emit({
      type: "result:error",
      timestamp: nowIso,
      level: "error",
      message: failure.message,
      data: {
        category: failure.category,
        adapterCode: failure.adapterCode,
      },
    });
    this.onTurnFailed?.(failure);
  }

  private emitApprovalRequest(payload: Record<string, unknown> | null, nowIso: string): void {
    const sanitized = sanitizeApprovalPayload(payload);
    this.emit({
      type: "approval:request",
      timestamp: nowIso,
      level: "info",
      message: "Codex app-server requested approval",
      data: sanitized ?? {},
    });
    this.logger?.warn?.(
      {
        runtimeId: this.input.runtimeId,
        profileId: this.input.profileId ?? null,
        transport: this.input.transport ?? "app-server",
        requestKeys: Object.keys(payload ?? {}),
      },
      "WARN [runtime:codex] Denying app-server approval request because no human approval bridge is configured",
    );
  }

  private emit(event: RuntimeEvent): void {
    this.runtimeEvents.push(event);
    this.input.execution?.onEvent?.(event);
  }
}

function normalizeNotificationMethod(method: string, params: unknown): string {
  const trimmedMethod = method.trim();
  if (trimmedMethod !== "event") {
    return trimmedMethod;
  }
  const payload = asRecord(params);
  return readString(payload?.type) ?? trimmedMethod;
}

function normalizeUsageFromTokenUsage(
  payload: Record<string, unknown> | null,
): RuntimeUsage | null {
  const tokenUsage = asRecord(payload?.tokenUsage);
  const usageRecord =
    asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.total) ?? tokenUsage ?? payload;
  if (!usageRecord) {
    return null;
  }

  const inputTokens =
    readNumber(usageRecord.inputTokens) ?? readNumber(usageRecord.input_tokens) ?? 0;
  const outputTokens =
    readNumber(usageRecord.outputTokens) ?? readNumber(usageRecord.output_tokens) ?? 0;
  const totalTokens =
    readNumber(usageRecord.totalTokens) ??
    readNumber(usageRecord.total_tokens) ??
    inputTokens + outputTokens;
  const costUsd = readNumber(usageRecord.costUsd) ?? readNumber(usageRecord.cost_usd) ?? undefined;

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && costUsd == null) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(costUsd != null ? { costUsd } : {}),
  };
}

function summarizeToolUse(
  itemType: string,
  item: Record<string, unknown> | null,
): { name: string; detail: string } | null {
  if (!item) {
    return null;
  }
  switch (itemType) {
    case "commandExecution":
    case "command_execution":
      return {
        name: "Bash",
        detail: shortenString(readString(item.command) ?? ""),
      };
    case "fileChange":
    case "file_change":
      return {
        name: "FileChange",
        detail: shortenString(safeJson(item)),
      };
    case "mcpToolCall":
    case "mcp_tool_call":
      return {
        name: `MCP:${readString(item.server) ?? "unknown"}/${readString(item.tool) ?? "unknown"}`,
        detail: shortenString(safeJson(item.arguments)),
      };
    case "webSearch":
    case "web_search":
      return {
        name: "WebSearch",
        detail: shortenString(readString(item.query) ?? ""),
      };
    default:
      return null;
  }
}

function sanitizeApprovalPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }
  return sanitizeStructuredValue(payload) as Record<string, unknown>;
}

function sanitizeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (REDACTED_APPROVAL_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeStructuredValue(entry);
  }
  return sanitized;
}

function toErrorWithStructuredPayload(
  message: string,
  payload: Record<string, unknown> | null,
): Error & { codexErrorInfo?: Record<string, unknown> } {
  const error = new Error(message) as Error & { codexErrorInfo?: Record<string, unknown> };
  if (payload) {
    error.codexErrorInfo = payload;
  }
  return error;
}

function extractThreadId(payload: Record<string, unknown> | null): string | null {
  return (
    readString(payload?.threadId) ??
    readString(payload?.thread_id) ??
    readString(asRecord(payload?.thread)?.id) ??
    null
  );
}

function extractTurnId(payload: Record<string, unknown> | null): string | null {
  return (
    readString(payload?.turnId) ??
    readString(payload?.turn_id) ??
    readString(asRecord(payload?.turn)?.id) ??
    null
  );
}

function shortenString(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 3)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDeltaString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

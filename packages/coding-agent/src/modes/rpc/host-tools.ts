import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	if (frame.type !== "host_tool_result" || typeof frame.id !== "string" || !isAgentToolResult(frame.result)) {
		return false;
	}
	// `terminate` is an optional boolean. Any other JSON value (a string "false",
	// a number, an object) is a malformed frame: it must be refused at the
	// boundary instead of being coerced by truthiness into a termination request.
	const terminate = (frame.result as { terminate?: unknown }).terminate;
	return terminate === undefined || typeof terminate === "boolean";
}

/**
 * True when a settled result carries a usable termination request.
 *
 * `undefined` means "no request"; anything that is not a boolean fails closed
 * (the call errors) so no transport path can turn a malformed value into a
 * termination.
 */
function readTerminateRequest(result: AgentToolResult<unknown>): boolean | undefined {
	const terminate = (result as { terminate?: unknown }).terminate;
	if (terminate === undefined) return undefined;
	if (typeof terminate !== "boolean") {
		throw new Error(`Host tool result declares a non-boolean terminate: ${JSON.stringify(terminate)}`);
	}
	return terminate;
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

/**
 * Resolve a host tool's declared scheduling/admission policy, failing closed on
 * any value the agent loop would otherwise have to guess about. Omission keeps
 * the documented defaults (`"shared"`, `"any"`) — an unrecognized value never
 * degrades to them.
 *
 * Called by the `set_host_tools` command (so a bad declaration rejects the whole
 * request) and again by the adapter (so a definition that bypassed command
 * normalization cannot reach the scheduler unvalidated).
 */
export function normalizeHostToolPolicy(
	name: string,
	definition: Pick<RpcHostToolDefinition, "concurrency" | "batchPolicy" | "terminateOnSettle">,
): { concurrency: "shared" | "exclusive"; batchPolicy: "any" | "sole"; terminateOnSettle: boolean } {
	// Only an *omitted* field falls back to the documented default. JSON `null`
	// is a declared value and fails closed like any other unrecognized one — a
	// `??` here would silently accept `"concurrency": null` as `"shared"`.
	const concurrency = definition.concurrency === undefined ? "shared" : definition.concurrency;
	if (concurrency !== "shared" && concurrency !== "exclusive") {
		throw new Error(
			`Host tool "${name}" declares an invalid concurrency ${JSON.stringify(definition.concurrency)}; expected "shared" or "exclusive"`,
		);
	}
	const batchPolicy = definition.batchPolicy === undefined ? "any" : definition.batchPolicy;
	if (batchPolicy !== "any" && batchPolicy !== "sole") {
		throw new Error(
			`Host tool "${name}" declares an invalid batchPolicy ${JSON.stringify(definition.batchPolicy)}; expected "any" or "sole"`,
		);
	}
	const terminateOnSettle = definition.terminateOnSettle === undefined ? false : definition.terminateOnSettle;
	if (typeof terminateOnSettle !== "boolean") {
		throw new Error(
			`Host tool "${name}" declares an invalid terminateOnSettle ${JSON.stringify(definition.terminateOnSettle)}; expected a boolean`,
		);
	}
	return { concurrency, batchPolicy, terminateOnSettle };
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme> implements AgentTool<
	TParams,
	unknown,
	TTheme
> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	/** `"sole"` makes the call the only one allowed in its assistant message. */
	batchPolicy: "any" | "sole" = "any";
	/** `true` makes any settled result of this tool end the run. */
	terminateOnSettle = false;
	readonly loadMode: ToolLoadMode;
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge) {
		this.#definition = definition;
		this.#bridge = bridge;
		applyToolProxy(definition, this);
		this.loadMode = defaultLoadModeForToolName(definition.name, definition.loadMode);
		const policy = normalizeHostToolPolicy(definition.name, definition);
		this.concurrency = policy.concurrency;
		this.batchPolicy = policy.batchPolicy;
		this.terminateOnSettle = policy.terminateOnSettle;
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#pendingCalls = new Map<string, PendingHostToolCall>();
	#closedError: Error | undefined;

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	setTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		// Build the adapters first: a rejected declaration must not replace the
		// registered set (the policy check runs in the adapter constructor).
		const adapters = tools.map(tool => new RpcHostToolAdapter(tool, this));
		this.#definitions = new Map(tools.map(tool => [tool.name, tool]));
		return adapters;
	}

	handleResult(frame: RpcHostToolResult): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		const { result } = frame;
		let terminate: boolean | undefined;
		try {
			terminate = readTerminateRequest(result);
		} catch (error) {
			// Fail closed: a malformed termination flag fails the call instead of
			// being coerced into one.
			pending.reject(error instanceof Error ? error : new Error(String(error)));
			return true;
		}
		if (frame.isError && terminate !== true) {
			// Documented error contract: a top-level `isError` rejects the pending
			// call so the host's text becomes the tool error. A terminating result
			// cannot ride that path — a thrown error has nowhere to carry
			// `terminate` — so it resolves below with the composed error flags.
			const text = result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		// The settled result reaches the agent loop verbatim, including
		// `terminate`. A top-level error flag is folded into the result so the
		// loop reads one combination: `isError = frame.isError || result.isError`.
		pending.resolve(frame.isError === true && result.isError !== true ? { ...result, isError: true } : result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		if (this.#closedError) {
			return Promise.reject(this.#closedError);
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
		});

		this.#output({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
		});

		return promise;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(error);
		}
	}

	/** Reject active and future host tool requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(this.#closedError);
		}
	}
}

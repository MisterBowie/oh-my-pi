import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { defineRpcClientTool, RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import { isRpcHostToolResult, RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { normalizeHostToolDefinitions } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolUpdate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { toolReadsSkillUris } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempPaths.splice(0).map(async filePath => {
			try {
				await removeWithRetries(filePath);
			} catch {}
		}),
	);
});

describe("RpcHostToolBridge", () => {
	it("forwards host tool updates and results to the pending execution", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_sum",
				label: "Host Sum",
				description: "Adds numbers in the host process",
				parameters: {
					type: "object",
					properties: {
						left: { type: "number" },
						right: { type: "number" },
					},
					required: ["left", "right"],
					additionalProperties: false,
				},
			},
		]);

		const updates: RpcHostToolUpdate["partialResult"][] = [];
		const execution = tool.execute("toolu_1", { left: 2, right: 3 }, undefined, update => {
			updates.push(update);
		});

		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		bridge.handleUpdate({
			type: "host_tool_update",
			id: request.id,
			partialResult: {
				content: [{ type: "text", text: "working" }],
			},
		});
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content[0]).toEqual({ type: "text", text: "working" });

		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: {
				content: [{ type: "text", text: "5" }],
			},
		});

		await expect(execution).resolves.toEqual({
			content: [{ type: "text", text: "5" }],
		});
	});

	it("emits a cancel frame when the host tool execution is aborted", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits in the host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);

		const controller = new AbortController();
		const execution = tool.execute("toolu_2", {}, controller.signal);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		controller.abort();

		expect(frames[1]).toMatchObject({
			type: "host_tool_cancel",
			targetId: request.id,
		});
		await expect(execution).rejects.toThrow('Host tool "host_wait" was aborted');
	});

	it("exposes skill URI readability declared by the host tool", async () => {
		const bridge = new RpcHostToolBridge(() => {});
		const [tool] = bridge.setTools([
			{
				name: "host_read",
				label: "Host Read",
				description: "Reads files in the host process",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				readsSkillUris: true,
			},
		]);

		expect(toolReadsSkillUris(tool)).toBe(true);
	});

	it("forwards the declared scheduling and batch policy onto the host tool", () => {
		const bridge = new RpcHostToolBridge(() => {});
		const [explicit, defaults] = bridge.setTools([
			{
				name: "host_submit",
				label: "Host Submit",
				description: "Submits a host-owned proposal",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				concurrency: "exclusive",
				batchPolicy: "sole",
			},
			{
				name: "host_echo",
				label: "Host Echo",
				description: "Echoes a value",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);

		expect(explicit?.concurrency).toBe("exclusive");
		expect(explicit?.batchPolicy).toBe("sole");
		// Omission keeps the documented defaults.
		expect(defaults?.concurrency).toBe("shared");
		expect(defaults?.batchPolicy).toBe("any");
	});

	it("rejects an illegal host tool policy instead of degrading to the default", () => {
		const bridge = new RpcHostToolBridge(() => {});
		const definition = {
			name: "host_bad",
			label: "Host Bad",
			description: "Declares a policy the scheduler cannot honor",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		};

		expect(() => bridge.setTools([{ ...definition, concurrency: "sometimes" as "shared" }])).toThrow(
			/invalid concurrency/,
		);
		expect(() => bridge.setTools([{ ...definition, batchPolicy: "only" as "sole" }])).toThrow(/invalid batchPolicy/);
		// A refusal must not leave the bridge holding a half-registered set.
		expect(bridge.getToolNames()).toEqual([]);
		expect(bridge.setTools([definition])).toHaveLength(1);
	});

	it("rejects a null policy value instead of treating it as omitted", () => {
		const bridge = new RpcHostToolBridge(() => {});
		const registered = bridge.setTools([
			{
				name: "host_ok",
				label: "Host Ok",
				description: "Registered before the rejected update",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);
		expect(registered).toHaveLength(1);

		// JSON `null` is a declared value, not an omission: only `undefined` may
		// fall back to the documented defaults.
		expect(() =>
			bridge.setTools([
				{
					name: "host_null_concurrency",
					label: "Host Null",
					description: "Declares null concurrency",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					concurrency: null as unknown as "shared",
				},
			]),
		).toThrow(/invalid concurrency/);
		expect(() =>
			bridge.setTools([
				{
					name: "host_null_policy",
					label: "Host Null",
					description: "Declares null batchPolicy",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					batchPolicy: null as unknown as "sole",
				},
			]),
		).toThrow(/invalid batchPolicy/);
		// A refused update leaves the previously registered set untouched.
		expect(bridge.getToolNames()).toEqual(["host_ok"]);
	});

	it("rejects a null policy at the set_host_tools boundary", () => {
		const definition = {
			name: "host_boundary",
			label: "Host Boundary",
			description: "Declares a null policy",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		};
		expect(() => normalizeHostToolDefinitions([{ ...definition, concurrency: null as unknown as "shared" }])).toThrow(
			/invalid concurrency/,
		);
		expect(() => normalizeHostToolDefinitions([{ ...definition, batchPolicy: null as unknown as "sole" }])).toThrow(
			/invalid batchPolicy/,
		);
		// Omission still normalizes to the defaults.
		const [normalized] = normalizeHostToolDefinitions([definition]);
		expect({ concurrency: normalized?.concurrency, batchPolicy: normalized?.batchPolicy }).toEqual({
			concurrency: "shared",
			batchPolicy: "any",
		});
	});

	it("refuses a non-boolean terminate instead of coercing it", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_submit",
				label: "Host Submit",
				description: "Submits a host-owned proposal",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);

		// The frame guard rejects the malformed flag outright: the transport
		// treats `"false"` as an invalid frame, never as a truthy request.
		expect(
			isRpcHostToolResult({
				type: "host_tool_result",
				id: "frame-1",
				result: { content: [{ type: "text", text: "submitted" }], terminate: "false" as unknown as boolean },
			}),
		).toBe(false);
		expect(
			isRpcHostToolResult({
				type: "host_tool_result",
				id: "frame-2",
				result: { content: [{ type: "text", text: "submitted" }], terminate: true },
			}),
		).toBe(true);

		// A direct call that bypasses the guard still fails closed rather than
		// coercing the value into a termination request.
		const execution = tool.execute("toolu_bad_terminate", {});
		const request = frames[0];
		if (request?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "submitted" }], terminate: "yes" as unknown as boolean },
		});
		await expect(execution).rejects.toThrow(/terminate/);
	});

	it("passes a terminating host result through and composes the error flags", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_submit",
				label: "Host Submit",
				description: "Submits a host-owned proposal",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				batchPolicy: "sole",
			},
		]);

		const started = tool.execute("toolu_ok", {});
		const request = frames[0];
		if (request?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "submitted" }], terminate: true },
		});
		await expect(started).resolves.toEqual({
			content: [{ type: "text", text: "submitted" }],
			terminate: true,
		});

		// An error that also terminates resolves — a thrown error cannot carry the
		// flag — with both layers folded into the settled result.
		const failed = tool.execute("toolu_failed", {});
		const failedRequest = frames[1];
		if (failedRequest?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: failedRequest.id,
			result: {
				content: [{ type: "text", text: "PLAN_SUBMIT_FAILED" }],
				isError: true,
				terminate: true,
			},
		});
		await expect(failed).resolves.toEqual({
			content: [{ type: "text", text: "PLAN_SUBMIT_FAILED" }],
			isError: true,
			terminate: true,
		});

		// Top-level isError with a terminating result: the frame flag still has to
		// read as a failed call.
		const flagged = tool.execute("toolu_flagged", {});
		const flaggedRequest = frames[2];
		if (flaggedRequest?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: flaggedRequest.id,
			isError: true,
			result: { content: [{ type: "text", text: "rejected" }], terminate: true },
		});
		await expect(flagged).resolves.toEqual({
			content: [{ type: "text", text: "rejected" }],
			isError: true,
			terminate: true,
		});

		// Without a termination request the documented rejection contract holds.
		const plainError = tool.execute("toolu_plain_error", {});
		const plainRequest = frames[3];
		if (plainRequest?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");
		bridge.handleResult({
			type: "host_tool_result",
			id: plainRequest.id,
			isError: true,
			result: { content: [{ type: "text", text: "host exploded" }] },
		});
		await expect(plainError).rejects.toThrow("host exploded");
	});

	it("never settles a call from an update frame, even a terminating one", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_stream",
				label: "Host Stream",
				description: "Streams progress before settling",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		]);

		const updates: RpcHostToolUpdate["partialResult"][] = [];
		const execution = tool.execute("toolu_stream", {}, undefined, update => {
			updates.push(update);
		});
		const request = frames[0];
		if (request?.type !== "host_tool_call") throw new Error("Expected host_tool_call frame");

		bridge.handleUpdate({
			type: "host_tool_update",
			id: request.id,
			partialResult: { content: [{ type: "text", text: "half" }], terminate: true },
		});
		// The bridge is a transport: it delivers the partial verbatim, and the
		// call stays pending until a result arrives.
		expect(updates).toHaveLength(1);
		expect(updates[0]?.terminate).toBe(true);

		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "full" }] },
		});
		await expect(execution).resolves.toEqual({ content: [{ type: "text", text: "full" }] });
		// A late update for a settled call is ignored.
		expect(
			bridge.handleUpdate({
				type: "host_tool_update",
				id: request.id,
				partialResult: { content: [{ type: "text", text: "late" }] },
			}),
		).toBe(false);
	});
});

describe("RpcClient custom tools", () => {
	it("registers host custom tools and serves tool calls over the RPC transport", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-host-tools-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
const encoder = new TextEncoder();
let buffer = "";

function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}

write({ type: "ready" });

process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});

function handle(frame) {
	if (frame.type === "set_host_tools") {
		write({
			id: frame.id,
			type: "response",
			command: "set_host_tools",
			success: true,
			data: { toolNames: frame.tools.map(tool => tool.name) },
		});
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "agent_start" });
		write({
			type: "host_tool_call",
			id: "host-call-1",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			arguments: { message: "hello" },
		});
		return;
	}
	if (frame.type === "host_tool_update") {
		write({
			type: "tool_execution_update",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			args: { message: "hello" },
			partialResult: frame.partialResult,
		});
		return;
	}
	if (frame.type === "host_tool_result") {
		write({
			type: "tool_execution_end",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			result: frame.result,
			isError: frame.isError === true,
		});
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		const client = new RpcClient({
			cliPath: scriptPath,
			customTools: [
				defineRpcClientTool<{ message: string }>({
					name: "echo_host",
					description: "Echo a value from the embedding host",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string" },
						},
						required: ["message"],
						additionalProperties: false,
					},
					async execute(args, context) {
						context.sendUpdate(`working:${args.message}`);
						return `host:${args.message}`;
					},
				}),
			],
		});

		try {
			await client.start();
			const events = await client.promptAndWait("Trigger host tool");
			const toolEnd = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);
			expect(toolEnd?.toolName).toBe("echo_host");
			expect(toolEnd?.result).toEqual({
				content: [{ type: "text", text: "host:hello" }],
			});

			const toolUpdate = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_update" }> =>
					event.type === "tool_execution_update",
			);
			expect(toolUpdate?.partialResult).toEqual({
				content: [{ type: "text", text: "working:hello" }],
			});
		} finally {
			await client.stop();
		}
	});
	it("preserves skill URI readability across the host tool wire frame", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-host-skill-${Date.now()}.js`);
		const capturePath = `${scriptPath}.tools.json`;
		tempPaths.push(scriptPath, capturePath);
		await Bun.write(
			scriptPath,
			`
			process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
			let buffer = "";
			process.stdin.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\\n");
				while (index !== -1) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					if (line) handle(JSON.parse(line));
					index = buffer.indexOf("\\n");
				}
			});
			function handle(frame) {
				if (frame.type === "set_host_tools") {
					require("fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(frame.tools));
					process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "set_host_tools", success: true, data: { toolNames: frame.tools.map(tool => tool.name) } }) + "\\n");
				}
			}
			`,
		);

		const client = new RpcClient({
			cliPath: scriptPath,
			customTools: [
				defineRpcClientTool({
					name: "host_read",
					description: "Reads files in the host process",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					readsSkillUris: true,
					async execute() {
						return "ok";
					},
				}),
			],
		});

		try {
			await client.start();
			const tools = await Bun.file(capturePath).json();
			expect(tools).toMatchObject([{ name: "host_read", readsSkillUris: true }]);
		} finally {
			await client.stop();
		}
	});

	it("carries a custom tool's scheduling and batch policy over the wire", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-host-policy-${Date.now()}.js`);
		const capturePath = `${scriptPath}.tools.json`;
		tempPaths.push(scriptPath, capturePath);
		await Bun.write(
			scriptPath,
			`
			process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
			let buffer = "";
			process.stdin.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let index = buffer.indexOf("\\n");
				while (index !== -1) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					if (line) handle(JSON.parse(line));
					index = buffer.indexOf("\\n");
				}
			});
			function handle(frame) {
				if (frame.type === "set_host_tools") {
					require("fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(frame.tools));
					process.stdout.write(JSON.stringify({ id: frame.id, type: "response", command: "set_host_tools", success: true, data: { toolNames: frame.tools.map(tool => tool.name) } }) + "\\n");
				}
			}
			`,
		);

		const client = new RpcClient({
			cliPath: scriptPath,
			customTools: [
				defineRpcClientTool({
					name: "host_submit",
					description: "Submits a host-owned proposal",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					concurrency: "exclusive",
					batchPolicy: "sole",
					async execute() {
						return { content: [{ type: "text", text: "submitted" }], terminate: true };
					},
				}),
			],
		});

		try {
			await client.start();
			const tools = await Bun.file(capturePath).json();
			expect(tools).toMatchObject([{ name: "host_submit", concurrency: "exclusive", batchPolicy: "sole" }]);
		} finally {
			await client.stop();
		}
	});
});

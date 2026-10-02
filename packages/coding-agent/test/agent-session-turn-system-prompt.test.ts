import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Contract (M5/T20-D): `setTurnSystemPrompt` replaces the live system prompt
// for the REST of the running turn. The agent loop re-reads the live prompt
// before every model call, so a replacement installed while a tool executes
// must reach the very next provider request of the same run — that is what a
// host-confirmed mode transition needs. The replacement is dropped with the
// turn's own override at the next prompt preparation.

const BASE = "BASE-SYSTEM-PROMPT";
const TURN_OVERRIDE = "TURN-OVERRIDE-FROM-A-TOOL";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession setTurnSystemPrompt", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	/**
	 * One scripted run: the model calls `probe`, the probe's `execute` installs
	 * {@link TURN_OVERRIDE} through the session, and the second provider request
	 * must already see it. `systemPrompts` records every request's prompt.
	 */
	function createSession(): { session: AgentSession; systemPrompts: string[][] } {
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", name: "probe", arguments: {} }] }, { content: ["done"] }],
		});
		const systemPrompts: string[][] = [];
		const probe: AgentTool = {
			name: "probe",
			label: "probe",
			description: "Installs a mid-run system prompt replacement.",
			parameters: type({}),
			execute: async () => {
				session?.setTurnSystemPrompt([TURN_OVERRIDE]);
				return { content: [{ type: "text" as const, text: "probe ran" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: [BASE],
				tools: [probe],
				messages: [],
			},
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(model, context, streamOptions);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry: new Map([[probe.name, probe]]),
			builtInToolNames: [],
			extensionRunner: {
				hasHandlers: () => false,
				emitBeforeAgentStart: async () => undefined,
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: [BASE] }),
		});
		return { session, systemPrompts };
	}

	it("reaches the next provider request of the same run", async () => {
		const { session: active, systemPrompts } = createSession();

		await active.prompt("hello");
		await active.waitForIdle();

		expect(systemPrompts).toHaveLength(2);
		expect(systemPrompts[0]).toEqual([BASE]);
		// The replacement was installed while the tool was running, after the
		// first request and before the second.
		expect(systemPrompts[1]).toEqual([TURN_OVERRIDE]);
	});

	it("is dropped when the next prompt is prepared", async () => {
		const { session: active, systemPrompts } = createSession();

		await active.prompt("hello");
		await active.waitForIdle();
		await active.prompt("again");
		await active.waitForIdle();

		// The second prompt makes exactly one request (the scripted turns'
		// last response repeats); its preparation cleared the previous turn's
		// override, so the replacement cannot leak forward.
		expect(systemPrompts).toHaveLength(3);
		expect(systemPrompts[2]).toEqual([BASE]);
	});

	it("refuses anything that is not a non-empty string array", () => {
		const { session: active } = createSession();

		expect(() => active.setTurnSystemPrompt([])).toThrow(TypeError);
		expect(() => active.setTurnSystemPrompt("not-an-array" as unknown as string[])).toThrow(TypeError);
		expect(() => active.setTurnSystemPrompt([BASE, 7 as unknown as string])).toThrow(TypeError);
		expect(active.systemPrompt).toEqual([BASE]);
	});
});

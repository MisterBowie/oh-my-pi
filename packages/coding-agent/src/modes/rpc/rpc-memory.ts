/** Native memory management; no model turn or transcript append is performed. */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { resolveMemoryBackend } from "../../memory-backend/resolve";
import { getMnemopiSessionState } from "../../mnemopi/state";
import type { AgentSession } from "../../session/agent-session";

export async function executeMemoryRpc(
	session: AgentSession,
	input: {
		action: string;
		query?: unknown;
		limit?: unknown;
		offset?: unknown;
	},
): Promise<object> {
	if (!["status", "list", "search", "clear"].includes(input.action)) throw new Error("Invalid memory action");
	const limit = input.limit ?? 50;
	const offset = input.offset ?? 0;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		typeof offset !== "number" ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 100000
	)
		throw new Error("Invalid memory page");
	if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 2000))
		throw new Error("Invalid memory query");
	if (
		session.isBashRunning ||
		session.isEvalRunning ||
		session.isGeneratingHandoff ||
		session.isStreaming ||
		session.isCompacting ||
		session.queuedMessageCount > 0 ||
		(session.getAsyncJobSnapshot()?.running.length ?? 0) > 0 ||
		(session.getAsyncJobSnapshot()?.delivery.queued ?? 0) > 0 ||
		session.getAsyncJobSnapshot()?.delivery.delivering
	)
		throw new Error("Memory management requires an idle session");
	await session.waitForMemoryBackend();
	const backend = await resolveMemoryBackend(session.settings);
	const context = { agentDir: getAgentDir(), cwd: session.sessionManager.getCwd(), session };
	if (input.action === "status")
		return backend.status ? await backend.status(context) : { backend: backend.id, active: false };
	if (input.action === "clear") {
		await backend.clear(context.agentDir, context.cwd, session);
		return { cleared: true };
	}
	if (input.action === "search") {
		const query = typeof input.query === "string" ? input.query.trim() : "";
		if (!query) throw new Error("Memory search requires a query");
		if (!backend.search) throw new Error("Memory backend does not support search");
		return await backend.search(context, query, { limit });
	}
	if (backend.id !== "mnemopi") throw new Error("Memory browsing requires Mnemopi");
	const state = getMnemopiSessionState(session);
	if (!state) throw new Error("Mnemopi is not initialized");
	const db = (state.aliasOf ?? state).memory.beam.db;
	const rows = `SELECT id, content, source, timestamp, created_at FROM working_memory
  WHERE superseded_by IS NULL AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
  UNION ALL SELECT id, content, source, timestamp, created_at FROM episodic_memory
  WHERE superseded_by IS NULL AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
  UNION ALL SELECT fact_id AS id, subject || ' ' || predicate || ' ' || object AS content,
    'facts' AS source, timestamp, created_at FROM facts`;
	const total = db.query<{ total: number }, []>(`SELECT count(*) AS total FROM (${rows})`).get()?.total ?? 0;
	const items = db
		.query<{ id: string; content: string; source: string | null; timestamp: string | null }, [number, number]>(
			`SELECT id, substr(content, 1, 16000) AS content, source, timestamp FROM (${rows}) ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
		)
		.all(limit, offset);
	return { backend: "mnemopi", total, offset, items };
}

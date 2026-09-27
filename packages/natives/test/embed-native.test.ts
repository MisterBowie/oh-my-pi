import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { extractEmbeddedAddonArchive } from "../native/loader-state.js";
import { embedNativeAddon } from "../scripts/embed-native";

const ARCHIVE_NAME = "embedded-addons.linux-x64.tar.gz";
const ADDON_NAME = "pi_natives.linux-x64-modern.node";
const FIXTURE_VERSION = "9.9.9";
const FIXTURE_ADDON = Buffer.from(`binary__piNativesV9_9_9 payload 0123456789\n`.repeat(32));

/** Embed one addon into a throwaway tree and return the archive it wrote. */
async function embedFixture(): Promise<{ root: string; nativeDir: string; archive: Uint8Array }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
	const nativeDir = path.join(root, "native");
	await fs.mkdir(nativeDir);
	await Bun.write(path.join(nativeDir, ADDON_NAME), FIXTURE_ADDON);
	await embedNativeAddon({
		targetPlatform: "linux",
		targetArch: "x64",
		nativeDir,
		outputPath: path.join(nativeDir, "embedded-addon.js"),
		version: FIXTURE_VERSION,
	});
	return {
		root,
		nativeDir,
		archive: new Uint8Array(await Bun.file(path.join(nativeDir, ARCHIVE_NAME)).arrayBuffer()),
	};
}

describe("native addon embedding", () => {
	it("rejects a longer release sentinel that starts with the expected version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outputPath = path.join(nativeDir, "embedded-addon.js");
		try {
			await fs.mkdir(nativeDir);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), "binary__piNativesV18_1_10");

			await expect(
				embedNativeAddon({
					targetPlatform: "win32",
					targetArch: "arm64",
					nativeDir,
					outputPath,
					version: "18.1.1",
				}),
			).rejects.toThrow("does not contain the @oh-my-pi/pi-natives@18.1.1 version sentinel `__piNativesV18_1_1`");
			expect(await Bun.file(outputPath).exists()).toBe(false);
			expect(await Bun.file(path.join(nativeDir, "embedded-addons.win32-arm64.tar.gz")).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("packages unchanged addons into byte-identical archives", async () => {
		const first = await embedFixture();
		const second = await embedFixture();
		try {
			expect(first.archive.length).toBeGreaterThan(0);
			expect(Buffer.from(second.archive).equals(Buffer.from(first.archive))).toBe(true);
			// The bytes are stable because no entry carries the time the archive
			// was written: the second is the mtime field of the first ustar block.
			expect(Buffer.from(gunzipSync(first.archive).subarray(136, 148)).toString("latin1")).toBe("00000000000\0");
		} finally {
			await fs.rm(first.root, { recursive: true, force: true });
			await fs.rm(second.root, { recursive: true, force: true });
		}
	});

	it("writes an archive the compiled loader can still extract", async () => {
		const { root, nativeDir, archive } = await embedFixture();
		const targetDir = path.join(root, "extracted");
		try {
			await fs.mkdir(targetDir);
			const archivePath = path.join(root, "archive.tar.gz");
			await Bun.write(archivePath, archive);

			const extracted = extractEmbeddedAddonArchive({
				archivePath,
				files: [{ variant: "modern", filename: ADDON_NAME, size: FIXTURE_ADDON.length }],
				targetDir,
			});

			expect(extracted).toEqual([path.join(targetDir, ADDON_NAME)]);
			expect(await Bun.file(path.join(targetDir, ADDON_NAME)).bytes()).toEqual(new Uint8Array(FIXTURE_ADDON));
			// The embedded module points the loader at the archive beside it.
			const embeddedModule = await Bun.file(path.join(nativeDir, "embedded-addon.js")).text();
			expect(embeddedModule).toContain(`../native/${ARCHIVE_NAME}`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

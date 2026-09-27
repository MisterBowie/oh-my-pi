import { describe, expect, it } from "bun:test";
import { BuildBinaryArgsError, parseBuildBinaryArgs } from "../scripts/build-binary";

/**
 * `packages/coding-agent/scripts/build-binary.ts` is the build entry OMP Desktop's
 * bundled sidecar drives, so its switches are part of a release contract:
 * precompiled bytecode stays the default (the release behavior and the fast
 * boot path), turning it off is explicit, and a typo fails the build instead of
 * silently shipping the default.
 */
describe("build-binary bytecode switch", () => {
	it("keeps bytecode on unless the caller turns it off", () => {
		expect(parseBuildBinaryArgs([])).toEqual({ bytecode: true });
		expect(parseBuildBinaryArgs(["--bytecode"])).toEqual({ bytecode: true });
		expect(parseBuildBinaryArgs(["--no-bytecode"])).toEqual({ bytecode: false });
	});

	it("refuses an unknown or repeated switch instead of ignoring it", () => {
		expect(() => parseBuildBinaryArgs(["--no-bytecod"])).toThrow(BuildBinaryArgsError);
		expect(() => parseBuildBinaryArgs(["--no-bytecod"])).toThrow("Unsupported build-binary argument: --no-bytecod");
		expect(() => parseBuildBinaryArgs(["--bytecode", "--no-bytecode"])).toThrow(
			"Bytecode mode was already given; refusing redundant --no-bytecode",
		);
		expect(() => parseBuildBinaryArgs(["--no-bytecode", "--no-bytecode"])).toThrow("already given");
	});
});

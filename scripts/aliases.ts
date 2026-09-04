import { existsSync } from "node:fs";
import { resolve } from "node:path";

const RootDir = resolve(import.meta.dirname, "..");

export function resolveSource(base: string, subPath: string): string {
	if (subPath.endsWith(".ts")) return resolve(RootDir, base, subPath);
	const direct = resolve(RootDir, base, `${subPath}.ts`);
	if (existsSync(direct)) return direct;
	return resolve(RootDir, base, subPath, "index.ts");
}

export const aliasEntries = [
	{
		find: "#lib",
		replacement: "#lib",
		customResolver(source: string) {
			const subPath = source.replace("#lib/", "");
			return resolveSource("src/lib", subPath);
		},
	},
	{
		find: "#generated/prisma",
		replacement: resolve(RootDir, "src/generated/prisma/client.ts"),
	},
	{
		find: "#common",
		replacement: "#common",
		customResolver(source: string) {
			const subPath = source.replace("#common/", "");
			return resolveSource("src/lib/common", subPath);
		},
	},
	{
		find: "#types",
		replacement: "#types",
		customResolver(source: string) {
			if (source === "#types")
				return resolve(RootDir, "src/lib/types/index.ts");
			const subPath = source.replace("#types/", "");
			return resolveSource("src/lib/types", subPath);
		},
	},
	{
		find: "#utils",
		replacement: "#utils",
		customResolver(source: string) {
			const subPath = source.replace("#utils/", "");
			return resolveSource("src/lib/utilities", subPath);
		},
	},
];

import type { BunPlugin } from "bun";

const shimDevtools: BunPlugin = {
	name: "shim-react-devtools",
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => {
			return {
				path: "react-devtools-core",
				namespace: "shim",
			};
		});
		build.onLoad({ filter: /.*/, namespace: "shim" }, () => {
			return {
				contents: "export default undefined;",
				loader: "js",
			};
		});
	},
};

const result = await Bun.build({
	entrypoints: ["./src/index.tsx"],
	outdir: "./dist",
	target: "node",
	format: "esm",
	plugins: [shimDevtools],
	// `open` ships platform-specific shell scripts that the bundler can't
	// pull in as assets; keep it external so npm resolves it at install time.
	external: ["open"],
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log(`Bundled ${result.outputs.length} file(s)`);

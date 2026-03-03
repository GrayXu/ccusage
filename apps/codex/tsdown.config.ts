import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	outDir: 'dist',
	format: 'esm',
	target: 'node16',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: false,
	publint: true,
	unused: true,
	fixedExtension: false,
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
});

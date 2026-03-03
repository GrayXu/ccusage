import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_*.ts', // Exclude internal files with underscore prefix
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	target: 'node16',
	fixedExtension: false,
	dts: {
		tsgo: false,
		resolve: ['type-fest', 'valibot', '@ccusage/internal', '@ccusage/terminal'],
	},
	publint: true,
	unused: true,
	exports: {
		devExports: true,
	},
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
});

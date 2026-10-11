import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		allowedHosts: true
	},
	build: {
		target: ['chrome109', 'edge109'],
		cssTarget: ['chrome109', 'edge109']
	},
	plugins: [sveltekit()]
});

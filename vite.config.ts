import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import vercel from '@sveltejs/adapter-vercel';

export default defineConfig({
  plugins: [sveltekit({
    adapter: vercel()
  })],
  build: {
    rollupOptions: {
      external: ['pdf-parse']
    }
  }
});
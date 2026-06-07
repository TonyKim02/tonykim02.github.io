import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://tonykim02.github.io',
  markdown: {
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: true,
    },
  },
});

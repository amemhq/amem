import { defineConfig } from 'vitepress'
import { createRequire } from 'module'
import llmstxt from 'vitepress-plugin-llms'

const require = createRequire(import.meta.url)
const pkg = require('../../packages/openclaw-amem/package.json')

export default defineConfig({
  title: 'amem',
  description: 'amem — an open-source agentic-memory stack for LLM agents. Memories evolve, not just accumulate: graph linking, hybrid retrieval, and LLM-driven evolution. TypeScript, local embeddings, no Python.',
  base: '/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.webp', type: 'image/webp' }],
  ],

  themeConfig: {
    logo: '/logo.webp',
    siteTitle: 'amem',

    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'OpenClaw Plugin', link: '/guide/installation' },
      { text: `v${pkg.version}`, link: 'https://github.com/heichaowo/amem/releases' },
    ],

    sidebar: [
      {
        text: 'Overview',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'How A-MEM Works', link: '/guide/how-it-works' },
          { text: 'Memory Evolution & Quality', link: '/guide/evolution' },
          { text: 'Agent Isolation', link: '/guide/agent-isolation' },
          { text: 'A-MEM vs Traditional RAG', link: '/guide/comparison' },
          { text: 'Design Rationale', link: '/guide/design-rationale' },
        ],
      },
      {
        text: 'OpenClaw Plugin',
        items: [
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Tools', link: '/reference/tools' },
          { text: 'Embedding Models', link: '/reference/embedding-models' },
          { text: 'Smoke Test Results', link: '/reference/smoketest' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Contributing Guide', link: '/guide/contributing' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/heichaowo/amem' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Based on <a href="https://arxiv.org/abs/2502.12110">A-MEM</a> (NeurIPS 2025)',
    },

    editLink: {
      pattern: 'https://github.com/heichaowo/amem/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },

  vite: {
    plugins: [llmstxt() as any],
  },
})

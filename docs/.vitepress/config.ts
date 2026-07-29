import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "imgmeta.js",
  description: "Read image dimensions and JPEG EXIF metadata with no runtime dependencies.",
  base: "/imgmeta.js/",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Documentation', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/read' }
    ],

    sidebar: {
      '/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Supported Formats', link: '/guide/formats' }
          ]
        },
        {
          text: 'API Reference',
          items: [
            { text: 'read()', link: '/api/read' },
            { text: 'insert()', link: '/api/insert' },
            { text: 'update()', link: '/api/update' },
            { text: 'remove()', link: '/api/remove' },
            { text: 'Types', link: '/api/types' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/wayne/imgmeta.js' }
    ]
  }
})

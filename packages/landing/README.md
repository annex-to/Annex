# Annex Landing Page

Static landing page for the Annex project. Single-page design optimized for performance and mobile responsiveness.

## Features

- Pure HTML/CSS, no build step required
- Dark cinema theme matching main application
- Fully responsive design for all devices
- Optimized for fast loading and small file size
- Ready for Cloudflare Pages deployment

## Local Development

Start the dev server with hot reloading:

```bash
bun run dev
```

Server runs at http://localhost:5174 and automatically reloads when HTML or CSS files change.

Alternatively, open `index.html` directly in a browser or serve with any static file server:

```bash
# Python
python3 -m http.server 8000

# Bun
bunx serve .

# Node
npx serve .
```

## Deployment to Cloudflare Pages

1. Create new project in Cloudflare Pages
2. Connect to GitHub repository
3. Configure build settings:
   - Build command: (leave empty)
   - Build output directory: `/packages/landing`
4. Deploy

## File Structure

```
packages/landing/
├── index.html       # Main landing page
├── styles.css       # Stylesheet with Annex design system
├── dev-server.ts    # Development server with hot reload
├── package.json     # Package configuration
└── README.md        # This file
```

## Design System

Follows Annex design system:
- Colors: `#ef4444` (annex-500), `#dc2626` (annex-600), `#eab308` (gold-500)
- Dark background with red ambient glow
- Glassy elements with backdrop blur
- 4px border radius
- Smooth transitions (150ms)

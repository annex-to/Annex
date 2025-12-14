# Contributing to Annex

Thank you for your interest in contributing to Annex! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9.14+
- PostgreSQL database
- Git

### Getting Started

1. Fork the repository and clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/annex.git
   cd annex
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Set up your environment:

   ```bash
   cp .env.example .env
   # Edit .env with your database URL and API keys
   ```

4. Run database migrations:

   ```bash
   pnpm prisma migrate dev
   ```

5. Start the development servers:

   ```bash
   pnpm dev
   ```

   This starts both the backend (port 3000) and frontend (port 5173).

## Code Style

We use ESLint and Prettier to maintain consistent code style. Before submitting a PR:

```bash
pnpm lint        # Check for linting errors
pnpm lint:fix    # Auto-fix linting errors
pnpm format      # Format code with Prettier
pnpm typecheck   # Verify TypeScript types
```

### Guidelines

- Keep code self-documenting; avoid unnecessary comments
- Prefer simple solutions over clever ones
- No emojis in code, commits, or communication
- Follow existing patterns in the codebase
- See [CLAUDE.md](../CLAUDE.md) for detailed code style guidelines

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat(encoding): add HDR10+ tonemapping support
fix(delivery): handle SFTP timeout gracefully
docs(readme): update installation instructions
refactor(api): simplify error handling
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

## Pull Request Process

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Make your changes and commit following the commit conventions

3. Ensure all checks pass:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm build
   ```

4. Push your branch and open a PR against `main`

5. Fill out the PR template completely

6. Wait for review - a maintainer will review your PR and may request changes

## Project Structure

```
packages/
  client/     # React frontend (Vite, Tailwind)
  server/     # Node.js backend (tRPC, Prisma)
  encoder/    # Remote encoder package
  shared/     # Shared TypeScript types
```

## Getting Help

- Check existing issues and discussions
- Open a new issue for bugs or feature requests
- Be respectful and constructive in all interactions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

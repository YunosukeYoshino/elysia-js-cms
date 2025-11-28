# ElysiaJS CMS API

<img width="1918" height="1068" alt="image" src="https://github.com/user-attachments/assets/e47bab31-458e-4dbe-add6-90ba0f9c06a3" />

<div align="center">

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![ElysiaJS](https://img.shields.io/badge/ElysiaJS-259dff?style=for-the-badge)](https://elysiajs.com)
[![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)](https://www.prisma.io/)
[![SQLite](https://img.shields.io/badge/sqlite-%2307405e.svg?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**A high-performance, lightweight CMS API built with ElysiaJS and Bun.**

[Features](#features) • [Tech Stack](#tech-stack) • [Getting Started](#getting-started) • [API Documentation](#api-documentation) • [Development](#development)

</div>

---

## Overview

This project is a robust Content Management System (CMS) backend API designed for speed and developer experience. Built on the modern **Bun** runtime and **ElysiaJS** framework, it provides a complete suite of features for managing content, authentication, and media.

Whether you're building a blog, a documentation site, or a portfolio, this API serves as a solid foundation with built-in type safety and comprehensive documentation.

## Features

- **🔐 Secure Authentication**: robust JWT-based authentication with access and refresh token rotation.
- **📝 Content Management**: Full CRUD operations for Posts and Categories.
- **🏷️ Taxonomy**: Flexible many-to-many relationships between posts and categories.
- **📂 File Management**: Integrated file uploads with automatic thumbnail generation and MIME type validation.
- **🛡️ Rate Limiting**: Built-in protection against abuse with configurable rate limits.
- **📑 API Documentation**: Interactive Swagger/OpenAPI documentation available out-of-the-box.
- **⚡ High Performance**: Powered by Bun and ElysiaJS for sub-millisecond response times.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [ElysiaJS](https://elysiajs.com)
- **Database**: [SQLite](https://www.sqlite.org) (via [Prisma](https://www.prisma.io))
- **ORM**: [Prisma](https://www.prisma.io)
- **Language**: [TypeScript](https://www.typescriptlang.org)
- **Linting & Formatting**: [Biome](https://biomejs.dev)

## Getting Started

### Prerequisites

- **Bun**: You need to have Bun installed on your machine.
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

### Installation

1.  **Clone the repository**
    ```bash
    git clone <your-repo-url>
    cd elysia-js-cms
    ```

2.  **Install dependencies**
    ```bash
    bun install
    ```

3.  **Environment Setup**
    Copy the example environment file and configure your secrets.
    ```bash
    cp .env.example .env
    ```
    > **Note**: Ensure you set a secure `JWT_SECRET` in your `.env` file.

### Database Setup

1.  **Initialize the database**
    This command runs migrations and sets up your SQLite database.
    ```bash
    bun run prepare-db:dev
    ```

2.  **Seed data (Optional)**
    Populate the database with initial test data.
    ```bash
    bun run seed
    ```

### Running the Application

**Development Mode** (with hot reload)
```bash
bun run dev
```

**Production Mode**
```bash
bun run start
```

The server will start at `http://localhost:3001`.

## API Documentation

Interactive API documentation is automatically generated using Swagger UI.

1.  Start the server (`bun run dev`).
2.  Navigate to `http://localhost:3001/swagger`.

Here you can explore all endpoints, test requests, and view data schemas.

### Key Endpoints

| Category | Endpoint | Description |
|----------|----------|-------------|
| **Auth** | `POST /api/auth/register` | Register a new user |
| | `POST /api/auth/login` | Login and receive tokens |
| **Posts** | `GET /api/posts` | List all published posts |
| | `POST /api/posts` | Create a new post (Auth required) |
| **Categories** | `GET /api/categories` | List all categories |
| **Files** | `POST /api/files/upload` | Upload a file (Auth required) |

## Development

### Code Quality

We use **Biome** for ultra-fast linting and formatting.

- **Format code**:
  ```bash
  bun run format
  ```
- **Lint code**:
  ```bash
  bun run lint
  ```
- **Type Check**:
  ```bash
  bun run typecheck
  ```

### Testing

Run the test suite using Bun's built-in test runner.

```bash
# Run all tests
bun test

# Run tests with coverage
bun run test:coverage

# Watch mode
bun run test:watch
```

## Project Structure

```
src/
├── domain/          # Domain entities and business logic
├── lib/             # Shared utilities (Auth, Network, Prisma)
├── middlewares/     # Application middleware (Auth, Rate Limit)
├── routes/          # API Route handlers
├── scripts/         # Database maintenance scripts
├── tests/           # Integration and Unit tests
└── types/           # TypeScript type definitions
```

---

<div align="center">
  <sub>Built with ❤️ using <a href="https://elysiajs.com">ElysiaJS</a> and <a href="https://bun.sh">Bun</a></sub>
</div>
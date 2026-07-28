# Contributing to imgmeta

First off, thank you for considering contributing to `imgmeta`! Contributions are what make the open-source community such an amazing place to learn, inspire, and create.

Please read through these guidelines to ensure a smooth and productive contribution process.

---

## Code of Conduct

By participating in this project, you agree to maintain a respectful, welcoming, and collaborative environment.

---

## Core Principles

- **Zero Runtime Dependencies**: The core library MUST have absolutely zero external runtime dependencies. Any utility or parser (such as JPEG segment parsing, format detection, or binary TIFF encoding) must be implemented from scratch using Node.js built-ins.
- **TypeScript First**: All source code is written in TypeScript. Code compilation yields clean ES modules with `.js` import paths.
- **Thoroughly Documented**: Every new feature, binary offset calculation, and helper method should be fully commented to explain its purpose and inner workings for other contributors.

---

## Getting Started

### 1. Prerequisite
- Node.js (version 22 or newer recommended for native TypeScript stripping and test runner support).

### 2. Fork and Clone
Fork the repository on GitHub, then clone your fork locally:
```bash
git clone https://github.com/your-username/imgmeta.js.git
cd imgmeta.js
```

### 3. Install Development Dependencies
```bash
npm install
```

---

## Development Workflow

### Building the Project
Compile the TypeScript code in the `src/` directory to the `dist/` directory:
```bash
npm run build
```

### Type Checking
Ensure all TypeScript definitions and checks are passing:
```bash
npm run typecheck
```

### Running Tests
We use the native Node.js test runner via `tsx` for fast, zero-overhead testing. Run the test suite using:
```bash
npm test
```

---

## Codebase Structure

- `src/exif.ts`: Binary parser scanning JPEG segments for APP1 markers and decoding TIFF/IFD blocks.
- `src/Image.ts`: Extracts format signatures from magic bytes and parses width and height across various image formats.
- `src/metadata.ts`: Binary editor responsible for segment splitting, compiling/encoding TIFF blocks, and safe metadata merging.
- `src/types.ts`: Shared public type exports.
- `src/index.ts`: Library entry point.
- `test/`: Contains unit test suites and mock images (e.g., `sample.jpg`).

---

## Submitting Pull Requests

1. **Create a branch**: Create a descriptive branch name from `main` (e.g. `feat/png-exif-reading` or `fix/webp-dimension-offset`).
2. **Write clean code**: Adhere to the formatting of the existing codebase. Write comments explaining any binary structure offsets or byte manipulations.
3. **Add tests**: Add test cases to cover your changes in `test.ts` or `test/`.
4. **Verify passing builds**: Ensure `npm run build`, `npm run typecheck`, and `npm test` all complete successfully without errors.
5. **Open a PR**: Describe your changes in detail, explaining the motivation, implementation, and how you verified it.

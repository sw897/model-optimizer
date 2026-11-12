# Contributing

Use a maintained Node.js LTS release and npm. Runtime compatibility starts at Node.js 20.9.0; the development toolchain may require a newer maintained LTS.

```sh
npm ci
npm run build
npm run lint
npm test
npm run audit:dependencies
npm run package
npm run test:package
```

Use generated fixtures for geometry, images and metadata. Include a small reproduction for bug reports; remove confidential paths, coordinates and business data. Describe input type, OS/architecture, Node.js version, CLI arguments and expected behavior.

Preserve geometry values and object/part identity when changing optimization. Preserve consecutive accepted LOD levels and base-only fallbacks when changing simplification. Add regression coverage for changed behavior. Existing input/output schema IDs are compatibility contracts.

The version in `package.json` is the CLI's version source. When changing runtime dependencies, update `package-lock.json`, `toolchain.lock.json`, third-party notices and the unreleased changelog. `npm run check:release` verifies metadata consistency after a build. Run the package smoke check to validate installed artifacts, rather than relying only on the source checkout.

Contributions are provided under Apache-2.0. Submit only material you are authorized to contribute, including employer-owned code and sample assets. No additional contributor agreement is currently required.

All current work is local preparation. Follow [release preparation](docs/releasing.md) before making a public release. Security reports follow [SECURITY.md](SECURITY.md).

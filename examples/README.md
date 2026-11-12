# Generated examples

Run from a source checkout after installing dependencies:

```sh
npm run build
npm run example
```

The generator creates `artifacts/example/` and refuses an existing destination. Use `npm run example -- <new-directory>` for another run. It creates a synthetic indexed grid with procedural color, normal and roughness textures, a GLB directory with an auxiliary offset file, a standard 3D Tiles entry and a complete directory conforming to the LOD input specification. All generated content is Apache-2.0 licensed.

```sh
node dist/opt-cli.js -i artifacts/example/model.glb -o artifacts/example/model-web.glb --json
node dist/opt-cli.js -i artifacts/example/models -o artifacts/example/models-web --json
node dist/opt-cli.js -i artifacts/example/tileset -o artifacts/example/tileset-web --json
node dist/cli.js -i artifacts/example/lod-input -o artifacts/example/lod --max-level 1 --json
```

The LOD example produces candidate geometry; it does not construct a new runtime tile hierarchy. See [the input specification](../docs/input-specification.md).

For a reproducible comparison, retain the JSON reports and record the package version, OS/architecture, Node.js version, `inputBytes`, `outputBytes` and elapsed time. This small synthetic fixture demonstrates behavior; its compression ratio does not predict production datasets.

No production coordinates, customer assets or external models are used. The offset data is synthetic and exists only to demonstrate byte-preserving auxiliary-file copying.

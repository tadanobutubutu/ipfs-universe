# IPFS Universe - Local Version

This is the local version of the IPFS Universe dashboard.
It features real-time IPFS peer discovery and integration with Notion via the `ncli` tool.

## Key Features
1. **Real-time libp2p**: Connects to actual IPFS nodes.
2. **ncli Bridge**: Allows the web UI to interact with Notion using your local `ncli` authentication.
3. **WASM Physics**: High-performance particle simulation powered by Zig.

## How to Run
```bash
npm install
npm run ipfsuniverse
```

The app will be available at `http://localhost:5173`.
When running on localhost, the "Notion Hub" panel will trigger actual `ncli` commands on your machine.

## Prerequisites
- `ncli` tool installed and logged in (`ncli login`).
- `zig` compiler (if modifying WASM code).

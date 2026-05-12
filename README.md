# 🌌 IPFS Universe 2.0

> A high-performance, real-time 3D visualization of the IPFS network, powered by WebGPU, WASM, and Helia.

[![Live Site](https://img.shields.io/badge/Live-ipfsuniverse.xyz-58a6ff?style=for-the-badge&logo=ipfs&logoColor=white)](https://ipfsuniverse.xyz)
[![Tech Stack](https://img.shields.io/badge/Stack-TypeScript%20%7C%20WebGPU%20%7C%20WASM-blue?style=for-the-badge)](https://github.com/tadanobutubutu/ipfs-universe)

---

## 🚀 Key Features

### 💎 Cutting-Edge Rendering
- **WebGPU Native**: Leveraging the next generation of web graphics for maximum performance.
- **Legacy Fallback**: Automatic detection and graceful degradation to **WebGL 1.0** for older environments.
- **GSAP Orchestration**: Silky smooth UI transitions and cinematic entrance animations.

### ⚙️ High-Performance Physics
- **Zig/Rust WASM Engine**: Particle physics calculated in WebAssembly to bypass JavaScript's main-thread overhead.
- **Lock-Free Concurrency**: SharedArrayBuffer + Atomics for thread-safe peer count updates between the main thread and workers.

### 🌐 Decentralized Core
- **In-Browser IPFS Node**: Powered by **Helia**, enabling direct peer discovery without central servers.
- **Persistence Layer**: Peer history and node metadata stored locally via **IndexedDB**.
- **Wallet Integration**: Connect via **MetaMask** to generate unique node identities and customize visuals.

---

## 🛠 Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Engine** | [Three.js r168](https://threejs.org/) |
| **Physics** | [Zig](https://ziglang.org/) / [Rust](https://www.rust-lang.org/) (WASM) |
| **Network** | [Helia](https://github.com/ipfs/helia) (IPFS) |
| **Logic** | [TypeScript](https://www.typescriptlang.org/) |
| **Build** | [Vite](https://vitejs.dev/) |
| **Design** | [GSAP](https://gsap.com/) |

---

## 📦 Getting Started

```bash
# Clone the universe
git clone https://github.com/tadanobutubutu/ipfs-universe.git

# Enter the void
cd ipfs-universe

# Install dependencies
npm install

# Start the engine
npm run dev
```

---

## 📜 Dev Rituals (Legacy Layer)

The project maintains a **Legacy XHR Ritual** layer. While modern IPFS nodes use Fetch, we retain `XMLHttpRequest` for network probing as a tribute to the early days of the web. Trigger it via the **Probe Network** button in the HUD.

---

<p align="center">
  Built with ☕ and 🌌 by <a href="https://github.com/tadanobutubutu">tadanobutubutu</a>
</p>

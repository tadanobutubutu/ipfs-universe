/**
 * Helia Worker
 * Handles IPFS node operations off the main thread.
 * Uses SharedArrayBuffer + Atomics for peer counting.
 */

let peerCounter: Int32Array;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'init') {
    console.log('[WORKER] Initializing Helia Layer...');
    peerCounter = new Int32Array(data.sharedBuffer);
    
    // Simulate Helia initialization
    setTimeout(() => {
      self.postMessage({ type: 'log', msg: 'Helia node is online', level: 'ok' });
      self.postMessage({ type: 'worker_status', status: 'active' });
      
      // Start periodic peer "discovery"
      startDiscovery();
    }, 1000);
  }
};

function startDiscovery() {
  setInterval(() => {
    // Simulate finding a peer
    if (Math.random() > 0.8) {
      // Thread-safe increment using Atomics
      if (peerCounter) {
        Atomics.add(peerCounter, 0, 1);
      }
      
      const peerId = 'Qm' + Math.random().toString(36).substring(2, 15);
      self.postMessage({ 
        type: 'peer_discovered', 
        peer: {
          peerId,
          connectedAt: new Date().toISOString(),
          latency: Math.floor(Math.random() * 200) + 20,
          gatewayUsed: 'worker-direct'
        } 
      });
      
      self.postMessage({ type: 'log', msg: `Connected to peer: ${peerId.substring(0, 8)}...`, level: 'info' });
    }
  }, 4000);
}

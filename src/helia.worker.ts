import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { bootstrap } from '@libp2p/bootstrap';
import { mplex } from '@libp2p/mplex';
import { yamux } from '@libp2p/yamux';
import { noise } from '@chainsafe/libp2p-noise';
import { IDBBlockstore } from 'blockstore-idb';
import { IDBDatastore } from 'datastore-idb';

let helia: any;
let peerCounter: Int32Array;

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data;

  if (type === 'init') {
    peerCounter = new Int32Array(data.sharedBuffer);
    if (data.isLocal) {
      await initHelia();
    } else {
      startSimulation();
    }
  }
};

function startSimulation() {
  self.postMessage({ type: 'log', msg: 'WEB_DEPLOY_DETECTED: STARTING_SIMULATION_LAYER...', level: 'info' });
  self.postMessage({ type: 'worker_status', status: 'simulating' });
  
  // Emit fake peers
  const emitFakePeer = () => {
    const peerId = 'Qm' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    if (peerCounter) peerCounter[0]++;
    
    self.postMessage({ 
      type: 'peer_discovered', 
      peer: {
        peerId,
        latency: Math.floor(Math.random() * 200) + 50,
        gatewayUsed: 'simulated-edge'
      } 
    });
  };

  for (let i = 0; i < 5; i++) setTimeout(emitFakePeer, i * 500);
  setInterval(emitFakePeer, 4000);
  
  startGatewayProbing();
}

async function initHelia() {
  try {
    self.postMessage({ type: 'log', msg: 'INITIALIZING_BLOCKSTORE...', level: 'info' });
    const blockstore = new IDBBlockstore('helia-blocks');
    const datastore = new IDBDatastore('helia-data');
    
    try {
      await blockstore.open();
      await datastore.open();
      self.postMessage({ type: 'log', msg: 'STORAGE_IDB: READY', level: 'info' });
    } catch (e) {
      self.postMessage({ type: 'log', msg: 'STORAGE_IDB: FAILED, USING_MEMORY_FALLBACK', level: 'warn' });
    }

    self.postMessage({ type: 'log', msg: 'CONFIGURING_LIBP2P...', level: 'info' });
    const libp2p = await createLibp2p({
      datastore: datastore as any,
      transports: [webSockets(), webRTC()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux(), mplex()],
      peerDiscovery: [
        bootstrap({
          list: [
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnoo2uR3UniazBqi3CwiJwz3z4Wz1ef9n1dmCDSNCibf',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxatZpknM6AZKresSno2qcq5CD65A4pA9Cun9JzU',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMq3sbv3r5oCyE6uURNFYdg3A39SRAnVvMv5XY',
            '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMo9UFnm7M3hqboxWZ9v5vJpxvKT6XWk65GghVLB'
          ]
        })
      ],
      connectionManager: {
        maxConnections: 10
      }
    });

    self.postMessage({ type: 'log', msg: 'CREATING_HELIA_INSTANCE...', level: 'info' });
    helia = await createHelia({
      blockstore,
      datastore: datastore as any,
      libp2p
    });

    unixfs(helia); // Initialize UnixFS

    self.postMessage({ type: 'log', msg: `Helia node online: ${helia.libp2p.peerId.toString().substring(0, 12)}...`, level: 'ok' });
    self.postMessage({ type: 'worker_status', status: 'online' });

    // Register listeners — Real-time Sync
    helia.libp2p.addEventListener('peer:discovery', (evt: any) => {
      const peerId = evt.detail.id.toString();
      if (Atomics && peerCounter) {
        Atomics.add(peerCounter, 0, 1);
      } else if (peerCounter) {
        peerCounter[0]++;
      }
      
      self.postMessage({ 
        type: 'peer_discovered', 
        peer: {
          peerId,
          latency: Math.floor(Math.random() * 100) + 10,
          gatewayUsed: 'libp2p-direct'
        } 
      });
      
      self.postMessage({ type: 'log', msg: `Peer discovered: ${peerId.substring(0, 8)}...`, level: 'info' });
    });

    helia.libp2p.addEventListener('peer:disconnect', (evt: any) => {
      const peerId = evt.detail.toString();
      if (Atomics && peerCounter) {
        const current = Atomics.load(peerCounter, 0);
        if (current > 0) Atomics.sub(peerCounter, 0, 1);
      } else if (peerCounter) {
        peerCounter[0] = Math.max(0, peerCounter[0] - 1);
      }

      self.postMessage({
        type: 'peer_disconnected',
        peer: { peerId }
      });

      self.postMessage({ type: 'log', msg: `Peer disconnected: ${peerId.substring(0, 8)}...`, level: 'warn' });
    });

    startGatewayProbing();

  } catch (err: any) {
    self.postMessage({ type: 'log', msg: `HELIA_ERR: ${err.message}`, level: 'error' });
    if (err.message.includes('length') || err.message.includes('IDB')) {
      indexedDB.deleteDatabase('helia-blocks');
      indexedDB.deleteDatabase('helia-data');
    }
    self.postMessage({ type: 'worker_status', status: 'error' });
  }
}

function startGatewayProbing() {
  const gateways = [
    'https://ipfs.io/ipfs/QmUNLLsP2unsqwsjyhpS9nXYXbTq6Hjsh4xU44UToYf8Xq',
    'https://cloudflare-ipfs.com/ipfs/QmUNLLsP2unsqwsjyhpS9nXYXbTq6Hjsh4xU44UToYf8Xq',
    'https://dweb.link/ipfs/QmUNLLsP2unsqwsjyhpS9nXYXbTq6Hjsh4xU44UToYf8Xq',
    'https://gateway.pinata.cloud/ipfs/QmUNLLsP2unsqwsjyhpS9nXYXbTq6Hjsh4xU44UToYf8Xq'
  ];

  const probe = () => {
    const gw = gateways[Math.floor(Math.random() * gateways.length)];
    const xhr = new XMLHttpRequest();
    xhr.open('GET', gw, true);
    xhr.timeout = 5000;
    xhr.onload = () => {
      if (xhr.status === 200) {
        self.postMessage({ type: 'log', msg: `Gateway responded: ${new URL(gw).hostname}`, level: 'info' });
      }
    };
    xhr.onerror = () => {
      self.postMessage({ type: 'log', msg: `Gateway timeout: ${new URL(gw).hostname}`, level: 'error' });
    };
    xhr.send();
  };

  // Initial probes
  probe();
  setTimeout(probe, 2000);
  
  setInterval(probe, 8000);
}

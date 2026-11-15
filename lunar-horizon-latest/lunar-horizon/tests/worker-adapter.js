import {parentPort} from 'node:worker_threads';
globalThis.onmessage=null;globalThis.postMessage=x=>parentPort.postMessage(x);
await import('../src/terrain-worker.js');parentPort.on('message',data=>globalThis.onmessage({data}));

import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {isMainThread, parentPort, workerData} from 'node:worker_threads';

export function packPolarDem(name) {
  const {width, height} = JSON.parse(fs.readFileSync(`data/${name}.json`));
  const source = fs.readFileSync(`data/${name}.bin`);
  const packed = Buffer.alloc(width * height * 2);
  for (let row = 0; row < height; row++) {
    let previous = 0;
    for (let i = row * width; i < (row + 1) * width; i++) {
      const meters = source.readFloatLE(i * 4);
      const value = Number.isFinite(meters) ? Math.round(meters * 2) : -32768;
      packed.writeUInt16LE((value - previous) & 0xffff, i * 2);
      previous = value;
    }
  }
  return gzipSync(packed);
}

if (!isMainThread && ['terrain', 'far'].includes(workerData)) {
  parentPort.postMessage(packPolarDem(workerData));
}

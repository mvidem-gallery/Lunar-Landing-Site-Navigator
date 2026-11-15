import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompactArchiveWindow} from '../src/server.js';

test('compact ranges yield exact row bytes even with reordered parts and binary CRLF', async () => {
  const archive = Buffer.alloc(3000);
  for (let i = 0; i < archive.length; i++) archive[i] = i % 251;
  archive.set([13, 10, 13, 10], 14);
  const batches = [];
  const fetcher = async (url, {headers}) => {
    const ranges = headers.Range.slice(6).split(',').map(pair => pair.split('-').map(Number));
    batches.push(ranges.length);
    if (ranges.length === 1) {
      const [start, end] = ranges[0];
      return new Response(archive.subarray(start, end + 1), {status: 206, headers: {
        'Content-Range': `bytes ${start}-${end}/${archive.length}`,
      }});
    }
    const parts = ranges.reverse().flatMap(([start, end]) => [
      Buffer.from(`\r\n--sample\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${archive.length}\r\n\r\n`),
      archive.subarray(start, end + 1),
    ]);
    return new Response(Buffer.concat([...parts, Buffer.from('\r\n--sample--\r\n')]), {
      status: 206, headers: {'Content-Type': 'multipart/byteranges; boundary="sample"'},
    });
  };
  const request = {firstRow: 1, rowCount: 197, rowBytes: 12, firstByte: 2, bytesPerLine: 4, fileBytes: archive.length};
  const cropped = await readCompactArchiveWindow('https://example.invalid/map.img', request, fetcher);
  assert.deepEqual(batches, [196, 1]);
  const expected = Buffer.concat(Array.from({length: 197}, (_, i) => archive.subarray((i + 1) * 12 + 2, (i + 1) * 12 + 6)));
  assert.deepEqual(Buffer.from(cropped), expected);
});

/** Local, synthetic capacity screening; never connects to MongoDB or AWS. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const mib = 1024 * 1024;
// Multer rejects a file as soon as it reaches the configured 512 MiB boundary.
const audioBytes = 511 * mib;

/** Runs each profile in a fresh process so allocator retention cannot cross profiles. */
async function main() {
  process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), 'archtree-capacity-no-env-file');
  process.env.NODE_ENV = 'test';
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.JWT_SECRET = 'synthetic-capacity-test-only';
  if (process.argv[2] === '--worker') return worker(process.argv[3], process.argv[4]);

  const sharp = (await import('sharp')).default;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'archtree-capacity-'));
  try {
    // A deterministic, block-textured 16 MP image stays within the real byte limit.
    const raw = Buffer.alloc(1000 * 1000 * 3);
    let seed = 42;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = seed >>> 24;
    }
    await sharp(raw, { raw: { width: 1000, height: 1000, channels: 3 } })
      .resize(4000, 4000, { kernel: 'nearest' }).png()
      .toFile(path.join(directory, 'cover.png'));
    const file = await fs.open(path.join(directory, 'audio.wav'), 'w');
    const size = audioBytes;
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(size - 8, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22); header.writeUInt32LE(44100, 24);
    header.writeUInt32LE(176400, 28); header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34); header.write('data', 36);
    header.writeUInt32LE(size - 44, 40);
    await file.write(header); await file.truncate(size); await file.close();
    console.log(JSON.stringify({ fixture: 'synthetic', imagePixels: 16000000,
      imageBytes: (await fs.stat(path.join(directory, 'cover.png'))).size,
      audioBytes: size, platform: process.platform, arch: process.arch, node: process.version,
      logicalCpuAvailability: os.availableParallelism(), totalMemoryLimitEnforced: false }));
    const available = ['idle', 'image-4', 'image-1', 'upload', 'mixed-4', 'mixed-1'];
    const profiles = process.argv[2] ? process.argv[2].split(',') : available;
    assert.ok(profiles.every(profile => available.includes(profile)));
    for (const profile of profiles) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=384', '--import', 'tsx',
          process.argv[1], '--worker', profile, directory], { stdio: 'inherit', env: process.env });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${profile}: exit ${code}`)));
      });
    }
  } finally {
    // Delete only this invocation's mkdtemp directory, after every worker has exited.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('archtree-capacity-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Exercises real image, multipart, metadata, and stream code with local substitutes. */
async function worker(profile: string, directory: string) {
  // Keep Multer's temporary uploads inside the parent-owned synthetic directory.
  process.env.TEMP = directory;
  process.env.TMP = directory;
  process.env.TMPDIR = directory;
  const { createApp } = await import('../src/app');
  const { getCoverArtVariant, createCoverArtVariantScheduler, validateCoverArtFile } =
    await import('../src/services/imageStorageService');
  const { audioUpload, cleanupTemporaryUploads, requireUploadSize } = await import('../src/middleware/audioUpload');
  const { readAudioMetadata } = await import('../src/services/audioMetadataService');
  const { createMediaAbortContext, pipeMediaStream, parseSingleByteRange } =
    await import('../src/services/mediaDeliveryService');
  const express = (await import('express')).default;
  const sharp = (await import('sharp')).default;
  const app = express();
  const sourcePath = path.join(directory, 'audio.wav');
  const imagePath = path.join(directory, 'cover.png');
  const uploadedPaths: string[] = [];
  let uploadedBytes = 0;
  let streamedBytes = 0;
  let imageOutcomes = 0;
  app.post('/synthetic-upload', requireUploadSize(513), cleanupTemporaryUploads,
    audioUpload.single('audioFile'), async (req, res, next) => {
      try {
        assert.ok(req.file);
        uploadedPaths.push(req.file.path);
        const metadata = await readAudioMetadata(req.file);
        assert.equal(metadata.format.sampleRate, 44100);
        await pipeline(createReadStream(req.file.path), new Writable({
          write(chunk, _encoding, callback) { uploadedBytes += chunk.length; callback(); }
        }));
        res.json({ bytes: req.file.size });
      } catch (error) { next(error); }
    });
  app.get('/synthetic-stream', async (req, res, next) => {
    const context = createMediaAbortContext(req, res);
    try {
      assert.ok(typeof req.headers.range === 'string');
      const range = parseSingleByteRange(req.headers.range, audioBytes, 8 * mib);
      assert.ok(range);
      res.status(206).set({ 'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${audioBytes}` });
      await pipeMediaStream(req, res, createReadStream(sourcePath, range), context);
    } catch (error) { context.cleanup(); next(error); }
  });
  app.use(createApp({ environment: 'production' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const initial = process.memoryUsage();
  let peakRss = initial.rss;
  let peakHeap = initial.heapUsed;
  let peakExternal = initial.external;
  const sample = () => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakExternal = Math.max(peakExternal, memory.external);
  };
  const timer = setInterval(sample, 10);
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  const latencies: number[] = [];

  const imageWork = async () => {
    const limit = profile.endsWith('-1') ? 1 : 4;
    const scheduler = createCoverArtVariantScheduler(Math.min(2, limit), limit);
    const imageId = '507f1f77bcf86cd799439011';
    const dependencies = {
      schedule: scheduler,
      findAsset: async () => ({ ownerType: 'album', ownerId: '507f191e810c19729de860ea',
        uploadStatus: 'ready', s3Key: `images/${imageId}`, contentType: 'image/png' }),
      findOwner: async () => ({ coverArtId: imageId, lifecycleStatus: 'ready' }),
      getObject: async () => ({ Body: createReadStream(imagePath), ContentLength: (await fs.stat(imagePath)).size })
    };
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 16 }, async (_, index) => {
        const started = performance.now();
        const result = await getCoverArtVariant(imageId, 1280, { clientKey: `synthetic-${index}` }, dependencies);
        assert.ok(result?.body && result.body.length > 0);
        const metadata = await sharp(result.body).metadata();
        assert.equal(metadata.width, 1280);
        assert.equal(metadata.format, 'webp');
        latencies.push(performance.now() - started);
        imageOutcomes++;
      }));
    }
  };
  const upload = async () => {
    const prefix = Buffer.from('--capacity-boundary\r\nContent-Disposition: form-data; name="audioFile"; filename="synthetic.wav"\r\nContent-Type: audio/wav\r\n\r\n');
    const suffix = Buffer.from('\r\n--capacity-boundary--\r\n');
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/synthetic-upload`, { method: 'POST', headers: {
        'content-type': 'multipart/form-data; boundary=capacity-boundary',
        'content-length': String(prefix.length + audioBytes + suffix.length)
      } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { assert.equal(res.statusCode, 200, body); assert.equal(JSON.parse(body).bytes, audioBytes); resolve(); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      void pipeline(Readable.from((async function* () {
        yield prefix;
        for await (const chunk of createReadStream(sourcePath)) yield chunk;
        yield suffix;
      })()), req).catch(reject);
    });
    assert.equal(uploadedBytes, audioBytes);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await Promise.all(uploadedPaths.map(p => fs.stat(p).then(() => true, () => false)))).every(v => !v)) return;
      await delay(20);
    }
    throw new Error('Synthetic multipart file was not cleaned up');
  };
  const streams = async () => {
    for (let round = 0; round < 8; round++) {
      await Promise.all(Array.from({ length: 16 }, async (_, index) => {
        const start = index * 8 * mib;
        const response = await fetch(`${base}/synthetic-stream`, { headers: { Range: `bytes=${start}-${start + 8 * mib - 1}` } });
        assert.equal(response.status, 206);
        let received = 0;
        for await (const chunk of response.body!) received += chunk.length;
        assert.equal(received, 8 * mib);
        streamedBytes += received;
      }));
    }
  };
  try {
    if (profile === 'idle') await delay(1000);
    else if (profile.startsWith('image')) await imageWork();
    else if (profile === 'upload') await upload();
    else if (profile.startsWith('mixed')) await Promise.all([imageWork(), upload(), streams(),
      fs.readFile(imagePath).then(buffer => validateCoverArtFile({ buffer, path: '', size: buffer.length,
        mimetype: 'image/png' } as Express.Multer.File))]);
    else throw new Error('Unknown profile');
    sample();
    const cpu = process.cpuUsage(cpuStart);
    latencies.sort((a, b) => a - b);
    console.log(JSON.stringify({ profile, baselineRssMiB: +(initial.rss / mib).toFixed(1),
      peakRssMiB: +(peakRss / mib).toFixed(1), lifetimePeakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      peakHeapMiB: +(peakHeap / mib).toFixed(1), peakExternalMiB: +(peakExternal / mib).toFixed(1),
      durationSeconds: +((performance.now() - start) / 1000).toFixed(2),
      cpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(2), imageOutcomes,
      imageP95Ms: Math.round(latencies[Math.ceil(latencies.length * .95) - 1] ?? 0),
      uploadedMiB: uploadedBytes / mib, streamedMiB: streamedBytes / mib, cleanupVerified: true }));
  } finally {
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

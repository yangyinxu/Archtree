import express, { Application, Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';

import path from 'path';

import fs from 'fs';

import adminRoutes from './routes/adminRoutes';
import authRoutes from './routes/authRoutes';
import contentRoutes from './routes/contentRoutes';
import feedRoutes from './routes/feedRoutes';
import videoRoutes from './routes/videoRoutes';
import { attachOptionalAuth, AuthenticatedRequest } from './middleware/authMiddleware';
import { connectToDatabase, getDb } from './infrastructure/database';
import { escapeHtml } from './views/html';
import { maxAudioUploadMb } from './middleware/audioUpload';
import { maxImageUploadMb } from './middleware/imageUpload';
import { getMediaDeliveryMetrics } from './services/mediaDeliveryService';
import { accessTokenDurationSeconds } from './services/authSessionService';

const app: Application = express();
const defaultProxyHops = process.env.NODE_ENV === 'production' ? 2 : 1;
const configuredProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? defaultProxyHops);
app.set('trust proxy', Number.isFinite(configuredProxyHops) && configuredProxyHops >= 0
  ? Math.floor(configuredProxyHops)
  : defaultProxyHops);

console.log(`Service environment: ${process.env.NODE_ENV}`);
console.log(`Authentication access-token lifetime: ${accessTokenDurationSeconds()} seconds`);

app.use('/assets', express.static(path.join(__dirname, 'public')));

// use body parser to parse request body in JSON format
app.use(bodyParser.json());
// parse browser form submissions
app.use(bodyParser.urlencoded({ extended: false }));

// add response headers to avoid CORS error
app.use((req, res, next) => {
  // allow any domain to access the server via wild card
  res.setHeader('Access-Control-Allow-Origin', '*');
  // allow the following HTTP methods
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, PATCH, DELETE');
  // allow clients to send requests with the following types of headers
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use('/admin', adminRoutes);

// forward to /auth router
app.use('/auth', authRoutes);

app.use('/content', contentRoutes);

// forward to /feed router
app.use('/feed', feedRoutes);

// uploads the bigbuck.mp4 video to MongoDB in chunks
/*
app.use('/init-video', function (req, res) {
  const bucket: mongoDb.GridFSBucket = new mongoDb.GridFSBucket(_db);
  const videoUploadStream: mongoDb.GridFSBucketWriteStream = bucket.openUploadStream('bigbuck');
  const videoReadstream: fs.ReadStream = fs.createReadStream(path.join(__dirname + '/bigbuck.mp4'));
  videoReadstream.pipe(videoUploadStream);
  res.status(200).send('Video uploaded successfully!');
});
*/

// forward to /video router
app.use('/video', videoRoutes);

// home page
app.get('/', attachOptionalAuth, async (req, res, next) => {
  try {
    const auth = (req as AuthenticatedRequest).auth;
    const template = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    const headerActions = auth
      ? `<div class="header-actions">
          <span class="muted">${escapeHtml(auth.email)}</span>
          <a class="button" href="/content/manage">Content Manager</a>
          <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
        </div>`
      : `<div class="header-actions">
          <a class="button button--secondary" href="/auth/login-web">Log in</a>
          <a class="button" href="/auth/signup-web">Create account</a>
        </div>`;
    const heroActions = auth
      ? `<div class="action-row">
          <a class="button" href="/content/manage">Open Content Manager</a>
          <a class="button button--secondary" href="/content/manage/audio-tracks">Browse my audio tracks</a>
        </div>`
      : `<div class="action-row">
          <a class="button" href="/auth/signup-web">Create account</a>
          <a class="button button--secondary" href="/auth/login-web">Log in</a>
        </div>`;

    return res.status(200).send(
      template
        .replace('{{HEADER_ACTIONS}}', headerActions)
        .replace('{{HERO_ACTIONS}}', heroActions)
    );
  } catch (error) {
    return next(error);
  }
});

// health endpoint for load balancers and service monitoring
app.get('/health', async (req, res) => {
  try {
    const db = getDb();
    if (!db) throw new Error('Database is unavailable.');
    await db.command({ ping: 1 }, { maxTimeMS: 1_000 });
    return res.status(200).json({
      status: 'ok',
      mediaDelivery: getMediaDeliveryMetrics(),
      memory: {
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed
      }
    });
  } catch {
    return res.status(503).json({
      status: 'unavailable',
      mediaDelivery: getMediaDeliveryMetrics()
    });
  }
});

// catch unexpected requests
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(error);
  }

  const isFileTooLarge = error?.code === 'LIMIT_FILE_SIZE';
  const isTooManyFiles = error?.code === 'LIMIT_FILE_COUNT';
  const isMulterInputError = typeof error?.code === 'string' && error.code.startsWith('LIMIT_');
  const status: number = isFileTooLarge || isTooManyFiles
    ? 413
    : isMulterInputError ? 400 : error.statusCode || 500;
  const message: string = isFileTooLarge
    ? error?.field === 'coverArtFile'
      ? `Cover art is too large. The maximum size is ${maxImageUploadMb} MB.`
      : `Audio file is too large. The maximum size per file is ${maxAudioUploadMb} MB.`
    : isTooManyFiles
      ? 'Too many files were included in this upload.'
      : isMulterInputError
        ? 'Invalid multipart upload.'
    : error.message;
  const data: any = error.data;

  // Only log server-side failures as unexpected errors.
  if (status >= 500) {
    console.log(`Caught unexpected request: ${req.originalUrl}`);
    console.log(error);
  }

  res.status(status).json({ message: message, data: data });
});

const port: string | number = process.env.PORT || process.env.port || 8080;
const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// the app should connect to the database as soon as it starts
connectToDatabase()
  .then(() => {
    const server = app.listen(port, () => {
      console.log('Starting service on port ' + port + '...');
    });
    server.headersTimeout = positiveInteger(process.env.SERVER_HEADERS_TIMEOUT_MS, 60_000);
    server.requestTimeout = positiveInteger(process.env.SERVER_REQUEST_TIMEOUT_MS, 15 * 60_000);
    server.keepAliveTimeout = positiveInteger(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS, 5_000);
    server.timeout = positiveInteger(process.env.SERVER_INACTIVITY_TIMEOUT_MS, 120_000);
    server.maxRequestsPerSocket = positiveInteger(process.env.SERVER_MAX_REQUESTS_PER_SOCKET, 1_000);
    server.maxConnections = positiveInteger(process.env.SERVER_MAX_CONNECTIONS, 1_000);
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.destroy();
    });
  })
  .catch((error) => {
    console.log(`Error connecting to MongoDB: ${error}`);
    throw error;
  });

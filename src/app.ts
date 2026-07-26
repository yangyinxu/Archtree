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
import { connectToDatabase } from './infrastructure/database';
import { escapeHtml } from './views/html';

const app: Application = express();

console.log(`Service environment: ${process.env.NODE_ENV}`);

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
app.get('/health', (req, res, next) => {
  res.status(200).json({ status: 'ok' });
});

// catch unexpected requests
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  const status: number = error.statusCode || 500;
  const message: string = error.message;
  const data: any = error.data;

  // Only log server-side failures as unexpected errors.
  if (status >= 500) {
    console.log(`Caught unexpected request: ${req.originalUrl}`);
    console.log(error);
  }

  res.status(status).json({ message: message, data: data });
});

const port: string | number = process.env.PORT || process.env.port || 8080;

// the app should connect to the database as soon as it starts
connectToDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log('Starting service on port ' + port + '...');
    });
  })
  .catch((error) => {
    console.log(`Error connecting to MongoDB: ${error}`);
    throw error;
  });

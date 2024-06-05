import express, { Application, Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';

import * as dotenv from "dotenv";
import * as mongoDb from 'mongodb';

import path, { dirname } from 'path';

import fs from 'fs';

import adminRoutes from './routes/adminRoutes';
import authRoutes from './routes/authRoutes';
import feedRoutes from './routes/feedRoutes';
import videoRoutes from './routes/videoRoutes';

const app: Application = express();

console.log(`Service environment: ${process.env.NODE_ENV}`);

// use body parser to parse request body in JSON format
app.use(bodyParser.json());

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
app.get('/', (req, res, next) => {
  res.sendFile(path.join(__dirname + '/index.html'));
});

// catch unexpected requests
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  console.log(`Caught unexpected request: ${req.originalUrl}`);
  console.log(error);
  const status: number = error.statusCode || 500;
  const message: string = error.message;
  const data: any = error.data;

  res.status(status).json({ message: message, data: data });
});

// Connection will fail if:
//  1. environment variables have not been configured
//  2. you are on a VPN
let _db: mongoDb.Db;
const port: string | number = process.env.port || 8080;
export async function connectToDatabase() {
  dotenv.config();

  const client: mongoDb.MongoClient = new mongoDb.MongoClient(process.env.DB_CONN_STRING!);

  await client
    .connect()
    .then(client => {
      _db = client.db(process.env.DB_NAME);
      console.log(`Successfully connected to MongoDB: ${_db.databaseName}`);

      app.listen(port, () => {
        console.log('Starting service on port ' + port + '...');
      });
    })
    .catch(error => {
      console.log(`Error connecting to MongoDB: ${error}`);
      throw error;
    });
}

export const getDb = (): mongoDb.Db | null => {
  try {
    if (_db) {
      return _db;
    } else {
      throw new Error('No database found from cache!');
    }
  } catch (error) {
    console.log(error);
    return null;
  }
};

// the app should connect to the database as soon as it starts
exports.mongoConnect = connectToDatabase();
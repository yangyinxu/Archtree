import dotenv from 'dotenv';
dotenv.config();

import express, { Application, Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import fs from 'fs';

import feedRoutes from './routes/feedRoutes';
import authRoutes from './routes/authRoutes';

import { LoggerLevel } from 'mongodb';

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

// forward to /feed router
app.use('/feed', feedRoutes);

// forward to /auth router
app.use('/auth', authRoutes);

// home page
app.get('/', (req, res, next) => {
    fs.readFile('index.html', (err, data) => {
        if (err) {
          // Handle error
          res.writeHead(500, {'Content-Type': 'text/plain'});
          res.end('Internal Server Error');
          return;
        }
  
        // Set the response header and send the file contents
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(data);
      });
});

// catch unexpected requests
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    console.log(error);
    const status: number = error.statusCode || 500;
    const message: string = error.message;
    const data: any = error.data;
    
    res.status(status).json({ message: message, data: data });
});

const MONGO_DB_URL: string = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0.ibqp4.mongodb.net/${process.env.MONGO_DEFAULT_DATABASE}?retryWrites=true&w=majority`;
const port: string | number = process.env.port || 8080;

// Connection will fail if:
//  1. environment variables have not been configured
//  2. you are on a VPN
mongoose
    .connect(MONGO_DB_URL)
    .then(result => {
        app.listen(port, () => {
            console.log('Starting service on port ' + port + '...');
        });
    })
    .catch(error => console.log(error));
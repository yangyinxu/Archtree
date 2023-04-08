require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

const fs = require('fs');

const feedRoutes = require('./routes/feedRoutes');
const authRoutes = require('./routes/authRoutes');

const { LoggerLevel } = require('mongodb');

const app = express();

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
app.use((error, req, res, next) => {
    console.log(error);
    const status = error.statusCode || 500;
    const message = error.message;
    const data = error.data;
    
    res.status(status).json({ message: message, data: data });
});

console.log('Connecting to MongoDb');
const MONGO_DB_URL = `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@cluster0.ibqp4.mongodb.net/${process.env.MONGO_DEFAULT_DATABASE}?retryWrites=true&w=majority`;
const port = process.env.port || 8080;
console.log(`Port: ${port}`);
mongoose
    .connect
    (MONGO_DB_URL)
    .then(result => {
        console.log('Connected to MongoDb');
        app.listen(port, () => {
            console.log('Starting service');
      });
    })
    .catch(error => console.log(error));

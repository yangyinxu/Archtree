const express = require('express');
const bodyParser = require('body-parser');

const feedRoutes = require('./routes/feedRoute');

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

// GET /feed/posts
app.use('/feed', feedRoutes);

app.use((req, res, next) => {
    console.log(req.body);
    res.status(404).send('<h1>Page Not Found</h1>');
});

const port = process.env.port || 8080;
app.listen(port, () => {
    console.log('Starting service');
});
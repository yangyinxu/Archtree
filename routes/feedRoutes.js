const express = require('express');
const { body } = require('express-validator/check');

// import feedController
const feedController = require('../controllers/feedController');

// create a new express router
const router = express.Router();

router.get('/posts', feedController.getPosts);

router.post('/post', [
    body('title')
        .trim()
        .isLength({ min: 5 }),
    body('content')
        .trim()
        .isLength({ min: 5})
], feedController.createPost);

// export the router
module.exports = router;
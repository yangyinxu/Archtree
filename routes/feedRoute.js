const express = require('express');

// import feedController
const feedController = require('../controllers/feedController');

// create a new express router
const router = express.Router();

router.get('/posts', feedController.getPosts);

router.post('/post', feedController.createPost);

// export the router
module.exports = router;
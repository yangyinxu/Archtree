const { validationResult } = require('express-validator/check');

const Post = require('../models/post');

exports.getPosts = (req, res, next) => {
    //return a json response
    res.status(200).json(
        {
            posts: [
                {
                    _id: '1',
                    title: 'First post',
                    content: 'This is the first post!',
                    creator: {
                        name: "testCreator"
                    },
                    createdAt: new Date()
                }
            ]
        }
    );
};

exports.createPost = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            message: 'Validation failed, entered data is incorrect.',
            errors: errors.array()
        });
    }

    const title = req.body.title;
    const content = req.body.content;
    const post = new Post({
        title: title,
        content: content,
        imageUrl: 'https://culverduck.com/wp-content/uploads/2020/11/duck-animate-1-500x500.png',
        creator: { name: "testCreator" }
    });
    post
        .save()
        .then(result => {
            console.log(result);
            // note: 201 means "success - resource created"
            res.status(201).json({
                message: 'Post created successfully!',
                post: result
            });
        })
        .catch(error => {
            console.log(error)
    
        });
}
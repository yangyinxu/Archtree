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
    const title = req.body.title;
    const content = req.body.content;

    console.log(title, content);

    // TODO: Create post in DB
    // note: 201 means "success - resource created"
    res.status(201).json({
        message: 'Post created successfully!',
        post: {
            _id: new Date().toISOString,
            title: title,
            content: content,
            creator: { name: "testCreator" },
            createdat: new Date()
        }
    });
}
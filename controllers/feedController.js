exports.getPosts = (req, res, next) => {
    //return a json response
    res.status(200).json(
        {
            posts: [
                {
                    title: 'First post',
                    content: 'This is the first post!'
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
    res.status(201).json(
        {
            message: 'Post created successfully!',
            post: {
                id: new Date().toISOString,
                title: title,
                content: content
            }
        }
    );
}
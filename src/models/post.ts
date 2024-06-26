import mongoDb, { ObjectId } from 'mongodb';
import { getDb } from '../app';

class Post {
    constructor(
        public title: string,
        public description: string,
        public mainImageUrl: string,
        public imageUrls: string[],
        public userId: ObjectId,
        public createdAt: Date
    ) {
        this.title = title;
        this.description = description;
        this.mainImageUrl = mainImageUrl;
        this.imageUrls = imageUrls;
        this.userId = userId;
        this.createdAt = createdAt;
    }

    save() {
        // save post to database
        const db = getDb();

        return db!
            .collection('posts')
            .insertOne(this)
    }
}

export default Post;
import { Schema, model, Document } from 'mongoose';

export interface PostDocument extends Document {
    title: string;
    imageUrl: string;
    content: string;
    creator: string;
}

const postSchema = new Schema<PostDocument>({
    title: {
        type: String,
        required: true,
    },
    imageUrl: {
        type: String,
        required: true,
    },
    content: {
        type: String,
        required: true,
    },
    creator: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
}, { timestamps: true });

export default model<PostDocument>('Post', postSchema);
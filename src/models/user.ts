import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import PostModel from './post';

// what is wrong this code?
// I want to use the PostModel in the posts property of the UserDocument
// but I get the error:
// Type 'PostModel' is not assignable to type 'ObjectId[] | PostModel[]'.
export interface UserDocument extends Document {
    email: string;
    password: string;
    name: string;
    status: string;
    posts: Types.ObjectId[] | typeof PostModel[];
}

export interface UserModel extends Model<UserDocument> {}

const userSchema: Schema = new Schema({
    email: {
        type: String,
        required: true
    },
    password: {
        type: String,
        required: true
    },
    name: {
        type: String,
        required: true
    },
    status: {
        type: String,
        default: 'New User'
    },
    posts: [{
        type: Schema.Types.ObjectId,
        ref: 'Post'
    }]
});

const User: UserModel = mongoose.model<UserDocument, UserModel>('User', userSchema);

export default User;
import { getDb } from '../app';

// Product Model
class Product {
    title: String;
    price: Number;
    description: String;
    imageUrl: String;

    constructor(
        title: String,
        price: Number,
        description: String,
        imageUrl: String) {
        this.title = title;
        this.price = price;
        this.description = description;
        this.imageUrl = imageUrl;
    }

    save() {
        // save to database
        const db = getDb();

        if (this.title === undefined
            || this.price === undefined
            || this.description === undefined
            || this.imageUrl === undefined
            || db === undefined) {
            console.log('Invalid Product');
            return;
        }

        return db!
            .collection('products')
            .insertOne(this)
    }
}

export default Product;
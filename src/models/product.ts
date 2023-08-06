import { getDb } from '../app';

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
            // how to resolve this issue?
            // Parameter 'result' implicitly has an 'any' type.
            .then((result: any) => {
                console.log(result);
            }
            ).catch((error: any) => {
                console.log(error);
            });
    }
}

export default Product;
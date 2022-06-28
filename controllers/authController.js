const { validationResult } = require('express-validator/check');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/user');
const user = require('../models/user');

exports.signup = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const error = new Error('Validation failed.');
        error.satusCode = 422;
        error.data = errors.array();
        throw error;
    }

    const email = req.body.email;
    const name = req.body.name;
    const password = req.body.password;

    // encrypt the user's password
    bcrypt
        .hash(password, 12)
        .then(hashedPassword => {
            const user = new User({
                email: email,
                password: hashedPassword,
                name: name
            });
            // save user to the database
            return user.save();
        })
        .then(result => {
            res.status(201).json({
                message: 'User created',
                userId: result._id
            })
        })
        .catch(error => {
            if (!error.statusCode) {
                error.statusCode = 500;
            }
            next(error)
        });
};

exports.login = (req, res, next) => {
    const email = req.body.email;
    const password = req.body.password;
    let loadedUser;
    User.findOne({ email: email })
        .then(user => {
            if (!user) {
                const error = new Error('A user with this email could not be found.');
                error.statusCode = 401;
                throw error;
            }
            loadedUser = user;
            return bcrypt.compare(password, user.password);
        })
        .then(isEqual => {
            if (!isEqual) {
                const error = new Error('Wrong password!');
                error.status = 401;
                throw error;
            }
            // generate a new token via jason web token
            // Note: instead of using `secret` as the private key
            // for sigining, a much longer/complicated string should
            // be used in a real application.
            const token = jwt.sign(
                {
                    email: loadedUser.email,
                    userId: loadedUser._id.toString()
                },
                'secret',
                {
                    expiresIn: '1h'
                }
            );
            res.status(200).json({
                token: token,
                userId: loadedUser._id.toString()
            });
        })
        .catch(error => {
            if (!error.statusCode) {
                error.satusCode = 500;
            }
            next(error)
        });
};
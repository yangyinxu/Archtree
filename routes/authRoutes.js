const express = require('express');
const { body } = require('express-validator/check');

const User = require('../models/user');
const authController = require('../controllers/authController');

const router = express.Router();

router.put('/signup', [
    body('email')
        .isEmail()
        .withMessage('Please enter a valid email.')
        .custom((value, { req }) => {
            // check if the user has registered
            return User.findOne({ email: value }).then(userDoc => {
                if (userdoc) {
                    return Promise.reject('email address already exists!');
                }
            });
        })
        .normalizeEmail(),
    body('password').trim().isLength({ min: 5 }),
    body('name').trim().not().isEmpty()
], authController.signup);

module.exports = router;
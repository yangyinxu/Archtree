import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/user';

/**
 * Interface for Error object with statusCode property
 */
interface ErrorWithStatusCode extends Error {
  statusCode?: number;
  data?: any;
}

export const signup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const errors = validationResult(req);
    // check if there are any validation errors
    if (!errors.isEmpty()) {
      const error: ErrorWithStatusCode = new Error('Validation failed.');
      error.statusCode = 422;
      error.data = errors.array();
      throw error;
    }

    const email = req.body.email;
    const username = req.body.username;
    const password = req.body.password;
    const hashedPassword = await bcrypt.hash(password, 12);

    // create a new user
    const user = new User(
      email,
      hashedPassword,
      username,
      []
    );

    user.save()
      .then(result => {
        // return 201 status code for successful creation
        res.status(201).json({
          message: 'User created',
          userId: result.insertedId.toString()
        });
      })
      .catch(err => {
        console.log(err);
        res.status(500).json({
          message: 'Creating the user failed.'
        });
      });
  } catch (error: any) {
    // return 500 status code for server error
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email: string = req.body.email;
    const password: string = req.body.password;
    let loadedUser;

    const user = await User.findByEmail(email);
    // if the user does not exist, throw an error
    if (!user) {
      const error: ErrorWithStatusCode = new Error('A user with this email could not be found.');
      error.statusCode = 401;
      throw error;
    }

    loadedUser = user;

    // compare the password entered with the password in the database
    const isEqual = await bcrypt.compare(password, user.password);
    // if the password is not correct, throw an error
    if (!isEqual) {
      const error: ErrorWithStatusCode = new Error('Wrong password!');
      error.statusCode = 401;
      throw error;
    }

    // create a session token for the user that expires in 1 hour
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

    // return 200 status code for successful login
    res.status(200).json({
      token: token,
      userId: loadedUser._id.toString()
    });
  } catch (error: any) {
    if (!error.statusCode) {
      error.statusCode = 500;
    }
    next(error);
  }
};

import express, { Router } from 'express';
import { body } from 'express-validator';
import { RequestHandler } from 'express';

import User from '../models/user';
import { getAddProduct, postAddProduct } from '../controllers/adminController';

const router: Router = express.Router();

router.get('/product', getAddProduct);
router.post('/product', postAddProduct);

export default router;
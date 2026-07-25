import express, { Router } from 'express';

import { getAddProduct, postAddProduct } from '../controllers/adminController';

const router: Router = express.Router();

router.get('/product', getAddProduct);
router.post('/product', postAddProduct);

export default router;
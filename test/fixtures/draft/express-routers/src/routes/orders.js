const express = require("express");

const ordersRouter = express.Router();
ordersRouter.get("/orders", (req, res) => res.json([]));
ordersRouter.post("/orders/:orderId/cancel", (req, res) => res.json({}));
ordersRouter.patch("/orders/:orderId", (req, res) => res.json({}));

module.exports = { ordersRouter };

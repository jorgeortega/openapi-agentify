const express = require("express");
const users = require("./routes/users");
const { ordersRouter } = require("./routes/orders");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/api/v1/users", users);
app.use("/api/v1", ordersRouter);

app
  .route("/api/v1/carts/:cartId")
  .get((req, res) => res.json({}))
  .put((req, res) => res.json({}))
  .delete((req, res) => res.status(204).end());

app.listen(3000);

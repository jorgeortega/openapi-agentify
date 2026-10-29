import express from "express";
import { listItems } from "./items.js";

const app = express();
app.use(express.json());
app.get("/items", listItems);

app.listen(3000);

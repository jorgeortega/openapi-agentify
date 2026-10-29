const { Router } = require("express");

const router = Router();
router.get("/", (req, res) => res.json([]));
router.get("/:userId", (req, res) => res.json({}));
router.post("/", (req, res) => res.status(201).json({}));

module.exports = router;

// middleware/dbMiddleware.js

const { getDB } = require("../config/db");

const dbMiddleware = (req, res, next) => {
    req.db = getDB();
    next();
};

module.exports = dbMiddleware;
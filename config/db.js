// config/db.js

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);

let db;

const connectDB = async () => {
    try {
        await client.connect();

        db = client.db(process.env.DB_NAME);

        console.log("✅ MongoDB Connected");
        console.log(`📂 Database: ${process.env.DB_NAME}`);
    } catch (error) {
        console.error("❌ MongoDB Connection Failed");
        console.error(error.message);
        process.exit(1);
    }
};

const getDB = () => db;

module.exports = {
    connectDB,
    getDB,
};
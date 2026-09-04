// reset.js
const bcrypt = require("bcryptjs");
const { MongoClient } = require("mongodb");

const MONGO_URI = "mongodb+srv://aws500546_db_user:xwEENtQfas41kYj5@cluster0.ange6kn.mongodb.net/?appName=Cluster0";
const DB_NAME = "web_portal_db";

(async () => {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);

    const newPassword = "Test@123";
    const hash = await bcrypt.hash(newPassword, 10);

    const result = await db.collection("client-details").updateOne(
      { clientCode: "CTS-2087", "users.email": "rahul@gmail.com" },
      { $set: { "users.$.password": hash } }
    );

    console.log("Matched:", result.matchedCount, "Modified:", result.modifiedCount);
    console.log("New password is:", newPassword);
  } catch (e) {
    console.error(e);
  } finally {
    await client.close();
  }
})();
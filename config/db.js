// import axios from "axios";

// export const API_URL = "https://task-backend-mn8a.onrender.com";
// export const LOGIN_API = "/api/auth/login";

// const API = axios.create({
//   baseURL: API_URL,
//   headers: {
//     "Content-Type": "application/json",
//   },
// });

// API.interceptors.request.use(
//   (config) => {
//     const token = localStorage.getItem("token");

//     if (token) {
//       config.headers.Authorization = `Bearer ${token}`;
//     }

//     return config;
//   },
//   (error) => Promise.reject(error)
// );

// API.interceptors.response.use(
//   (response) => response,
//   (error) => {
//     if (error.response?.status === 401) {
//       localStorage.removeItem("token");
//       localStorage.removeItem("user");

//       if (window.location.pathname !== "/login") {
//         window.location.href = "/login";
//       }
//     }

//     return Promise.reject(error);
//   }
// );

// export default API;



const { MongoClient } = require("mongodb");

let client;
let database;

const connectDB = async () => {
  try {
    if (database) {
      return database;
    }

    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

    if (!uri) {
      throw new Error("MongoDB connection URI is missing");
    }

    client = new MongoClient(uri);

    await client.connect();

    database = client.db(process.env.DB_NAME || undefined);

    console.log("MongoDB connected successfully");

    return database;

  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }
};

const getDB = () => {
  if (!database) {
    throw new Error("Database is not connected");
  }

  return database;
};

module.exports = {
  connectDB,
  getDB
};


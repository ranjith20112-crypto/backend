// server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const { connectDB } = require("./config/db");
const dbMiddleware = require("./middleware/dbMiddleware");

// ======================================================
// IMPORT ROUTES
// ======================================================

const employeeRoutes = require("./routes/employeeRoutes");
const clientRoutes = require("./routes/clientRoutes");
const vendorRoutes = require("./routes/vendorRoutes");
const workorderRoutes = require("./routes/workorderRoutes");
const customfieldsRoutes = require("./routes/customfieldRoutes");
const useraccessRoutes = require("./routes/useraccessRoutes");
const moduleRoutes = require("./routes/moduleRoutes");
const verificationRoutes = require("./routes/verificationRoutes");
const verifierRoutes = require("./routes/verifierRoutes");
const datamanagement = require("./routes/datamanagement");
const qcRoutes = require("./routes/qcRoutes");
const pdfRoute = require("./report-forms/address-pdfRoute");
const reportdeliveryRoutes = require("./routes/reportdeliveryRoutes");
const supportTicket = require("./routes/supportTicketRoutes");

// ======================================================
// CREATE EXPRESS APP
// ======================================================

const app = express();

// ======================================================
// CORS
// ======================================================

app.use(
    cors({
        origin: true,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Requested-With"
        ]
    })
);

// ======================================================
// BODY PARSERS
// ======================================================

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

// ======================================================
// LOGGING
// ======================================================

app.use(morgan("dev"));

// ======================================================
// STATIC UPLOADS
// ======================================================

app.use(
    "/uploads",
    express.static(path.join(__dirname, "uploads"))
);

// ======================================================
// ROOT ROUTE
// ======================================================

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Welcome to BGV Portal API 🚀"
    });
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/api/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "BGV Portal API is running",
        environment: process.env.NODE_ENV || "production"
    });
});

// ======================================================
// DATABASE MIDDLEWARE
// ======================================================
//
// IMPORTANT:
// This must come BEFORE routes because the routes use:
//
// req.db.collection(...)
//
// ======================================================

app.use(dbMiddleware);

// ======================================================
// ROUTES
// ======================================================
//
// IMPORTANT:
// employeeRoutes.js already contains:
//
// const API_BASE = "/api";
//
// Therefore:
//
//     app.use(employeeRoutes);
//
// is CORRECT.
//
// DO NOT change it to:
//
//     app.use("/api", employeeRoutes);
//
// because that would create:
//
//     /api/api/checktypes
//
// ======================================================

app.use(employeeRoutes);

app.use(clientRoutes);

app.use(vendorRoutes);

app.use(workorderRoutes);

app.use(customfieldsRoutes);

app.use(useraccessRoutes);

app.use(moduleRoutes);

app.use(verificationRoutes);

app.use(verifierRoutes);

app.use(datamanagement);

app.use(qcRoutes);

app.use(pdfRoute);

app.use(reportdeliveryRoutes);

app.use(supportTicket);

// ======================================================
// ROUTE TEST - CHECK TYPE
// ======================================================
//
// These routes already exist inside employeeRoutes.js.
// This section is ONLY for logging during startup.
//
// ======================================================

console.log("==============================================");
console.log("Employee routes loaded");
console.log("GET  /api/checktypes");
console.log("POST /api/checktype/create");
console.log("GET  /api/subchecktypes");
console.log("POST /api/subchecktype/create");
console.log("==============================================");

// ======================================================
// 404 HANDLER
// ======================================================

app.use((req, res) => {
    console.log(
        `404 - Route Not Found: ${req.method} ${req.originalUrl}`
    );

    res.status(404).json({
        success: false,
        message: "Route Not Found",
        method: req.method,
        path: req.originalUrl
    });
});

// ======================================================
// ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {
    console.error("❌ Server Error:", err);

    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error"
    });
});

// ======================================================
// DATABASE CONNECTION
// ======================================================
//
// Connect once when the application starts.
//
// connectDB() should internally reuse the connection if
// the connection is already established.
//
// ======================================================

let dbConnectionPromise;

function initializeDatabase() {
    if (!dbConnectionPromise) {
        dbConnectionPromise = connectDB()
            .then(() => {
                console.log("✅ MongoDB connected successfully");
            })
            .catch((error) => {
                console.error(
                    "❌ MongoDB connection error:",
                    error
                );

                // Reset so a future invocation can retry.
                dbConnectionPromise = null;

                throw error;
            });
    }

    return dbConnectionPromise;
}

// Initialize database
initializeDatabase().catch(() => {
    // Error already logged above.
});

// ======================================================
// VERCEL / SERVERLESS EXPORT
// ======================================================
//
// Do NOT call app.listen() when running on Vercel.
//
// ======================================================

module.exports = app;

// ======================================================
// LOCAL DEVELOPMENT
// ======================================================

if (require.main === module) {
    const PORT = process.env.PORT || 5000;

    initializeDatabase()
        .then(() => {
            app.listen(PORT, "0.0.0.0", () => {
                console.log(
                    `🚀 Server running on http://localhost:${PORT}`
                );

                console.log(
                    `➡️ Check Types: http://localhost:${PORT}/api/checktypes`
                );

                console.log(
                    `➡️ Sub Check Types: http://localhost:${PORT}/api/subchecktypes`
                );
            });
        })
        .catch((error) => {
            console.error(
                "❌ Server could not start:",
                error
            );

            process.exit(1);
        });
}

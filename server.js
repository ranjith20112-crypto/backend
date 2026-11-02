
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");

const { connectDB } = require("./config/db");
const dbMiddleware = require("./middleware/dbMiddleware");

// ===============================
// Import Routes
// ===============================
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

// ===============================
// Create Express App
// ===============================
const app = express();

// ===============================
// CORS
// ===============================
app.use(
    cors({
        origin: true,
        credentials: true,
    })
);

// ===============================
// Body Parsers
// ===============================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ===============================
// Logging
// ===============================
app.use(morgan("dev"));

// ===============================
// MongoDB Connection
// ===============================

// Start connecting immediately.
// All requests will wait for this promise.
const dbReady = connectDB();

// ===============================
// MongoDB Middleware
// ===============================

// Wait for MongoDB before accessing the database.
app.use(async (req, res, next) => {
    try {
        await dbReady;
        next();
    } catch (error) {
        console.error("❌ Database connection error:", error.message);

        res.status(503).json({
            success: false,
            message: "Database is temporarily unavailable",
        });
    }
});

// Existing database middleware
app.use(dbMiddleware);

// ===============================
// Static Uploads
// ===============================
app.use(
    "/uploads",
    express.static(path.join(__dirname, "uploads"))
);

// ===============================
// Root Route
// ===============================
app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Welcome to BGV Portal API 🚀",
    });
});

// ===============================
// Health Check
// ===============================
app.get("/api/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "BGV Portal API is running",
        environment: process.env.NODE_ENV || "production",
    });
});

// ===============================
// Routes
// ===============================
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

// ===============================
// 404 Handler
// ===============================
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route Not Found",
        path: req.originalUrl,
    });
});

// ===============================
// Error Handler
// ===============================
app.use((err, req, res, next) => {
    console.error("❌ Server Error:", err);

    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
    });
});

// ===============================
// Export Express App
// ===============================

// Vercel / serverless can import this app.
// Requests wait for the database connection above.
module.exports = app;

// ===============================
// Render / Local Development
// ===============================

if (require.main === module) {
    const PORT = process.env.PORT || 5000;

    const startServer = async () => {
        try {
            // Wait until MongoDB is connected.
            await dbReady;

            // Start server only after DB connection.
            app.listen(PORT, () => {
                console.log(`🚀 Server running on port ${PORT}`);
            });
        } catch (error) {
            console.error(
                "❌ Failed to start server:",
                error.message
            );

            process.exit(1);
        }
    };

    startServer();
}

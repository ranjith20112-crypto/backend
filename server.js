// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { connectDB } = require("./config/db");
const dbMiddleware = require("./middleware/dbMiddleware");


// Import Routes STEP 1
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

// const reportmailtemplateRoutes = require("./routes/reportmailtemplateRoutes");

const app = express();

// Connect MongoDB
connectDB();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));
app.use(dbMiddleware); // This makes req.db available to the routes
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')));

// Root Route
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Welcome to BGV Portal API 🚀",
    });
});

// Use Routes STEP 2
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

// app.use(reportmailtemplateRoutes);
// app.use(reportdeliveryRoutes);
// app.use(reportmailtemplateRoutes);


// 404 Handler - MUST BE LAST
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route Not Found",
    });
});


// API CODES



const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
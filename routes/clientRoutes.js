// Client creation and login routes


// Routes
// 1. Client creation and login both portal owner and sub-users


// routes/clientRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const multer = require("multer");

const router = express.Router();
const API_BASE = "/api";

// Multer setup for clients
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

const clientUpload = upload.fields([
  { name: "companyLogo", maxCount: 1 },
  { name: "agreementDocument", maxCount: 1 }
]);

// Helpers
const fileToDataUri = (file) => {
  if (!file) return null;
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
};

const toBool = (v) => v === true || v === "true";

// Parse the incoming "users" payload (sent as JSON string from multipart form)
const parseUsers = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

// Build the stored user objects, hashing passwords where provided.
// existingUsers (optional) is used on update to preserve passwords that
// were not changed (matched by email).
const buildUsers = async (incomingUsers, existingUsers = []) => {
  const result = [];

  for (const u of incomingUsers) {
    const user = {
      firstName: u.firstName || "",
      lastName: u.lastName || "",
      email: u.email || "",
      contactNo: u.contactNo || "",
      designation: u.designation || "",
      displayName: u.displayName || "",
      password: ""
    };

    if (u.password) {
      // a new/updated password was supplied -> hash it
      user.password = await bcrypt.hash(u.password, 10);
    } else {
      // preserve existing password (match by email) if available
      const match = existingUsers.find(
        (eu) => eu.email && u.email && eu.email === u.email
      );
      user.password = match && match.password ? match.password : "";
    }

    result.push(user);
  }

  return result;
};

// CREATE CLIENT
router.post(`${API_BASE}/client/register`, clientUpload, async (req, res) => {
  try {
    const {
      clientCode, companyName, displayName, industry, website,
      branchName, branchCode, branchDescription,
      addressLine1, addressLine2, state, city, pinCode, country,
      companyDate, category, customerSupporter, contactName,
      contactEmail, contactPhone, landline, gstin, pan,
      billingCycle, contractStartDate, contractEndDate,
      enablePortalLogin, portalEmail, portalPassword,
      assignedPackage, isActive, users
    } = req.body;

    if (!clientCode || !companyName || !customerSupporter) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (Client Code, Company Name, Customer Supporter)"
      });
    }

    const existing = await req.db.collection("client-details").findOne({ clientCode });
    if (existing) {
      return res.status(400).json({ success: false, message: "Client code already exists" });
    }

    const portalEnabled = toBool(enablePortalLogin);

    if (portalEnabled && (!portalEmail || !portalPassword)) {
      return res.status(400).json({
        success: false,
        message: "Portal Email and Password are required when portal login is enabled"
      });
    }

    let hashedPortalPassword = "";
    if (portalEnabled && portalPassword) {
      hashedPortalPassword = await bcrypt.hash(portalPassword, 10);
    }

    const logoFile = req.files?.companyLogo?.[0] || null;
    const agreementFile = req.files?.agreementDocument?.[0] || null;

    if (logoFile && logoFile.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "Logo must be under 2MB" });
    }

    // Build users (hash each user's password)
    const incomingUsers = parseUsers(users);
    const builtUsers = await buildUsers(incomingUsers);

    const client = {
      clientCode, companyName,
      displayName: displayName || "",
      industry: industry || "",
      website: website || "",
      branchName: branchName || "",
      branchCode: branchCode || "",
      branchDescription: branchDescription || "",
      addressLine1: addressLine1 || "",
      addressLine2: addressLine2 || "",
      state: state || "",
      city: city || "",
      pinCode: pinCode || "",
      country: country || "India",
      companyDate: companyDate ? new Date(companyDate) : null,
      category: category || "",
      customerSupporter,
      contactName: contactName || "",
      contactEmail: contactEmail || "",
      contactPhone: contactPhone || "",
      landline: landline || "",
      gstin: gstin || "",
      pan: pan || "",
      billingCycle: billingCycle || "Monthly",
      contractStartDate: contractStartDate ? new Date(contractStartDate) : null,
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      agreementDocument: fileToDataUri(agreementFile),
      enablePortalLogin: portalEnabled,
      portalEmail: portalEnabled ? (portalEmail || "") : "",
      portalPassword: hashedPortalPassword,
      assignedPackage: assignedPackage || "",
      companyLogo: fileToDataUri(logoFile),
      users: builtUsers,
      isActive: isActive !== undefined ? toBool(isActive) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection("client-details").insertOne(client);

    res.status(201).json({
      success: true,
      message: "Client created successfully",
      clientId: result.insertedId,
      clientCode
    });
  } catch (error) {
    console.error("Client Register Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET ALL CLIENTS
router.get(`${API_BASE}/clients`, async (req, res) => {
  try {
    const clients = await req.db.collection("client-details")
      .find({})
      .project({ portalPassword: 0, "users.password": 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, clients });
  } catch (error) {
    console.error("Get Clients Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET SINGLE CLIENT
router.get(`${API_BASE}/clients/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid client ID" });
    }

    const client = await req.db.collection("client-details")
      .findOne({ _id: new ObjectId(req.params.id) }, { projection: { portalPassword: 0, "users.password": 0 } });

    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    res.json({ success: true, client });
  } catch (error) {
    console.error("Get Client Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE CLIENT
router.put(`${API_BASE}/clients/:id`, clientUpload, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid client ID" });
    }

    const {
      clientCode, companyName, displayName, industry, website,
      branchName, branchCode, branchDescription,
      addressLine1, addressLine2, state, city, pinCode, country,
      companyDate, category, customerSupporter, contactName,
      contactEmail, contactPhone, landline, gstin, pan,
      billingCycle, contractStartDate, contractEndDate,
      enablePortalLogin, portalEmail, portalPassword,
      assignedPackage, isActive, users
    } = req.body;

    const portalEnabled = toBool(enablePortalLogin);

    // Load existing client so we can preserve unchanged user passwords
    const existingClient = await req.db.collection("client-details")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!existingClient) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const updateData = {
      clientCode, companyName,
      displayName: displayName || "",
      industry: industry || "",
      website: website || "",
      branchName: branchName || "",
      branchCode: branchCode || "",
      branchDescription: branchDescription || "",
      addressLine1: addressLine1 || "",
      addressLine2: addressLine2 || "",
      state: state || "",
      city: city || "",
      pinCode: pinCode || "",
      country: country || "India",
      companyDate: companyDate ? new Date(companyDate) : null,
      category: category || "",
      customerSupporter: customerSupporter || "",
      contactName: contactName || "",
      contactEmail: contactEmail || "",
      contactPhone: contactPhone || "",
      landline: landline || "",
      gstin: gstin || "",
      pan: pan || "",
      billingCycle: billingCycle || "Monthly",
      contractStartDate: contractStartDate ? new Date(contractStartDate) : null,
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      enablePortalLogin: portalEnabled,
      portalEmail: portalEnabled ? (portalEmail || "") : "",
      assignedPackage: assignedPackage || "",
      isActive: isActive !== undefined ? toBool(isActive) : true,
      updatedAt: new Date()
    };

    if (portalEnabled && portalPassword) {
      updateData.portalPassword = await bcrypt.hash(portalPassword, 10);
    }

    // Rebuild users, preserving unchanged passwords (matched by email)
    if (users !== undefined) {
      const incomingUsers = parseUsers(users);
      const existingUsers = Array.isArray(existingClient.users) ? existingClient.users : [];
      updateData.users = await buildUsers(incomingUsers, existingUsers);
    }

    const logoFile = req.files?.companyLogo?.[0] || null;
    const agreementFile = req.files?.agreementDocument?.[0] || null;

    if (logoFile) {
      if (logoFile.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: "Logo must be under 2MB" });
      }
      updateData.companyLogo = fileToDataUri(logoFile);
    }
    if (agreementFile) {
      updateData.agreementDocument = fileToDataUri(agreementFile);
    }

    const result = await req.db.collection("client-details").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    res.json({ success: true, message: "Client updated successfully" });
  } catch (error) {
    console.error("Update Client Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE CLIENT
router.delete(`${API_BASE}/clients/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid client ID" });
    }

    const result = await req.db.collection("client-details").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    res.json({ success: true, message: "Client deleted successfully" });
  } catch (error) {
    console.error("Delete Client Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===================================================================
// UNIFIED CLIENT LOGIN
// Handles BOTH portal-owner login (matches portalEmail) AND
// sub-user login (matches an entry in the client's users[] array).
// Email matching is case-insensitive and whitespace-trimmed.
// ===================================================================
router.post(`${API_BASE}/client/login`, async (req, res) => {
  console.log("🔥 NEW LOGIN ROUTE HIT — body:", req.body);

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    // Escape regex special characters so the email is matched literally
    const escapedEmail = cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const emailRegex = { $regex: `^${escapedEmail}$`, $options: "i" };

    // ---------------------------------------------------------------
    // 1) PORTAL-OWNER LOGIN (matches portalEmail)
    // ---------------------------------------------------------------
    const portalClient = await req.db
      .collection("client-details")
      .findOne({ portalEmail: emailRegex });

    if (portalClient && portalClient.enablePortalLogin) {
      const isPortalMatch = await bcrypt.compare(
        password,
        portalClient.portalPassword || ""
      );

      if (isPortalMatch) {
        if (portalClient.isActive === false) {
          return res.status(403).json({
            success: false,
            message: "Account is deactivated. Contact administrator."
          });
        }

        const { portalPassword, users, ...clientData } = portalClient;

        return res.json({
          success: true,
          message: "Login successful",
          loginType: "portal",
          data: {
            ...clientData,
            _id: clientData._id.toString()
          }
        });
      }
      // Portal email matched but password did not — fall through
      // to the sub-user check (covers the rare case where the same
      // address is also registered as a sub-user under this client).
    }

    // ---------------------------------------------------------------
    // 2) SUB-USER LOGIN (matches an entry in users[] array)
    // ---------------------------------------------------------------
    const client = await req.db
      .collection("client-details")
      .findOne({ "users.email": emailRegex });

    if (!client) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    if (client.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated. Contact administrator."
      });
    }

    const user = (client.users || []).find(
      (u) => (u.email || "").trim().toLowerCase() === cleanEmail
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "User account is deactivated. Contact administrator."
      });
    }

    if (!user.password) {
      return res.status(401).json({
        success: false,
        message: "No password set for this user. Contact administrator."
      });
    }

    const isUserMatch = await bcrypt.compare(password, user.password);

    if (!isUserMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const { password: _userPw, ...userData } = user;

    return res.json({
      success: true,
      message: "Login successful",
      loginType: "user",
      data: {
        clientId: client._id.toString(),
        clientCode: client.clientCode,
        companyName: client.companyName,
        displayName: client.displayName,
        branchName: client.branchName,
        branchCode: client.branchCode,
        assignedPackage: client.assignedPackage,
        isActive: client.isActive,
        user: userData
      }
    });
  } catch (error) {
    console.error("Client Login Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


module.exports = router;
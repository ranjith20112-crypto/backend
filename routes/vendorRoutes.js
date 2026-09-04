// Vendor creation, management & portal login routes

// Routes
// 1. Vendor creation and login connection with employee login


// routes/vendorRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");

const router = express.Router();
const API_BASE = "/api";
const COLLECTION = "vendor-details";

// ─── Helper: normalize rate to a "₹0.00" / "$0.00" string ──
function formatRate(rate, type) {
  if (rate === undefined || rate === null || rate === "") return "₹0.00";
  const numeric = String(rate).replace(/[₹$,\s]/g, "");
  const value = parseFloat(numeric);
  if (isNaN(value)) return "₹0.00";
  const symbol = type === "International" ? "$" : "₹";
  return symbol + value.toFixed(2);
}

// ─── Helper: build the vendor document from request body ───
// NOTE: does NOT include portalPassword (handled separately so we can hash it)
function buildVendor(body) {
  const type = body.type || "Domestic";
  const coverage =
    type === "Domestic"
      ? body.areaZone || body.coverage || ""
      : body.zipcodeCoverage || body.coverage || "";

  return {
    code: (body.code || "").trim(),
    company: body.company || "",
    type,
    areaZone: body.areaZone || "",
    pincode: body.pincode || "",
    zipcodeCoverage: body.zipcodeCoverage || "",
    coverage, // derived display value used by the table
    contact: body.contact || "",
    email: body.email || "",
    phone: body.phone || "",
    address: body.address || "",
    city: body.city || "",
    state: body.state || "",
    country: body.country || "India",
    rate: formatRate(body.rate, type),
    status: body.status || "Active",
    gstin: body.gstin || "",
    pan: body.pan || "",
    portalEnabled: !!body.portalEnabled,
    portalEmail: body.portalEnabled ? (body.portalEmail || "") : "",
    services: Array.isArray(body.services) ? body.services : [],
  };
}

// ─── Helper: strip password before sending to client ───────
function sanitize(vendor) {
  if (!vendor) return vendor;
  const { portalPassword, ...rest } = vendor;
  return { ...rest, _id: rest._id?.toString?.() ?? rest._id };
}

// ─── Create Vendor ─────────────────────────────────────────
router.post(`${API_BASE}/vendor/register`, async (req, res) => {
  try {
    const { code, company, type, pincode, zipcodeCoverage, portalEnabled, portalEmail, portalPassword } = req.body;

    // Required: code + company
    if (!code || !code.trim() || !company || !company.trim()) {
      return res.status(400).json({ success: false, message: "Vendor code and company are required" });
    }

    // Coverage requirement depends on type
    if ((type || "Domestic") === "Domestic") {
      if (!pincode || !pincode.trim()) {
        return res.status(400).json({ success: false, message: "Pincode is required for domestic vendors" });
      }
    } else {
      if (!zipcodeCoverage || !zipcodeCoverage.trim()) {
        return res.status(400).json({ success: false, message: "Zipcode coverage is required for international vendors" });
      }
    }

    // Portal validation
    if (portalEnabled) {
      if (!portalEmail || !portalEmail.trim()) {
        return res.status(400).json({ success: false, message: "Portal email is required when portal access is enabled" });
      }
      if (!portalPassword || !portalPassword.trim()) {
        return res.status(400).json({ success: false, message: "Portal password is required when portal access is enabled" });
      }
    }

    // Unique vendor code check (case-insensitive)
    const existing = await req.db.collection(COLLECTION).findOne({
      code: { $regex: `^${code.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (existing) {
      return res.status(400).json({ success: false, message: "Vendor code already exists" });
    }

    // Next numeric id
    const last = await req.db.collection(COLLECTION).find({}).sort({ id: -1 }).limit(1).toArray();
    const newId = (last[0]?.id || 0) + 1;

    const vendor = buildVendor(req.body);
    vendor.id = newId;
    vendor.createdAt = new Date();
    vendor.updatedAt = new Date();

    // Hash portal password if portal enabled
    if (vendor.portalEnabled && portalPassword) {
      vendor.portalPassword = await bcrypt.hash(portalPassword, 10);
    }

    const result = await req.db.collection(COLLECTION).insertOne(vendor);

    res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      vendorId: result.insertedId,
      vendor: sanitize({ ...vendor, _id: result.insertedId }),
    });
  } catch (error) {
    console.error("Vendor Register Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Get All Vendors ───────────────────────────────────────
router.get(`${API_BASE}/vendors`, async (req, res) => {
  try {
    const vendors = await req.db
      .collection(COLLECTION)
      .find({})
      .project({ portalPassword: 0 })
      .sort({ id: -1 })
      .toArray();

    res.json({
      success: true,
      vendors: vendors.map((v) => ({ ...v, _id: v._id.toString() })),
    });
  } catch (error) {
    console.error("Get Vendors Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Get Single Vendor ─────────────────────────────────────
router.get(`${API_BASE}/vendors/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor ID" });
    }

    const vendor = await req.db
      .collection(COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) }, { projection: { portalPassword: 0 } });

    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    res.json({ success: true, vendor: { ...vendor, _id: vendor._id.toString() } });
  } catch (error) {
    console.error("Get Vendor Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Update Vendor ─────────────────────────────────────────
router.put(`${API_BASE}/vendors/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor ID" });
    }

    const { code, portalEnabled, portalEmail, portalPassword } = req.body;

    // Unique vendor code check (excluding self)
    if (code && code.trim()) {
      const dup = await req.db.collection(COLLECTION).findOne({
        _id: { $ne: new ObjectId(req.params.id) },
        code: { $regex: `^${code.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      });
      if (dup) {
        return res.status(400).json({ success: false, message: "Vendor code already exists" });
      }
    }

    // Portal validation
    if (portalEnabled) {
      if (!portalEmail || !portalEmail.trim()) {
        return res.status(400).json({ success: false, message: "Portal email is required when portal access is enabled" });
      }
    }

    const updateDoc = buildVendor(req.body);
    updateDoc.updatedAt = new Date();

    // Handle portal password:
    //  - if portal enabled AND a new password supplied -> hash & set
    //  - if portal enabled AND no new password -> leave existing password untouched
    //  - if portal disabled -> clear stored password
    if (updateDoc.portalEnabled) {
      if (portalPassword && portalPassword.trim()) {
        updateDoc.portalPassword = await bcrypt.hash(portalPassword, 10);
      }
    } else {
      updateDoc.portalPassword = "";
    }

    const result = await req.db.collection(COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after", projection: { portalPassword: 0 } }
    );

    const updated = result.value || result;

    if (!updated) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: { ...updated, _id: updated._id.toString() },
    });
  } catch (error) {
    console.error("Update Vendor Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Delete Vendor ─────────────────────────────────────────
router.delete(`${API_BASE}/vendors/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor ID" });
    }

    const result = await req.db.collection(COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    res.json({ success: true, message: "Vendor deleted successfully" });
  } catch (error) {
    console.error("Delete Vendor Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Vendor Portal Login ───────────────────────────────────
router.post(`${API_BASE}/vendor/login`, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const vendor = await req.db.collection(COLLECTION).findOne({ portalEmail: email });

    if (!vendor || !vendor.portalEnabled || !vendor.portalPassword) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, vendor.portalPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    if (vendor.status !== "Active") {
      return res.status(403).json({ success: false, message: "Vendor account is not active. Contact administrator." });
    }

    res.json({
      success: true,
      message: "Login successful",
      data: sanitize(vendor),
    });
  } catch (error) {
    console.error("Vendor Login Error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;
// Employee + Vendor unified login routes

// Routes
// 1. Employee creation and login (BGV Users)
// 2. Check and Sub check type creation and management
// 3. Packages 
// 4. company directory creation
// 5. Court Creation
// 6. University Creation
// 7. Department and Teams

// routes/employeeRoutes.js
const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");

const router = express.Router();
const API_BASE = "/api";
const VENDOR_COLLECTION = "vendor-details";

// Register / Create Employee
router.post(`${API_BASE}/employee/register`, async (req, res) => {
  try {
    const {
      employeeCode, fullName, email, password, phone,
      userType, role, department, team, isActive
    } = req.body;

    if (!email || !password || !fullName || !employeeCode) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const existingUser = await req.db.collection("employee_login").findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Employee already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const employee = {
      employeeCode, fullName, email,
      password: hashedPassword,
      phone: phone || '',
      userType: userType || 'Verifier',
      role: role || '',
      department: department || '',
      team: team || '',
      isActive: isActive !== undefined ? isActive : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection("employee_login").insertOne(employee);

    res.status(201).json({
      success: true,
      message: "Employee created successfully",
      employeeId: result.insertedId,
      employeeCode
    });
  } catch (error) {
    console.error("Employee Register Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get All Employees
router.get(`${API_BASE}/employees`, async (req, res) => {
  try {
    const employees = await req.db.collection("employee_login")
      .find({})
      .project({ password: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, employees });
  } catch (error) {
    console.error("Get Employees Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Single Employee
router.get(`${API_BASE}/employees/:id`, async (req, res) => {
  try {
    const employee = await req.db.collection("employee_login")
      .findOne({ _id: new ObjectId(req.params.id) }, { projection: { password: 0 } });

    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, employee });
  } catch (error) {
    console.error("Get Employee Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete Employee
router.delete(`${API_BASE}/employees/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }

    const result = await req.db.collection("employee_login").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    res.json({ success: true, message: "Employee deleted successfully" });
  } catch (error) {
    console.error("Delete Employee Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update Employee
router.put(`${API_BASE}/employees/:id`, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID"
      });
    }

    const updateData = { ...req.body };

    // Don't allow updating _id
    delete updateData._id;

    // If password is empty during edit, don't overwrite existing password
    if (!updateData.password) {
      delete updateData.password;
    }

    updateData.updatedAt = new Date();

    const result = await req.db.collection("employee_login").updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updateData
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Employee not found"
      });
    }

    res.json({
      success: true,
      message: "Employee updated successfully"
    });

  } catch (error) {
    console.error("Update Employee Error:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// ─── Helper: shape a vendor record into a unified user object ─────────
// This keeps the front-end contract identical to an employee login while
// flagging the account as a vendor so the header can render accordingly.
function buildVendorUser(vendor) {
  const { portalPassword, password, ...rest } = vendor;
  return {
    ...rest,
    _id: vendor._id.toString(),
    // Unified identity fields the header/profile overlay reads:
    accountType: "Vendor",
    userType: "Vendor",
    role: "Vendor",
    fullName: vendor.company || vendor.contact || "Vendor",
    name: vendor.company || vendor.contact || "Vendor",
    displayName: vendor.company || vendor.contact || "Vendor",
    email: vendor.portalEmail || vendor.email || "",
    // Convenience flags / extras
    isVendor: true,
    vendorCode: vendor.code || "",
    company: vendor.company || "",
    contact: vendor.contact || "",
    phone: vendor.phone || "",
    status: vendor.status || "Active",
  };
}

// Employee Login (now ALSO logs in vendors via the same endpoint)
router.post(`${API_BASE}/employee/login`, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    // 1) Try Employee first
    const employee = await req.db.collection("employee_login").findOne({ email });

    if (employee) {
      const isMatch = await bcrypt.compare(password, employee.password);

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      if (employee.isActive === false) {
        return res.status(403).json({
          success: false,
          message: "Account is deactivated. Contact administrator."
        });
      }

      const { password: _, ...userData } = employee;

      return res.json({
        success: true,
        message: "Login successful",
        data: {
          ...userData,
          _id: userData._id.toString(),
          accountType: "Employee",
          isVendor: false,
        }
      });
    }

    // 2) Not an employee — try Vendor portal accounts
    //    Vendors authenticate with their portalEmail + portalPassword.
    const vendor = await req.db.collection(VENDOR_COLLECTION).findOne({ portalEmail: email });

    if (!vendor || !vendor.portalEnabled || !vendor.portalPassword) {
      // No matching employee and no usable vendor portal account
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const vendorMatch = await bcrypt.compare(password, vendor.portalPassword);

    if (!vendorMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    if (vendor.status && vendor.status !== "Active") {
      return res.status(403).json({
        success: false,
        message: "Vendor account is not active. Contact administrator."
      });
    }

    return res.json({
      success: true,
      message: "Login successful",
      data: buildVendorUser(vendor)
    });

  } catch (error) {
    console.error("Employee/Vendor Login Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});


// Check and Subcheck type API **********************************************************************************************************
const CHECKTYPE_COLLECTION = "checktype-creation";
const SUBCHECKTYPE_COLLECTION = "sub-checktype-creation";

/* ════════════════════════════════════════════════════════════════════
   CHECK TYPE ROUTES  (collection: checktype-creation)
   ════════════════════════════════════════════════════════════════════ */

// Create Check Type
router.post(`${API_BASE}/checktype/create`, async (req, res) => {
  try {
    const {
      code, name, description, sla,
      fieldVisit, digital, status, sortOrder, active
    } = req.body;

    if (!code || !name || sla === undefined || sla === null || sla === '') {
      return res.status(400).json({ success: false, message: "Missing required fields (code, name, sla)" });
    }

    // Prevent duplicate codes
    const existing = await req.db.collection(CHECKTYPE_COLLECTION).findOne({ code });
    if (existing) {
      return res.status(400).json({ success: false, message: "Check type code already exists" });
    }

    const checkType = {
      code,
      name,
      description: description || '',
      sla: Number(sla),
      fieldVisit: !!fieldVisit,
      digital: !!digital,
      status: status || (active ? 'Active' : 'Active'),
      sortOrder: sortOrder !== undefined && sortOrder !== '' ? Number(sortOrder) : 0,
      subChecks: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(CHECKTYPE_COLLECTION).insertOne(checkType);

    res.status(201).json({
      success: true,
      message: "Check type created successfully",
      checkTypeId: result.insertedId,
      checkType: { ...checkType, _id: result.insertedId.toString() }
    });
  } catch (error) {
    console.error("Create Check Type Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get All Check Types
router.get(`${API_BASE}/checktypes`, async (req, res) => {
  try {
    const checkTypes = await req.db.collection(CHECKTYPE_COLLECTION)
      .find({})
      .sort({ sortOrder: 1, createdAt: -1 })
      .toArray();

    const mapped = checkTypes.map(c => ({ ...c, _id: c._id.toString() }));

    res.json({ success: true, checkTypes: mapped });
  } catch (error) {
    console.error("Get Check Types Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Single Check Type
router.get(`${API_BASE}/checktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid check type ID" });
    }

    const checkType = await req.db.collection(CHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!checkType) {
      return res.status(404).json({ success: false, message: "Check type not found" });
    }

    res.json({ success: true, checkType: { ...checkType, _id: checkType._id.toString() } });
  } catch (error) {
    console.error("Get Check Type Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update Check Type
router.put(`${API_BASE}/checktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid check type ID" });
    }

    const {
      name, description, sla,
      fieldVisit, digital, status, sortOrder, active, subChecks
    } = req.body;

    const updateDoc = { updatedAt: new Date() };

    if (name !== undefined) updateDoc.name = name;
    if (description !== undefined) updateDoc.description = description;
    if (sla !== undefined && sla !== '') updateDoc.sla = Number(sla);
    if (fieldVisit !== undefined) updateDoc.fieldVisit = !!fieldVisit;
    if (digital !== undefined) updateDoc.digital = !!digital;
    if (status !== undefined) updateDoc.status = status;
    if (sortOrder !== undefined && sortOrder !== '') updateDoc.sortOrder = Number(sortOrder);
    if (active !== undefined) updateDoc.status = active ? 'Active' : 'Inactive';
    if (Array.isArray(subChecks)) updateDoc.subChecks = subChecks;

    const result = await req.db.collection(CHECKTYPE_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const updated = result.value || result; // driver version compatibility

    if (!updated) {
      return res.status(404).json({ success: false, message: "Check type not found" });
    }

    res.json({
      success: true,
      message: "Check type updated successfully",
      checkType: { ...updated, _id: updated._id.toString() }
    });
  } catch (error) {
    console.error("Update Check Type Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete Check Type
router.delete(`${API_BASE}/checktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid check type ID" });
    }

    const result = await req.db.collection(CHECKTYPE_COLLECTION).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Check type not found" });
    }

    // Also remove any sub-checks belonging to this parent
    await req.db.collection(SUBCHECKTYPE_COLLECTION).deleteMany({
      parentCheckId: req.params.id
    });

    res.json({ success: true, message: "Check type deleted successfully" });
  } catch (error) {
    console.error("Delete Check Type Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ════════════════════════════════════════════════════════════════════
   SUB CHECK TYPE ROUTES  (collection: sub-checktype-creation)
   ════════════════════════════════════════════════════════════════════ */

// Create Sub Check Type
router.post(`${API_BASE}/subchecktype/create`, async (req, res) => {
  try {
    const {
      code, name, parentCheck, dataInputMode, sla, priority
    } = req.body;

    if (!parentCheck || !name || sla === undefined || sla === null || sla === '') {
      return res.status(400).json({ success: false, message: "Missing required fields (parentCheck, name, sla)" });
    }

    if (!ObjectId.isValid(parentCheck)) {
      return res.status(400).json({ success: false, message: "Invalid parent check ID" });
    }

    const parent = await req.db.collection(CHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(parentCheck) });

    if (!parent) {
      return res.status(404).json({ success: false, message: "Parent check type not found" });
    }

    // Auto-generate a code if none supplied
    const existingSubCount = parent.subChecks ? parent.subChecks.length : 0;
    const generatedCode = code && code.trim()
      ? code.trim()
      : `${parent.code.split('-')[0] || 'SUB'}-SUB${String(existingSubCount + 1).padStart(2, '0')}`;

    const subCheck = {
      code: generatedCode,
      name,
      parentCheckId: parentCheck,
      parentCheckCode: parent.code,
      parentCheckName: parent.name,
      dataInputMode: dataInputMode || 'provided',
      sla: Number(sla),
      priority: priority || 'normal',
      fieldVisit: false,
      digital: true,
      status: 'Active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(SUBCHECKTYPE_COLLECTION).insertOne(subCheck);

    // Push the sub-check name into the parent's subChecks array
    await req.db.collection(CHECKTYPE_COLLECTION).updateOne(
      { _id: new ObjectId(parentCheck) },
      { $push: { subChecks: name.trim() }, $set: { updatedAt: new Date() } }
    );

    res.status(201).json({
      success: true,
      message: "Sub check created successfully",
      subCheckId: result.insertedId,
      subCheck: { ...subCheck, _id: result.insertedId.toString() }
    });
  } catch (error) {
    console.error("Create Sub Check Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get All Sub Check Types
router.get(`${API_BASE}/subchecktypes`, async (req, res) => {
  try {
    const filter = {};
    if (req.query.parentCheckId && ObjectId.isValid(req.query.parentCheckId)) {
      filter.parentCheckId = req.query.parentCheckId;
    }

    const subChecks = await req.db.collection(SUBCHECKTYPE_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    const mapped = subChecks.map(s => ({ ...s, _id: s._id.toString() }));

    res.json({ success: true, subChecks: mapped });
  } catch (error) {
    console.error("Get Sub Checks Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Single Sub Check Type
router.get(`${API_BASE}/subchecktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid sub check ID" });
    }

    const subCheck = await req.db.collection(SUBCHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!subCheck) {
      return res.status(404).json({ success: false, message: "Sub check not found" });
    }

    res.json({ success: true, subCheck: { ...subCheck, _id: subCheck._id.toString() } });
  } catch (error) {
    console.error("Get Sub Check Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update Sub Check Type
router.put(`${API_BASE}/subchecktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid sub check ID" });
    }

    const { code, name, dataInputMode, sla, priority, status } = req.body;

    const updateDoc = { updatedAt: new Date() };
    if (code !== undefined) updateDoc.code = code;
    if (name !== undefined) updateDoc.name = name;
    if (dataInputMode !== undefined) updateDoc.dataInputMode = dataInputMode;
    if (sla !== undefined && sla !== '') updateDoc.sla = Number(sla);
    if (priority !== undefined) updateDoc.priority = priority;
    if (status !== undefined) updateDoc.status = status;

    const result = await req.db.collection(SUBCHECKTYPE_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const updated = result.value || result;

    if (!updated) {
      return res.status(404).json({ success: false, message: "Sub check not found" });
    }

    res.json({
      success: true,
      message: "Sub check updated successfully",
      subCheck: { ...updated, _id: updated._id.toString() }
    });
  } catch (error) {
    console.error("Update Sub Check Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete Sub Check Type
router.delete(`${API_BASE}/subchecktypes/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid sub check ID" });
    }

    const subCheck = await req.db.collection(SUBCHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!subCheck) {
      return res.status(404).json({ success: false, message: "Sub check not found" });
    }

    await req.db.collection(SUBCHECKTYPE_COLLECTION).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    // Pull the name out of the parent's subChecks array
    if (subCheck.parentCheckId && ObjectId.isValid(subCheck.parentCheckId)) {
      await req.db.collection(CHECKTYPE_COLLECTION).updateOne(
        { _id: new ObjectId(subCheck.parentCheckId) },
        { $pull: { subChecks: subCheck.name }, $set: { updatedAt: new Date() } }
      );
    }

    res.json({ success: true, message: "Sub check deleted successfully" });
  } catch (error) {
    console.error("Delete Sub Check Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Packeage creation and management ***********************************************************************************************
const PACKAGE_COLLECTION = "package-creation";
// Create Package
/* ════════════════════════════════════════════════════════════════════
   PACKAGE ROUTES  (collection: package-creation)
   ════════════════════════════════════════════════════════════════════ */

// ─── Helper: normalize check components ───────────────────────────────
function normalizeComponents(checkComponents) {
  return (checkComponents || []).map(c => ({
    checkType: c.checkType || '',
    checkTypeName: c.checkTypeName || '',
    subType: c.subType || '',
    subTypeName: c.subTypeName || '',
    qty: c.qty ? Number(c.qty) : 1,
    slaDays: c.slaDays !== undefined && c.slaDays !== '' ? Number(c.slaDays) : null
  }));
}

// ─── Helper: shape a package for the client ───────────────────────────
function shapePackage(pkg) {
  // Ensure both `status` and `active` are always present and in sync
  const status = pkg.status || (pkg.active === false ? 'Inactive' : 'Active');
  return {
    ...pkg,
    _id: pkg._id.toString(),
    status,
    active: status === 'Active'
  };
}

// Create Package
router.post(`${API_BASE}/package/create`, async (req, res) => {
  try {
    const { code, name, description, active, isGlobal, checkComponents } = req.body;

    if (!code || !name) {
      return res.status(400).json({ success: false, message: "Missing required fields (code, name)" });
    }

    if (!Array.isArray(checkComponents) || checkComponents.length === 0) {
      return res.status(400).json({ success: false, message: "At least one check component is required" });
    }

    // Prevent duplicate codes
    const existing = await req.db.collection(PACKAGE_COLLECTION).findOne({ code });
    if (existing) {
      return res.status(400).json({ success: false, message: "Package code already exists" });
    }

    const normalizedComponents = normalizeComponents(checkComponents);
    const isActive = active !== undefined ? !!active : true;

    const pkg = {
      code,
      name,
      description: description || '',
      status: isActive ? 'Active' : 'Inactive',  // ← driven by the checkbox
      active: isActive,                           // ← stored explicitly too
      isGlobal: !!isGlobal,
      checkComponents: normalizedComponents,
      checks: normalizedComponents.map(c => c.checkType),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(PACKAGE_COLLECTION).insertOne(pkg);

    res.status(201).json({
      success: true,
      message: "Package created successfully",
      packageId: result.insertedId,
      package: shapePackage({ ...pkg, _id: result.insertedId })
    });
  } catch (error) {
    console.error("Create Package Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get All Packages
router.get(`${API_BASE}/packages`, async (req, res) => {
  try {
    const filter = {};
    // Optional status filter via query (?status=active / inactive)
    if (req.query.status === 'active') filter.status = 'Active';
    if (req.query.status === 'inactive') filter.status = 'Inactive';

    const packages = await req.db.collection(PACKAGE_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    const mapped = packages.map(shapePackage);

    res.json({ success: true, packages: mapped });
  } catch (error) {
    console.error("Get Packages Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Single Package
router.get(`${API_BASE}/packages/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid package ID" });
    }

    const pkg = await req.db.collection(PACKAGE_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!pkg) {
      return res.status(404).json({ success: false, message: "Package not found" });
    }

    res.json({ success: true, package: shapePackage(pkg) });
  } catch (error) {
    console.error("Get Package Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update Package
router.put(`${API_BASE}/packages/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid package ID" });
    }

    const { name, description, active, isGlobal, checkComponents } = req.body;

    const updateDoc = { updatedAt: new Date() };

    if (name !== undefined) updateDoc.name = name;
    if (description !== undefined) updateDoc.description = description;
    if (isGlobal !== undefined) updateDoc.isGlobal = !!isGlobal;

    // Keep status + active in sync from the checkbox
    if (active !== undefined) {
      updateDoc.status = active ? 'Active' : 'Inactive';
      updateDoc.active = !!active;
    }

    if (Array.isArray(checkComponents)) {
      const normalizedComponents = normalizeComponents(checkComponents);
      updateDoc.checkComponents = normalizedComponents;
      updateDoc.checks = normalizedComponents.map(c => c.checkType);
    }

    const result = await req.db.collection(PACKAGE_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const updated = result.value || result; // driver version compatibility

    if (!updated) {
      return res.status(404).json({ success: false, message: "Package not found" });
    }

    res.json({
      success: true,
      message: "Package updated successfully",
      package: shapePackage(updated)
    });
  } catch (error) {
    console.error("Update Package Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Toggle Package Status (Active <-> Inactive)
router.patch(`${API_BASE}/packages/:id/status`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid package ID" });
    }

    const { active } = req.body;

    if (active === undefined) {
      return res.status(400).json({ success: false, message: "Missing 'active' field" });
    }

    const result = await req.db.collection(PACKAGE_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: active ? 'Active' : 'Inactive', active: !!active, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    const updated = result.value || result;

    if (!updated) {
      return res.status(404).json({ success: false, message: "Package not found" });
    }

    res.json({
      success: true,
      message: `Package marked as ${active ? 'Active' : 'Inactive'}`,
      package: shapePackage(updated)
    });
  } catch (error) {
    console.error("Toggle Package Status Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete Package
router.delete(`${API_BASE}/packages/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid package ID" });
    }

    const result = await req.db.collection(PACKAGE_COLLECTION).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Package not found" });
    }

    res.json({ success: true, message: "Package deleted successfully" });
  } catch (error) {
    console.error("Delete Package Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});



// Company directory api ***********************************************************************************************************
const COLLECTION_NAME = "company-directory";
// ====================== HELPERS ======================

// Shape company data for consistent client response
function shapeCompany(company) {
  if (!company) return null;

  return {
    ...company,
    _id: company._id.toString(),
    isActive: company.isActive !== undefined ? Boolean(company.isActive) : true,
    avgDays: company.avgDays ? Number(company.avgDays) : null,
    createdAt: company.createdAt || new Date(),
    updatedAt: company.updatedAt || new Date(),
  };
}

// ====================== ROUTES ======================

// ─── CREATE Company ─────────────────────────────────────
router.post(`${API_BASE}/company-directory`, async (req, res) => {
  try {
    const {
      companyName,
      category,
      alsoKnownAs,
      industry,
      website,
      hrEmail,
      hrPhone,
      method,
      avgDays,
      notes,
      isActive
    } = req.body;

    if (!companyName) {
      return res.status(400).json({
        success: false,
        message: "Company name is required"
      });
    }

    // Check for duplicate company name
    const existing = await req.db.collection(COLLECTION_NAME).findOne({
      companyName: { $regex: new RegExp(`^${companyName}$`, 'i') }
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "Company with this name already exists"
      });
    }

    const newCompany = {
      companyName: companyName.trim(),
      category: category || '',
      alsoKnownAs: alsoKnownAs || '',
      industry: industry || '',
      website: website || '',
      hrEmail: hrEmail || '',
      hrPhone: hrPhone || '',
      method: method || 'Email',
      avgDays: avgDays ? Number(avgDays) : null,
      notes: notes || '',
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(COLLECTION_NAME).insertOne(newCompany);

    res.status(201).json({
      success: true,
      message: "Company created successfully",
      companyId: result.insertedId,
      company: shapeCompany({ ...newCompany, _id: result.insertedId })
    });

  } catch (error) {
    console.error("Create Company Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create company"
    });
  }
});

// ─── GET ALL Companies ──────────────────────────────────
router.get(`${API_BASE}/company-directory`, async (req, res) => {
  try {
    const { status } = req.query;

    const filter = {};
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;

    const companies = await req.db.collection(COLLECTION_NAME)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    const mapped = companies.map(shapeCompany);

    res.json({
      success: true,
      companies: mapped,
      count: mapped.length
    });
  } catch (error) {
    console.error("Get Companies Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch companies"
    });
  }
});

// ─── GET SINGLE Company ─────────────────────────────────
router.get(`${API_BASE}/company-directory/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID"
      });
    }

    const company = await req.db.collection(COLLECTION_NAME).findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found"
      });
    }

    res.json({
      success: true,
      company: shapeCompany(company)
    });
  } catch (error) {
    console.error("Get Company Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch company"
    });
  }
});

// ─── UPDATE Company ─────────────────────────────────────
// Update Company
router.put(`${API_BASE}/company-directory/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid company ID" });
    }

    const {
      companyName, category, alsoKnownAs, industry, website,
      hrEmail, hrPhone, method, avgDays, notes, isActive
    } = req.body;

    const updateDoc = { updatedAt: new Date() };

    if (companyName !== undefined) updateDoc.companyName = companyName.trim();
    if (category !== undefined) updateDoc.category = category;
    if (alsoKnownAs !== undefined) updateDoc.alsoKnownAs = alsoKnownAs;
    if (industry !== undefined) updateDoc.industry = industry;
    if (website !== undefined) updateDoc.website = website;
    if (hrEmail !== undefined) updateDoc.hrEmail = hrEmail;
    if (hrPhone !== undefined) updateDoc.hrPhone = hrPhone;
    if (method !== undefined) updateDoc.method = method;
    if (avgDays !== undefined) updateDoc.avgDays = avgDays ? Number(avgDays) : null;
    if (notes !== undefined) updateDoc.notes = notes;
    if (isActive !== undefined) updateDoc.isActive = Boolean(isActive);

    const result = await req.db.collection(COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    // MongoDB driver v6+ returns the document directly; v4/v5 wrap it in `.value`
    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    res.json({
      success: true,
      message: "Company updated successfully",
      company: shapeCompany(updated)
    });
  } catch (error) {
    console.error("Update Company Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update company" });
  }
});

// Toggle Active Status
router.patch(`${API_BASE}/company-directory/:id/status`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid company ID" });
    }

    const { isActive } = req.body;

    if (isActive === undefined) {
      return res.status(400).json({ success: false, message: "isActive field is required" });
    }

    const result = await req.db.collection(COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { isActive: Boolean(isActive), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Company not found" });
    }

    res.json({
      success: true,
      message: `Company marked as ${Boolean(isActive) ? 'Active' : 'Inactive'}`,
      company: shapeCompany(updated)
    });
  } catch (error) {
    console.error("Toggle Status Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update status" });
  }
});

// ─── DELETE Company ─────────────────────────────────────
router.delete(`${API_BASE}/company-directory/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid company ID"
      });
    }

    const result = await req.db.collection(COLLECTION_NAME).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Company not found"
      });
    }

    res.json({
      success: true,
      message: "Company deleted successfully"
    });

  } catch (error) {
    console.error("Delete Company Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete company"
    });
  }
});



// Court creation API's *************************************************************************************************************
const COURT_COLLECTION_NAME = "court-directory-creation";

/* ════════════════════════════════════════════════════════════════════
   COURT DIRECTORY ROUTES  (collection: court-directory-creation)
   ════════════════════════════════════════════════════════════════════ */

// ─── Helper: shape a court record for consistent client response ──────
function shapeCourt(court) {
  if (!court) return null;

  return {
    ...court,
    _id: court._id.toString(),
    isActive: court.isActive !== undefined ? Boolean(court.isActive) : true,
    isOnline: !!(court.portalUrl && court.portalUrl.trim()),
    createdAt: court.createdAt || new Date(),
    updatedAt: court.updatedAt || new Date(),
  };
}

// Create Court
router.post(`${API_BASE}/courts`, async (req, res) => {
  try {
    const {
      courtName, type, jurisdiction, ecourtCode,
      portalUrl, address, isActive
    } = req.body;

    if (!courtName || !courtName.trim()) {
      return res.status(400).json({ success: false, message: "Court name is required" });
    }

    if (!type || !type.trim()) {
      return res.status(400).json({ success: false, message: "Court type is required" });
    }

    const court = {
      courtName: courtName.trim(),
      type: type.trim(),
      jurisdiction: jurisdiction || '',
      ecourtCode: ecourtCode || '',
      portalUrl: portalUrl || '',
      address: address || '',
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(COURT_COLLECTION_NAME).insertOne(court);

    res.status(201).json({
      success: true,
      message: "Court created successfully",
      courtId: result.insertedId,
      court: shapeCourt({ ...court, _id: result.insertedId })
    });
  } catch (error) {
    console.error("Create Court Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to create court" });
  }
});

// Get All Courts
router.get(`${API_BASE}/courts`, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    if (req.query.type) filter.type = req.query.type;

    const courts = await req.db.collection(COURT_COLLECTION_NAME)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, courts: courts.map(shapeCourt) });
  } catch (error) {
    console.error("Get Courts Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch courts" });
  }
});

// Get Single Court
router.get(`${API_BASE}/courts/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid court ID" });
    }

    const court = await req.db.collection(COURT_COLLECTION_NAME)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!court) {
      return res.status(404).json({ success: false, message: "Court not found" });
    }

    res.json({ success: true, court: shapeCourt(court) });
  } catch (error) {
    console.error("Get Court Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch court" });
  }
});

// Update Court
router.put(`${API_BASE}/courts/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid court ID" });
    }

    const {
      courtName, type, jurisdiction, ecourtCode,
      portalUrl, address, isActive
    } = req.body;

    const updateDoc = { updatedAt: new Date() };

    if (courtName !== undefined) updateDoc.courtName = courtName.trim();
    if (type !== undefined) updateDoc.type = type;
    if (jurisdiction !== undefined) updateDoc.jurisdiction = jurisdiction;
    if (ecourtCode !== undefined) updateDoc.ecourtCode = ecourtCode;
    if (portalUrl !== undefined) updateDoc.portalUrl = portalUrl;
    if (address !== undefined) updateDoc.address = address;
    if (isActive !== undefined) updateDoc.isActive = Boolean(isActive);

    const result = await req.db.collection(COURT_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    // MongoDB driver v6+ returns the document directly; v4/v5 wrap it in `.value`
    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Court not found" });
    }

    res.json({
      success: true,
      message: "Court updated successfully",
      court: shapeCourt(updated)
    });
  } catch (error) {
    console.error("Update Court Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update court" });
  }
});

// Toggle Active Status
router.patch(`${API_BASE}/courts/:id/status`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid court ID" });
    }

    const { isActive } = req.body;

    if (isActive === undefined) {
      return res.status(400).json({ success: false, message: "isActive field is required" });
    }

    const result = await req.db.collection(COURT_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { isActive: Boolean(isActive), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Court not found" });
    }

    res.json({
      success: true,
      message: `Court marked as ${Boolean(isActive) ? 'Active' : 'Inactive'}`,
      court: shapeCourt(updated)
    });
  } catch (error) {
    console.error("Toggle Status Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update status" });
  }
});

// Delete Court
router.delete(`${API_BASE}/courts/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid court ID" });
    }

    const result = await req.db.collection(COURT_COLLECTION_NAME).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Court not found" });
    }

    res.json({ success: true, message: "Court deleted successfully" });
  } catch (error) {
    console.error("Delete Court Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to delete court" });
  }
});



// University creation API's *************************************************************************************************************
const UNIVERSITY_COLLECTION_NAME = "university-directory-creation";

/* ════════════════════════════════════════════════════════════════════
   UNIVERSITY DIRECTORY ROUTES  (collection: university-directory-creation)
   ════════════════════════════════════════════════════════════════════ */

// ─── Helper: shape a university record for consistent client response ──
function shapeUniversity(uni) {
  if (!uni) return null;

  return {
    ...uni,
    _id: uni._id.toString(),
    isActive: uni.isActive !== undefined ? Boolean(uni.isActive) : true,
    avgDays: uni.avgDays ? Number(uni.avgDays) : null,
    cost: uni.cost ? Number(uni.cost) : null,
    createdAt: uni.createdAt || new Date(),
    updatedAt: uni.updatedAt || new Date(),
  };
}

// Create University
router.post(`${API_BASE}/universities`, async (req, res) => {
  try {
    const {
      universityName, type, website, verificationEmail, verificationPhone,
      method, avgDays, cost, contactPerson, contactPhone, designation,
      notes, isActive
    } = req.body;

    if (!universityName || !universityName.trim()) {
      return res.status(400).json({ success: false, message: "University name is required" });
    }

    if (!type || !type.trim()) {
      return res.status(400).json({ success: false, message: "University type is required" });
    }

    const university = {
      universityName: universityName.trim(),
      type: type.trim(),
      website: website || '',
      verificationEmail: verificationEmail || '',
      verificationPhone: verificationPhone || '',
      method: method || '',
      avgDays: avgDays ? Number(avgDays) : null,
      cost: cost ? Number(cost) : null,
      contactPerson: contactPerson || '',
      contactPhone: contactPhone || '',
      designation: designation || '',
      notes: notes || '',
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(UNIVERSITY_COLLECTION_NAME).insertOne(university);

    res.status(201).json({
      success: true,
      message: "University created successfully",
      universityId: result.insertedId,
      university: shapeUniversity({ ...university, _id: result.insertedId })
    });
  } catch (error) {
    console.error("Create University Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to create university" });
  }
});

// Get All Universities
router.get(`${API_BASE}/universities`, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    if (req.query.type) filter.type = req.query.type;

    const universities = await req.db.collection(UNIVERSITY_COLLECTION_NAME)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, universities: universities.map(shapeUniversity) });
  } catch (error) {
    console.error("Get Universities Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch universities" });
  }
});

// Get Single University
router.get(`${API_BASE}/universities/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university ID" });
    }

    const university = await req.db.collection(UNIVERSITY_COLLECTION_NAME)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!university) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    res.json({ success: true, university: shapeUniversity(university) });
  } catch (error) {
    console.error("Get University Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch university" });
  }
});

// Update University
router.put(`${API_BASE}/universities/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university ID" });
    }

    const {
      universityName, type, website, verificationEmail, verificationPhone,
      method, avgDays, cost, contactPerson, contactPhone, designation,
      notes, isActive
    } = req.body;

    const updateDoc = { updatedAt: new Date() };

    if (universityName !== undefined) updateDoc.universityName = universityName.trim();
    if (type !== undefined) updateDoc.type = type;
    if (website !== undefined) updateDoc.website = website;
    if (verificationEmail !== undefined) updateDoc.verificationEmail = verificationEmail;
    if (verificationPhone !== undefined) updateDoc.verificationPhone = verificationPhone;
    if (method !== undefined) updateDoc.method = method;
    if (avgDays !== undefined) updateDoc.avgDays = avgDays ? Number(avgDays) : null;
    if (cost !== undefined) updateDoc.cost = cost ? Number(cost) : null;
    if (contactPerson !== undefined) updateDoc.contactPerson = contactPerson;
    if (contactPhone !== undefined) updateDoc.contactPhone = contactPhone;
    if (designation !== undefined) updateDoc.designation = designation;
    if (notes !== undefined) updateDoc.notes = notes;
    if (isActive !== undefined) updateDoc.isActive = Boolean(isActive);

    const result = await req.db.collection(UNIVERSITY_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    // MongoDB driver v6+ returns the document directly; v4/v5 wrap it in `.value`
    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    res.json({
      success: true,
      message: "University updated successfully",
      university: shapeUniversity(updated)
    });
  } catch (error) {
    console.error("Update University Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update university" });
  }
});

// Toggle Active Status
router.patch(`${API_BASE}/universities/:id/status`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university ID" });
    }

    const { isActive } = req.body;

    if (isActive === undefined) {
      return res.status(400).json({ success: false, message: "isActive field is required" });
    }

    const result = await req.db.collection(UNIVERSITY_COLLECTION_NAME).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { isActive: Boolean(isActive), updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    res.json({
      success: true,
      message: `University marked as ${Boolean(isActive) ? 'Active' : 'Inactive'}`,
      university: shapeUniversity(updated)
    });
  } catch (error) {
    console.error("Toggle Status Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update status" });
  }
});

// Delete University
router.delete(`${API_BASE}/universities/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid university ID" });
    }

    const result = await req.db.collection(UNIVERSITY_COLLECTION_NAME).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "University not found" });
    }

    res.json({ success: true, message: "University deleted successfully" });
  } catch (error) {
    console.error("Delete University Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to delete university" });
  }
});


// Department and Team creation API's *************************************************************************************************************
const DEPARTMENT_COLLECTION = "department_collection_name";
const TEAMS_COLLECTION = "Teams_collection_name";
const EMPLOYEE_COLLECTION = "employee_login";


/* ════════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════════ */
function shapeDepartment(dept) {
  if (!dept) return null;
  return {
    ...dept,
    _id: dept._id.toString(),
    active: dept.active !== undefined ? Boolean(dept.active) : true,
    createdAt: dept.createdAt || new Date(),
    updatedAt: dept.updatedAt || new Date(),
  };
}

function shapeTeam(team) {
  if (!team) return null;
  return {
    ...team,
    _id: team._id.toString(),
    departmentId: team.departmentId ? team.departmentId.toString() : '',
    active: team.active !== undefined ? Boolean(team.active) : true,
    memberCount: team.memberCount ? Number(team.memberCount) : 0,
    lead: team.lead || '',
    createdAt: team.createdAt || new Date(),
    updatedAt: team.updatedAt || new Date(),
  };
}

/* ════════════════════════════════════════════════════════════════════
   DEPARTMENT ROUTES  (collection: department_collection_name)
   ════════════════════════════════════════════════════════════════════ */

// Create Department
router.post(`${API_BASE}/departments`, async (req, res) => {
  try {
    const { name, active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Department name is required" });
    }

    const existing = await req.db.collection(DEPARTMENT_COLLECTION)
      .findOne({ name: name.trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: "Department name already exists" });
    }

    const department = {
      name: name.trim(),
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(DEPARTMENT_COLLECTION).insertOne(department);

    res.status(201).json({
      success: true,
      message: "Department created successfully",
      departmentId: result.insertedId,
      department: shapeDepartment({ ...department, _id: result.insertedId })
    });
  } catch (error) {
    console.error("Create Department Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to create department" });
  }
});

// Get All Departments (with team + user counts)
router.get(`${API_BASE}/departments`, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status === 'active') filter.active = true;
    if (req.query.status === 'inactive') filter.active = false;

    const departments = await req.db.collection(DEPARTMENT_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    // Attach team + user counts for each department
    const shaped = await Promise.all(departments.map(async (dept) => {
      const deptIdStr = dept._id.toString();

      const teamCount = await req.db.collection(TEAMS_COLLECTION)
        .countDocuments({ departmentId: deptIdStr });

      const userCount = await req.db.collection(EMPLOYEE_COLLECTION)
        .countDocuments({ department: dept.name });

      return { ...shapeDepartment(dept), teamCount, userCount };
    }));

    res.json({ success: true, departments: shaped });
  } catch (error) {
    console.error("Get Departments Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch departments" });
  }
});

// Get Single Department
router.get(`${API_BASE}/departments/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }

    const department = await req.db.collection(DEPARTMENT_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!department) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    res.json({ success: true, department: shapeDepartment(department) });
  } catch (error) {
    console.error("Get Department Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch department" });
  }
});

// Update Department
router.put(`${API_BASE}/departments/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }

    const { name, active } = req.body;

    const updateDoc = { updatedAt: new Date() };
    if (name !== undefined) updateDoc.name = name.trim();
    if (active !== undefined) updateDoc.active = Boolean(active);

    const result = await req.db.collection(DEPARTMENT_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    res.json({
      success: true,
      message: "Department updated successfully",
      department: shapeDepartment(updated)
    });
  } catch (error) {
    console.error("Update Department Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update department" });
  }
});

// Delete Department (also removes its teams)
router.delete(`${API_BASE}/departments/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }

    const result = await req.db.collection(DEPARTMENT_COLLECTION).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    await req.db.collection(TEAMS_COLLECTION).deleteMany({ departmentId: req.params.id });

    res.json({ success: true, message: "Department deleted successfully" });
  } catch (error) {
    console.error("Delete Department Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to delete department" });
  }
});

// Get Users for a Department (from employee_login by department name)
router.get(`${API_BASE}/departments/:id/users`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid department ID" });
    }

    const department = await req.db.collection(DEPARTMENT_COLLECTION)
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!department) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }

    const employees = await req.db.collection(EMPLOYEE_COLLECTION)
      .find({ department: department.name })
      .project({ password: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    const users = employees.map(e => ({
      id: e._id.toString(),
      _id: e._id.toString(),
      name: e.fullName || '',
      email: e.email || '',
      phone: e.phone || '',
      role: e.role || e.userType || '',
      status: e.isActive === false ? 'inactive' : 'active',
      joinedAt: e.createdAt ? new Date(e.createdAt).toISOString().split('T')[0] : '',
      location: e.team || '',
    }));

    res.json({ success: true, users });
  } catch (error) {
    console.error("Get Department Users Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch users" });
  }
});

/* ════════════════════════════════════════════════════════════════════
   TEAM ROUTES  (collection: Teams_collection_name)
   ════════════════════════════════════════════════════════════════════ */

// Create Team
router.post(`${API_BASE}/teams`, async (req, res) => {
  try {
    const { name, departmentId, lead, memberCount, active } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Team name is required" });
    }

    if (!departmentId || !ObjectId.isValid(departmentId)) {
      return res.status(400).json({ success: false, message: "A valid department is required" });
    }

    const parent = await req.db.collection(DEPARTMENT_COLLECTION)
      .findOne({ _id: new ObjectId(departmentId) });

    if (!parent) {
      return res.status(404).json({ success: false, message: "Parent department not found" });
    }

    const team = {
      name: name.trim(),
      departmentId: departmentId,
      departmentName: parent.name,
      lead: lead || '',
      memberCount: memberCount ? Number(memberCount) : 0,
      active: active !== undefined ? Boolean(active) : true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await req.db.collection(TEAMS_COLLECTION).insertOne(team);

    res.status(201).json({
      success: true,
      message: "Team created successfully",
      teamId: result.insertedId,
      team: shapeTeam({ ...team, _id: result.insertedId })
    });
  } catch (error) {
    console.error("Create Team Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to create team" });
  }
});

// Get All Teams (optionally by department)
router.get(`${API_BASE}/teams`, async (req, res) => {
  try {
    const filter = {};
    if (req.query.departmentId && ObjectId.isValid(req.query.departmentId)) {
      filter.departmentId = req.query.departmentId;
    }
    if (req.query.status === 'active') filter.active = true;
    if (req.query.status === 'inactive') filter.active = false;

    const teams = await req.db.collection(TEAMS_COLLECTION)
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, teams: teams.map(shapeTeam) });
  } catch (error) {
    console.error("Get Teams Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch teams" });
  }
});

// Update Team
router.put(`${API_BASE}/teams/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid team ID" });
    }

    const { name, departmentId, lead, memberCount, active } = req.body;

    const updateDoc = { updatedAt: new Date() };
    if (name !== undefined) updateDoc.name = name.trim();
    if (lead !== undefined) updateDoc.lead = lead;
    if (memberCount !== undefined) updateDoc.memberCount = Number(memberCount) || 0;
    if (active !== undefined) updateDoc.active = Boolean(active);

    if (departmentId !== undefined && ObjectId.isValid(departmentId)) {
      const parent = await req.db.collection(DEPARTMENT_COLLECTION)
        .findOne({ _id: new ObjectId(departmentId) });
      if (parent) {
        updateDoc.departmentId = departmentId;
        updateDoc.departmentName = parent.name;
      }
    }

    const result = await req.db.collection(TEAMS_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const updated = result?.value || result;

    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    res.json({
      success: true,
      message: "Team updated successfully",
      team: shapeTeam(updated)
    });
  } catch (error) {
    console.error("Update Team Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to update team" });
  }
});

// Delete Team
router.delete(`${API_BASE}/teams/:id`, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid team ID" });
    }

    const result = await req.db.collection(TEAMS_COLLECTION).deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    res.json({ success: true, message: "Team deleted successfully" });
  } catch (error) {
    console.error("Delete Team Error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to delete team" });
  }
});



module.exports = router;

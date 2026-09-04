const express = require("express");
const { ObjectId } = require("mongodb");
const router = express.Router();

const API_BASE = "/api/useraccess";
const VENDOR_COLLECTION = "vendors"; // adjust if your vendor collection is named differently
const EMPLOYEE_COLLECTION = "employee_login";
const MODULES_COLLECTION = "app_modules"; // owned/synced by moduleRoutes.js
const ROLES_COLLECTION = "access_roles";

const ACTIONS = ["view", "create", "edit", "delete", "approve", "export"];

function emptyActionSet() {
    return { view: false, create: false, edit: false, delete: false, approve: false, export: false };
}

function fullActionSet() {
    return { view: true, create: true, edit: true, delete: true, approve: true, export: true };
}

function sanitizePermissionRows(rows = []) {
    return rows
        .filter((r) => r && r.moduleKey)
        .map((r) => {
            const row = { moduleKey: r.moduleKey, ...emptyActionSet() };
            for (const a of ACTIONS) row[a] = Boolean(r[a]);
            return row;
        });
}

// Live list of currently-registered modules (synced from appRoutes.js via moduleRoutes.js)
async function getActiveModules(db) {
    return db.collection(MODULES_COLLECTION).find({ isActive: true }).sort({ moduleGroup: 1, moduleName: 1 }).toArray();
}

/**
 * ─── Auto-discover roles from existing employee data ───────────
 * You already have a "role" text field on employee_login (e.g.
 * "Super Administrator", "Team Lead", "User") set from another
 * screen. Rather than duplicating that as a separate manual role
 * list, every distinct value found there is auto-registered here
 * as an assignable access role (with an empty permission matrix
 * the first time it's seen — Admin gets configured once via the
 * Role editor, then it sticks).
 *
 * Runs on every GET /roles call, so a brand-new role value typed
 * into the employee screen shows up here without any extra step.
 */
async function syncRolesFromEmployeeData(db) {
    const distinctRoles = await db.collection(EMPLOYEE_COLLECTION).distinct("role", { role: { $exists: true, $ne: "" } });
    const now = new Date();

    for (const raw of distinctRoles) {
        const roleName = (raw || "").trim();
        if (!roleName) continue;

        const existing = await db.collection(ROLES_COLLECTION).findOne({ roleName });
        if (existing) continue;

        // Heuristic: any role name containing "admin" starts with full access
        // (still editable afterwards in the Role editor).
        const isFullAccess = /admin/i.test(roleName);

        await db.collection(ROLES_COLLECTION).insertOne({
            roleName,
            description: "Auto-discovered from employee records — configure its permissions below",
            isSystemRole: false,
            isDiscovered: true,
            isFullAccess,
            permissions: [],
            createdAt: now,
            updatedAt: now,
        });
    }
}

function mergeRow(baseRow, overrideRow) {
    const merged = { ...emptyActionSet(), ...(baseRow || {}) };
    if (overrideRow) {
        for (const a of ACTIONS) {
            if (typeof overrideRow[a] === "boolean") merged[a] = overrideRow[a];
        }
    }
    return merged;
}

async function resolveEffectivePermissions(db, entityDoc) {
    if (!entityDoc) return {};
    const modules = await getActiveModules(db);
    const role = entityDoc.accessRoleId ? await db.collection(ROLES_COLLECTION).findOne({ _id: new ObjectId(entityDoc.accessRoleId) }) : null;

    const effective = {};
    for (const mod of modules) {
        const roleRow = role?.isFullAccess
            ? { moduleKey: mod.moduleKey, ...fullActionSet() }
            : role?.permissions?.find((p) => p.moduleKey === mod.moduleKey);
        const overrideRow = entityDoc.customPermissions?.find((p) => p.moduleKey === mod.moduleKey);
        effective[mod.moduleKey] = mergeRow(roleRow, overrideRow);
    }
    return effective;
}

// Attach role display info to a list of docs.
// If accessRoleId is set → use the formally-assigned role's name.
// If not → fall back to the raw `role` text field already on the
// record (from the other screen) so the UI can show it AND let you
// one-click "adopt" it as a formal assignment via Set Role.
async function attachRoleNames(db, docs, legacyRoleField) {
    const roles = await db.collection(ROLES_COLLECTION).find({}).toArray();
    const roleMap = Object.fromEntries(roles.map((r) => [r._id.toString(), r.roleName]));

    return docs.map((d) => ({
        ...d,
        accessRoleName: roleMap[d.accessRoleId] || null,
        legacyRoleText: legacyRoleField ? d[legacyRoleField] || null : null,
    }));
}

// ═══════════════════════════════════════════════════════════
// ROLES — auto-discovered from employee_login.role, editable,
// plus manual custom-role creation still supported
// ═══════════════════════════════════════════════════════════

router.get(`${API_BASE}/roles`, async (req, res) => {
    try {
        await syncRolesFromEmployeeData(req.db);
        const roles = await req.db.collection(ROLES_COLLECTION).find({}).sort({ isFullAccess: -1, roleName: 1 }).toArray();
        res.json({ success: true, roles: roles.map((r) => ({ ...r, _id: r._id.toString() })) });
    } catch (error) {
        console.error("Get Roles Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post(`${API_BASE}/roles`, async (req, res) => {
    try {
        const { roleName, description, permissions } = req.body;
        if (!roleName || !roleName.trim()) {
            return res.status(400).json({ success: false, message: "Role name is required" });
        }

        const existing = await req.db.collection(ROLES_COLLECTION).findOne({ roleName: roleName.trim() });
        if (existing) {
            return res.status(409).json({ success: false, message: "Role name already exists" });
        }

        const doc = {
            roleName: roleName.trim(),
            description: description || "",
            isSystemRole: false,
            isDiscovered: false,
            isFullAccess: false,
            permissions: sanitizePermissionRows(permissions),
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await req.db.collection(ROLES_COLLECTION).insertOne(doc);
        res.status(201).json({ success: true, role: { ...doc, _id: result.insertedId.toString() } });
    } catch (error) {
        console.error("Create Role Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put(`${API_BASE}/roles/:id`, async (req, res) => {
    try {
        const roleDoc = await req.db.collection(ROLES_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
        if (!roleDoc) return res.status(404).json({ success: false, message: "Role not found" });

        const { roleName, description, permissions, isFullAccess } = req.body;

        const update = {
            // Renaming a discovered role would break matching against employee_login.role text,
            // so renames are blocked for discovered/system roles — description & permissions are still editable.
            ...(roleName !== undefined && !roleDoc.isSystemRole && !roleDoc.isDiscovered && { roleName: roleName.trim() }),
            ...(description !== undefined && { description }),
            ...(isFullAccess !== undefined && { isFullAccess: Boolean(isFullAccess) }),
            ...(permissions !== undefined && !roleDoc.isFullAccess && { permissions: sanitizePermissionRows(permissions) }),
            updatedAt: new Date(),
        };

        const result = await req.db
            .collection(ROLES_COLLECTION)
            .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: update }, { returnDocument: "after" });

        res.json({ success: true, role: { ...result, _id: result._id.toString() } });
    } catch (error) {
        console.error("Update Role Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.delete(`${API_BASE}/roles/:id`, async (req, res) => {
    try {
        const roleDoc = await req.db.collection(ROLES_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
        if (!roleDoc) return res.status(404).json({ success: false, message: "Role not found" });

        const [employeeCount, vendorCount] = await Promise.all([
            req.db.collection(EMPLOYEE_COLLECTION).countDocuments({ accessRoleId: req.params.id }),
            req.db.collection(VENDOR_COLLECTION).countDocuments({ accessRoleId: req.params.id }),
        ]);

        if (employeeCount + vendorCount > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete — assigned to ${employeeCount} employee(s) and ${vendorCount} vendor(s)`,
            });
        }

        await req.db.collection(ROLES_COLLECTION).deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true, message: "Role deleted" });
    } catch (error) {
        console.error("Delete Role Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// EMPLOYEES — list (read-only here) + assign / update access
// ═══════════════════════════════════════════════════════════

router.get(`${API_BASE}/employees`, async (req, res) => {
    try {
        const employees = await req.db
            .collection(EMPLOYEE_COLLECTION)
            .find({})
            .project({ password: 0 })
            .sort({ createdAt: -1 })
            .toArray();

        const withRoles = await attachRoleNames(req.db, employees.map((e) => ({ ...e, _id: e._id.toString() })), "role");
        res.json({ success: true, employees: withRoles });
    } catch (error) {
        console.error("Get Employees Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Assigns OR updates an employee's access role + overrides — same
// endpoint handles both first-time assignment and later edits.
router.patch(`${API_BASE}/employees/:id/access`, async (req, res) => {
    try {
        const { roleId, customPermissions } = req.body;

        if (!roleId) {
            return res.status(400).json({ success: false, message: "roleId is required" });
        }

        const role = await req.db.collection(ROLES_COLLECTION).findOne({ _id: new ObjectId(roleId) });
        if (!role) return res.status(400).json({ success: false, message: "Invalid role selected" });

        const result = await req.db.collection(EMPLOYEE_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(req.params.id) },
            {
                $set: {
                    accessRoleId: roleId,
                    customPermissions: sanitizePermissionRows(customPermissions),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after", projection: { password: 0 } }
        );

        if (!result) return res.status(404).json({ success: false, message: "Employee not found" });

        res.json({ success: true, employee: { ...result, _id: result._id.toString(), accessRoleName: role.roleName } });
    } catch (error) {
        console.error("Set Employee Access Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get(`${API_BASE}/employees/:id/permissions`, async (req, res) => {
    try {
        const employee = await req.db.collection(EMPLOYEE_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });
        const effective = await resolveEffectivePermissions(req.db, employee);
        res.json({ success: true, permissions: effective });
    } catch (error) {
        console.error("Get Employee Permissions Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// VENDORS — list (read-only here) + assign / update access
// ═══════════════════════════════════════════════════════════

router.get(`${API_BASE}/vendors`, async (req, res) => {
    try {
        const vendors = await req.db
            .collection(VENDOR_COLLECTION)
            .find({})
            .project({ portalPassword: 0 })
            .sort({ id: -1 })
            .toArray();

        const withRoles = await attachRoleNames(req.db, vendors.map((v) => ({ ...v, _id: v._id.toString() })), null);
        res.json({ success: true, vendors: withRoles });
    } catch (error) {
        console.error("Get Vendors Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.patch(`${API_BASE}/vendors/:id/access`, async (req, res) => {
    try {
        const { roleId, customPermissions } = req.body;

        if (!roleId) {
            return res.status(400).json({ success: false, message: "roleId is required" });
        }

        const role = await req.db.collection(ROLES_COLLECTION).findOne({ _id: new ObjectId(roleId) });
        if (!role) return res.status(400).json({ success: false, message: "Invalid role selected" });

        const result = await req.db.collection(VENDOR_COLLECTION).findOneAndUpdate(
            { _id: new ObjectId(req.params.id) },
            {
                $set: {
                    accessRoleId: roleId,
                    customPermissions: sanitizePermissionRows(customPermissions),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after", projection: { portalPassword: 0 } }
        );

        if (!result) return res.status(404).json({ success: false, message: "Vendor not found" });

        res.json({ success: true, vendor: { ...result, _id: result._id.toString(), accessRoleName: role.roleName } });
    } catch (error) {
        console.error("Set Vendor Access Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get(`${API_BASE}/vendors/:id/permissions`, async (req, res) => {
    try {
        const vendor = await req.db.collection(VENDOR_COLLECTION).findOne({ _id: new ObjectId(req.params.id) });
        if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });
        const effective = await resolveEffectivePermissions(req.db, vendor);
        res.json({ success: true, permissions: effective });
    } catch (error) {
        console.error("Get Vendor Permissions Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
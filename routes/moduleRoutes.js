const express = require("express");
const router = express.Router();

const API_BASE = "/api/modules";
const COLLECTION = "app_modules";

/**
 * ─── Module Sync ─────────────────────────────────────────────
 * Called by the frontend (App.jsx background sync, OR the manual
 * "Sync Modules" button in User Access Management) with the full
 * list of routes from appRoutes.js:
 *   [{ name, path, moduleCode, moduleGroup }, ...]
 * Also accepts { routes: [...] } as a wrapped shape, just in case.
 *
 * Every entry is upserted by moduleCode. Any module previously
 * synced but missing from this payload is soft-deactivated rather
 * than deleted, so existing role/user permission rows referencing
 * it aren't lost — it just stops showing up as grantable.
 */
router.post(`${API_BASE}/sync`, async (req, res) => {
    try {
        const rawBody = req.body;
        const routes = Array.isArray(rawBody) ? rawBody : Array.isArray(rawBody?.routes) ? rawBody.routes : [];

        console.log(`[modules/sync] received ${Array.isArray(rawBody) ? rawBody.length : rawBody?.routes?.length ?? 0} route(s) in payload`);

        const validRoutes = routes.filter((r) => r && r.moduleCode && r.name && r.path);

        if (validRoutes.length === 0) {
            console.warn("[modules/sync] no valid routes found in payload — check that appRoutesPayload is being sent, and that express.json() runs before this router is mounted");
            return res.status(400).json({
                success: false,
                message: "No valid routes provided. Each route needs { name, path, moduleCode }. Check express.json() is mounted before this router.",
                receivedCount: routes.length,
            });
        }

        const now = new Date();
        const incomingCodes = validRoutes.map((r) => r.moduleCode);

        const ops = validRoutes.map((r) => ({
            updateOne: {
                filter: { moduleKey: r.moduleCode },
                update: {
                    $set: {
                        moduleKey: r.moduleCode,
                        moduleName: r.name,
                        route: r.path,
                        moduleGroup: r.moduleGroup || "General",
                        isActive: true,
                        updatedAt: now,
                    },
                    $setOnInsert: { createdAt: now },
                },
                upsert: true,
            },
        }));

        await req.db.collection(COLLECTION).bulkWrite(ops);

        const deactivateResult = await req.db.collection(COLLECTION).updateMany(
            { moduleKey: { $nin: incomingCodes } },
            { $set: { isActive: false, updatedAt: now } }
        );

        console.log(`[modules/sync] synced ${validRoutes.length} module(s), deactivated ${deactivateResult.modifiedCount}`);

        res.json({
            success: true,
            message: `Synced ${validRoutes.length} modules`,
            syncedCount: validRoutes.length,
            deactivatedCount: deactivateResult.modifiedCount,
        });
    } catch (error) {
        console.error("Module Sync Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── List Modules ─────────────────────────────────────────────
// ?includeInactive=true also returns modules removed from appRoutes.js
// but kept around for permission-history reasons.
router.get(`${API_BASE}`, async (req, res) => {
    try {
        const includeInactive = req.query.includeInactive === "true";
        const filter = includeInactive ? {} : { isActive: true };

        const modules = await req.db
            .collection(COLLECTION)
            .find(filter)
            .sort({ moduleGroup: 1, moduleName: 1 })
            .toArray();

        res.json({ success: true, modules: modules.map((m) => ({ ...m, _id: m._id.toString() })) });
    } catch (error) {
        console.error("Get Modules Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Debug status ────────────────────────────────────────────
// Quick sanity check: GET /api/modules/status in a browser tab or
// curl. If active/total are both 0, sync has never succeeded — check
// server logs for [modules/sync] lines and confirm this router is
// mounted AFTER app.use(cors()) and app.use(express.json()) in server.js.
router.get(`${API_BASE}/status`, async (req, res) => {
    try {
        const total = await req.db.collection(COLLECTION).countDocuments({});
        const active = await req.db.collection(COLLECTION).countDocuments({ isActive: true });
        const latest = await req.db.collection(COLLECTION).find({}).sort({ updatedAt: -1 }).limit(1).toArray();

        res.json({
            success: true,
            total,
            active,
            lastSyncedAt: latest[0]?.updatedAt || null,
            collectionName: COLLECTION,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
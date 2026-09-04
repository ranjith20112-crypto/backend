/* ============================================================
   routes/verificationRoutes.js
   Verification queue endpoints — fully dynamic per check type.

   ASSIGNMENT MODEL (two places a check's assignment info can live):
     1. checks[].assignedTo (= employee/vendor ID) / checks[].assignedToName
        -> set by THIS module's /assign endpoint (per-check assign).
        This is the SOURCE OF TRUTH for whether a check is assigned.
     2. workorder.assignedTo (= NAME string) / workorder.assignedToId
        -> set by the legacy Employee Assignment page via
           syncWorkorderAssignment() in workorderRoutes.js (assigns the
           WHOLE workorder, not one specific check).

   VERIFIER DATA MODEL (per check):
     checks[].verifier   -> everything the verifier fills in on the
                             Address / Education / Employment (etc.)
                             verifier forms: Verified-column values,
                             "unable to verify" flags, and every
                             full-width verifier-only field. This is
                             the ONLY place verifier-entered data is
                             stored — it replaces the older, generic
                             `checks[].data` field.
     checks[].providedData -> read-only "Provided" column data, expected
                             to be populated at workorder-creation time
                             from the matching candidate-intake record
                             (address / education / employment history
                             entry). This route file only READS it; it
                             never writes it.

   IMPORTANT FIX vs. the previous version of this file:
     effectiveStatus is now derived ONLY from checks.status. It no
     longer falls back to "assigned" just because the workorder root
     (or the check) has an assignedTo value. That old fallback is what
     caused every check on a workorder to appear "already assigned"
     the instant ANY one check — or the legacy whole-workorder flow —
     got assigned, even though that specific check was still pending
     and its own "Assigned To" column had nothing to show.

     The workorder-level fields are still read, but ONLY as a display
     fallback for effectiveAssignedToId / effectiveAssignedToName (so
     old data assigned via the legacy flow still shows a name) — they
     never affect effectiveStatus or the assignment/verification stage
     filtering.
   ============================================================ */

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

const API_BASE = '/api';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const CHECKTYPE_COLLECTION = 'checktype-creation';
const ASSIGNMENT_AUDIT_COLLECTION = 'workorder_assignments';

const STAGES = ['assignment', 'verification'];

const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

// True when `field` holds a real, non-empty value.
// Uses $ifNull to explicitly normalize a genuinely MISSING field to null
// before comparing — this removes any ambiguity about how a raw $ne
// treats an absent path vs. an explicit null vs. an empty string, which
// is exactly the kind of subtle aggregation quirk that can silently
// swallow the workorder-root fallback for assignedTo / assignedToName.
const isFilled = (field) => ({
  $and: [
    { $ne: [{ $ifNull: [field, null] }, null] },
    { $ne: [{ $ifNull: [field, ''] }, ''] },
  ],
});

// Shared $addFields stage: computes one effective assignment *display* per
// check (name/id fallback to workorder root for legacy data), and one
// effective STATUS that comes purely from the check's own status field.
const EFFECTIVE_FIELDS_STAGE = {
  $addFields: {
    effectiveAssignedToId: {
      $cond: [
        isFilled('$checks.assignedTo'),
        '$checks.assignedTo',
        { $ifNull: ['$assignedToId', ''] },
      ],
    },
    effectiveAssignedToName: {
      $cond: [
        isFilled('$checks.assignedToName'),
        '$checks.assignedToName',
        { $ifNull: ['$assignedTo', ''] },
      ],
    },
    // FIX: effectiveStatus reflects the CHECK's own status ONLY.
    // Never inferred from whether an assignee is present anywhere,
    // and never borrowed from the workorder root.
    effectiveStatus: {
      $switch: {
        branches: [
          {
            case: { $in: ['$checks.status', ['completed', 'verified', 'discrepancy', 'insufficient']] },
            then: '$checks.status',
          },
          {
            case: { $in: ['$checks.status', ['assigned', 'in-progress']] },
            then: 'assigned',
          },
        ],
        default: 'pending',
      },
    },
  },
};

/* ------------------------------------------------------------
   GET /api/verifications/checktypes
   Feeds both the dashboard cards AND the "Verification Type"
   filter dropdown on the Overall Verification tab.
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/checktypes`, async (req, res) => {
  try {
    const checkTypes = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .find({ status: 'Active' })
      .sort({ sortOrder: 1, createdAt: 1 })
      .project({ code: 1, name: 1, description: 1 })
      .toArray();

    res.json({
      success: true,
      checkTypes: checkTypes.map((c) => ({
        _id: c._id.toString(),
        code: c.code || '',
        name: c.name || 'Check',
        description: c.description || '',
      })),
    });
  } catch (error) {
    console.error('GET /verifications/checktypes error', error);
    res.status(500).json({ success: false, error: 'Failed to fetch check types' });
  }
});

/* ------------------------------------------------------------
   GET /api/checktypes/:id
   Single check type — used by the per-check-type queue header
   (verification-split.jsx's fetchCheckTypeInfo). This endpoint was
   called by the frontend but missing from the route file — added here.
------------------------------------------------------------ */
router.get(`${API_BASE}/checktypes/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid check type id.' });
    }

    const checkType = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(id) });

    if (!checkType) {
      return res.status(404).json({ success: false, message: 'Check type not found.' });
    }

    res.json({ success: true, checkType: { ...checkType, _id: checkType._id.toString() } });
  } catch (error) {
    console.error('GET /checktypes/:id error', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ------------------------------------------------------------
   GET /api/verifications/:checkTypeId/:stage
   ?page&limit&search&assignedToId  (assignedToId: 'all' | 'unassigned' | <id>)
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/:checkTypeId/:stage`, async (req, res) => {
  try {
    const { checkTypeId, stage } = req.params;
    if (!isValidId(checkTypeId)) return res.status(400).json({ error: 'Invalid checkTypeId' });
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });

    const master = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(checkTypeId) });
    if (!master) return res.status(404).json({ error: 'Check type not found' });

    const { page = 1, limit = 20, search = '', assignedToId = 'all' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const searchMatch = search
      ? { $or: [{ fullName: { $regex: search, $options: 'i' } }, { bgvRef: { $regex: search, $options: 'i' } }] }
      : {};

    const pipeline = [
      { $match: { 'checks.checkTypeId': checkTypeId } },
      { $unwind: '$checks' },
      { $match: { 'checks.checkTypeId': checkTypeId, ...searchMatch } },
      EFFECTIVE_FIELDS_STAGE,
    ];

    // Stage filter: assignment = pending only; verification = assigned/in-progress
    if (stage === 'assignment') {
      pipeline.push({ $match: { effectiveStatus: 'pending' } });
    } else {
      pipeline.push({ $match: { effectiveStatus: 'assigned' } });
    }

    // Assigned-user filter — reads the effective (check-first, workorder-fallback) id.
    if (assignedToId === 'unassigned') {
      pipeline.push({ $match: { $expr: { $not: [isFilled('$effectiveAssignedToId')] } } });
    } else if (assignedToId && assignedToId !== 'all') {
      pipeline.push({ $match: { effectiveAssignedToId: assignedToId } });
    }

    pipeline.push({ $sort: { updatedAt: -1 } });
    pipeline.push({
      $facet: {
        data: [
          { $skip: skip },
          { $limit: Number(limit) },
          {
            $project: {
              bgvRef: 1,
              fullName: 1,
              client: 1,
              packageName: 1,
              priority: 1,
              createdAt: 1,
              updatedAt: 1,
              checkSlNo: '$checks.slNo',
              checkType: '$checks.checkType',
              checkTypeId: '$checks.checkTypeId',
              subType: '$checks.subType',
              status: '$effectiveStatus',
              assignedTo: '$effectiveAssignedToId',
              assignedToName: '$effectiveAssignedToName',
              providedData: '$checks.providedData',
              verifier: '$checks.verifier',
              slaDeadline: '$checks.slaDeadline',
            },
          },
        ],
        totalCount: [{ $count: 'count' }],
      },
    });

    const result = await req.db.collection(WORKORDER_COLLECTION).aggregate(pipeline).toArray();
    const data = result[0]?.data || [];
    const total = result[0]?.totalCount?.[0]?.count || 0;

    res.json({
      success: true,
      data,
      total,
      page: Number(page),
      limit: Number(limit),
      checkType: { _id: master._id.toString(), code: master.code, name: master.name },
    });
  } catch (err) {
    console.error('GET /verifications/:checkTypeId/:stage error', err);
    res.status(500).json({ error: 'Failed to fetch verification queue' });
  }
});

/* ------------------------------------------------------------
   GET /api/verifications/overall
   Cross-check-type view for the "Overall Verification" tab / the
   global "All Verifications" screen.
   ?page&limit&search
   &checkTypeId   'all' | <id>            (Verification Type filter)
   &assignedToId  'all' | 'unassigned' | <id>   (Assigned User filter)
   &status        'all' | 'assignment' | 'verification' | 'completed'
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/overall`, async (req, res) => {
  try {
    const {
      checkTypeId = 'all',
      assignedToId = 'all',
      status = 'all',
      search = '',
      page = 1,
      limit = 20,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const checkTypeMatch =
      checkTypeId && checkTypeId !== 'all'
        ? { 'checks.checkTypeId': checkTypeId }
        : { 'checks.checkTypeId': { $exists: true, $ne: '' } };

    const searchMatch = search
      ? { $or: [{ fullName: { $regex: search, $options: 'i' } }, { bgvRef: { $regex: search, $options: 'i' } }] }
      : {};

    const pipeline = [
      { $match: checkTypeMatch },
      { $unwind: '$checks' },
      { $match: { ...checkTypeMatch, ...searchMatch } },
      EFFECTIVE_FIELDS_STAGE,
    ];

    if (status === 'assignment') {
      pipeline.push({ $match: { effectiveStatus: 'pending' } });
    } else if (status === 'verification') {
      pipeline.push({ $match: { effectiveStatus: 'assigned' } });
    } else if (status === 'completed') {
      pipeline.push({ $match: { effectiveStatus: { $in: ['completed', 'verified'] } } });
    }
    // status === 'all' -> no extra filter

    if (assignedToId === 'unassigned') {
      pipeline.push({ $match: { $expr: { $not: [isFilled('$effectiveAssignedToId')] } } });
    } else if (assignedToId && assignedToId !== 'all') {
      pipeline.push({ $match: { effectiveAssignedToId: assignedToId } });
    }

    pipeline.push({ $sort: { updatedAt: -1 } });
    pipeline.push({
      $facet: {
        data: [
          { $skip: skip },
          { $limit: Number(limit) },
          {
            $project: {
              bgvRef: 1,
              fullName: 1,
              client: 1,
              packageName: 1,
              priority: 1,
              createdAt: 1,
              updatedAt: 1,
              checkSlNo: '$checks.slNo',
              checkType: '$checks.checkType',
              checkTypeId: '$checks.checkTypeId',
              subType: '$checks.subType',
              status: '$effectiveStatus',
              assignedTo: '$effectiveAssignedToId',
              assignedToName: '$effectiveAssignedToName',
              providedData: '$checks.providedData',
              verifier: '$checks.verifier',
              slaDeadline: '$checks.slaDeadline',
            },
          },
        ],
        totalCount: [{ $count: 'count' }],
      },
    });

    const result = await req.db.collection(WORKORDER_COLLECTION).aggregate(pipeline).toArray();
    const data = result[0]?.data || [];
    const total = result[0]?.totalCount?.[0]?.count || 0;

    res.json({ success: true, data, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('GET /verifications/overall error', err);
    res.status(500).json({ error: 'Failed to fetch overall verifications' });
  }
});

/* ------------------------------------------------------------
   GET /api/verifications/:checkTypeId/stats
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/:checkTypeId/stats`, async (req, res) => {
  try {
    const { checkTypeId } = req.params;
    if (!isValidId(checkTypeId)) return res.status(400).json({ error: 'Invalid checkTypeId' });

    const pipeline = [
      { $match: { 'checks.checkTypeId': checkTypeId } },
      { $unwind: '$checks' },
      { $match: { 'checks.checkTypeId': checkTypeId } },
      EFFECTIVE_FIELDS_STAGE,
      {
        $group: {
          _id: null,
          assignmentPending: { $sum: { $cond: [{ $eq: ['$effectiveStatus', 'pending'] }, 1, 0] } },
          verificationPending: { $sum: { $cond: [{ $eq: ['$effectiveStatus', 'assigned'] }, 1, 0] } },
        },
      },
    ];

    const result = await req.db.collection(WORKORDER_COLLECTION).aggregate(pipeline).toArray();
    res.json({
      success: true,
      checkTypeId,
      assignmentPending: result[0]?.assignmentPending || 0,
      verificationPending: result[0]?.verificationPending || 0,
    });
  } catch (err) {
    console.error('GET /verifications/:checkTypeId/stats error', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/* ------------------------------------------------------------
   GET /api/verifications/stats/all
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/stats/all`, async (req, res) => {
  try {
    const pipeline = [
      { $unwind: '$checks' },
      { $match: { 'checks.checkTypeId': { $exists: true, $ne: '' } } },
      EFFECTIVE_FIELDS_STAGE,
      {
        $group: {
          _id: '$checks.checkTypeId',
          assignmentPending: { $sum: { $cond: [{ $eq: ['$effectiveStatus', 'pending'] }, 1, 0] } },
          verificationPending: { $sum: { $cond: [{ $eq: ['$effectiveStatus', 'assigned'] }, 1, 0] } },
        },
      },
    ];

    const rows = await req.db.collection(WORKORDER_COLLECTION).aggregate(pipeline).toArray();

    const out = {};
    rows.forEach((r) => {
      out[r._id] = {
        assignmentPending: r.assignmentPending,
        verificationPending: r.verificationPending,
      };
    });

    res.json({ success: true, data: out });
  } catch (err) {
    console.error('GET /verifications/stats/all error', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/* ------------------------------------------------------------
   POST /api/verifications/assign
   Writes assignment onto checks[slNo] ONLY — never the workorder root.
   Also logs an audit record in workorder_assignments for history/reporting.
------------------------------------------------------------ */
router.post(`${API_BASE}/verifications/assign`, async (req, res) => {
  try {
    const {
      workorderId,
      checkSlNo,
      assignmentType = 'internal',
      assignedToId,
      assignedToName,
      notes = '',
      slaDays = 7,
    } = req.body;

    if (!workorderId || checkSlNo === undefined || !assignedToId) {
      return res.status(400).json({ error: 'workorderId, checkSlNo, assignedToId are required' });
    }
    if (!isValidId(workorderId)) return res.status(400).json({ error: 'Invalid workorderId' });
    if (!['internal', 'external'].includes(assignmentType)) {
      return res.status(400).json({ error: "assignmentType must be 'internal' or 'external'" });
    }

    const wo = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ error: 'Workorder not found' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => Number(c.slNo) === Number(checkSlNo));
    if (idx === -1) return res.status(404).json({ error: 'Check not found on this workorder' });

    const now = new Date();
    const slaDeadline = new Date(now.getTime() + Number(slaDays) * 24 * 60 * 60 * 1000);

    checks[idx] = {
      ...checks[idx],
      assignedTo: assignedToId,
      assignedToName: assignedToName || '',
      assignmentType,
      status: 'assigned',
      notes: notes || checks[idx].notes || '',
      slaDays: Number(slaDays) || 7,
      slaDeadline,
      assignedAt: now,
    };

    await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } }
    );

    await req.db.collection(ASSIGNMENT_AUDIT_COLLECTION).insertOne({
      workorderId,
      checkSlNo: Number(checkSlNo),
      assignmentType,
      assignedToId,
      assignedToName,
      notes,
      slaDays: Number(slaDays),
      slaDeadline,
      status: 'assigned',
      assignedBy: req.user?._id || null,
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    res.json({ success: true, message: 'Check assigned successfully' });
  } catch (err) {
    console.error('POST /verifications/assign error', err);
    res.status(500).json({ error: 'Failed to assign check' });
  }
});

/* ------------------------------------------------------------
   PUT /api/verifications/:workorderId/checks/:checkSlNo/draft
   "Save" (draft, non-terminal) endpoint used by every verifier form
   (Address / Education / Employment / etc.). Merges whatever the
   verifier has typed so far into checks[slNo].verifier WITHOUT marking
   the check complete, so navigating away and coming back never loses
   partial work. If the check was still 'pending' (never formally
   assigned — e.g. opened directly), bump it to 'assigned' so it shows
   up correctly in the Verification Pending queue.
------------------------------------------------------------ */
router.put(`${API_BASE}/verifications/:workorderId/checks/:checkSlNo/draft`, async (req, res) => {
  try {
    const { workorderId, checkSlNo } = req.params;
    const { data = {}, notes = '' } = req.body;

    if (!isValidId(workorderId)) return res.status(400).json({ error: 'Invalid workorderId' });

    const wo = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ error: 'Workorder not found' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => Number(c.slNo) === Number(checkSlNo));
    if (idx === -1) return res.status(404).json({ error: 'Check not found on this workorder' });

    const now = new Date();

    checks[idx] = {
      ...checks[idx],
      verifier: { ...(checks[idx].verifier || {}), ...data },
      notes: notes || checks[idx].notes || '',
      status: checks[idx].status === 'pending' ? 'assigned' : checks[idx].status,
      updatedAt: now,
    };

    await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } }
    );

    res.json({ success: true, message: 'Draft saved successfully' });
  } catch (err) {
    console.error('PUT /verifications/:workorderId/checks/:checkSlNo/draft error', err);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

/* ------------------------------------------------------------
   POST /api/verifications/complete
   Writes completion onto checks[slNo] ONLY, merging new verifier data
   into whatever was already saved on that check (so partial saves from
   "Save Draft" aren't wiped out by a later "Submit").
   If every check on the workorder is now completed, bumps the
   workorder's own status too (informational only).
------------------------------------------------------------ */
router.post(`${API_BASE}/verifications/complete`, async (req, res) => {
  try {
    const { workorderId, checkSlNo, result, data = {}, notes = '' } = req.body;
    if (!workorderId || checkSlNo === undefined || !result) {
      return res.status(400).json({ error: 'workorderId, checkSlNo, result are required' });
    }
    if (!isValidId(workorderId)) return res.status(400).json({ error: 'Invalid workorderId' });

    const wo = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ error: 'Workorder not found' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => Number(c.slNo) === Number(checkSlNo));
    if (idx === -1) return res.status(404).json({ error: 'Check not found on this workorder' });

    const statusMap = { verified: 'completed', discrepant: 'discrepancy', insufficient: 'insufficient' };
    const newStatus = statusMap[result] || 'completed';
    const now = new Date();

    checks[idx] = {
      ...checks[idx],
      status: newStatus,
      verifier: { ...(checks[idx].verifier || {}), ...data },
      notes: notes || checks[idx].notes || '',
      completedAt: now,
    };

    const allCompleted = checks.every((c) => c.status === 'completed');
    const updateFields = { checks, updatedAt: now };
    if (allCompleted) updateFields.status = 'completed';

    await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id: new ObjectId(workorderId) },
      { $set: updateFields }
    );

    res.json({ success: true, message: 'Check updated successfully' });
  } catch (err) {
    console.error('POST /verifications/complete error', err);
    res.status(500).json({ error: 'Failed to complete check' });
  }
});

/* ------------------------------------------------------------
   GET /api/verifications/meta/employees
   Used by the Assign modal's "Internal Executive" dropdown, and by
   the queue's "Assigned User" filter, when a screen needs a lighter
   employee list scoped to this module rather than the full /employees.
------------------------------------------------------------ */
router.get(`${API_BASE}/verifications/meta/employees`, async (req, res) => {
  try {
    const employees = await req.db
      .collection('employee_login')
      .find({ isActive: { $ne: false } })
      .project({ fullName: 1, department: 1, role: 1 })
      .toArray();
    res.json({ success: true, data: employees.map((e) => ({ ...e, _id: e._id.toString() })) });
  } catch (err) {
    console.error('GET /verifications/meta/employees error', err);
    res.status(500).json({ error: 'Failed to fetch employees' });
  }
});

module.exports = router;
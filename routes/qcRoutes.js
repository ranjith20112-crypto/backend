// routes/qcRoutes.js
// ============================================================================
//  QC + REPORT MODULE
//  ----------------------------------------------------------------------
//  Continues the pipeline that starts in dataManagementRoutes.js /
//  verificationRoutes.js:
//
//    assignment-pending -> verification-pending -> report (verifier done)
//        -> [Move to QC]  -> status: 'qc', qcStatus: 'pending'   (Completed
//           Verifications tab in verification-split.jsx shows the icon)
//        -> [QC Assign]   -> qcStatus: 'assigned'                (QC
//           Assignment Team screen assigns a QC member)
//        -> [QC Member]   -> QC Member screen shows their queue, opens the
//           split-screen Verify QC modal (left = Data Management / provided
//           data, right = Verifier data), then either:
//             approve -> status: 'report', qcStatus: 'completed'  (shows in
//                        the Report screen)
//             reject  -> status: 'verification-pending', qcStatus: null
//                        (kicked back to the original verifier)
//
//  Reuses the SAME `new-workorder-creation` collection and `checks[]`
//  sub-document shape as every other route file — no schema migration.
//  QC fields live alongside the existing per-check fields:
//
//    qcStatus            null | 'pending' | 'assigned' | 'completed'
//    movedToQCAt          Date | null
//    movedToQCBy           object | null   (who clicked "Move to QC")
//    qcAssignedTo          string  (QC member display name)
//    qcAssignedToId         string | null (employee_login _id)
//    qcAssignedToEmail       string
//    qcAssignmentType         'internal' | 'external' | null
//    qcAssignedAt              Date | null
//    qcResult                   'approved' | 'rejected' | null
//    qcNotes                      string
//    qcRejectionReason              string
//    qcCompletedAt                   Date | null
//    qcVerifiedBy                     object | null
//
//  NOTE: routes/workorderRoutes.js's generic PUT /api/workorders/:id ->
//  normalizeCheck() does not currently preserve these QC fields when the
//  whole workorder is re-saved from the employee edit screens. See
//  PATCH_NOTES.md for the small addition needed there so a full workorder
//  save never silently drops QC progress.
// ============================================================================

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

let emailService = {};
try {
  // Reused if present; every call below is wrapped in try/catch so a
  // missing/renamed export never breaks the QC workflow itself.
  emailService = require('../config/emailservice');
} catch {
  emailService = {};
}

const API_BASE = '/api/qc';
const REPORT_BASE = '/api/report';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const EMPLOYEE_COLLECTION = 'employee_login';
const VENDOR_COLLECTION = 'vendors';

const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

const shapeWorkorder = (doc) =>
  doc ? { ...doc, _id: doc._id ? doc._id.toString() : undefined } : null;

const safeSend = async (fnName, payload) => {
  try {
    const fn = emailService[fnName];
    if (typeof fn === 'function') await fn(payload);
  } catch (e) {
    console.error(`QC email (${fnName}) failed:`, e.message);
  }
};

// Checks that have finished normal verification and are ready to be
// pulled into QC. Mirrors the terminal statuses used across the app.
const VERIFICATION_DONE_STATUSES = ['report', 'completed', 'verified'];

const getEmployeeById = async (db, id) => {
  if (!id || !isValidId(id)) return null;
  try {
    return await db.collection(EMPLOYEE_COLLECTION).findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );
  } catch {
    return null;
  }
};

const employeeDisplayName = (e) => {
  if (!e) return '';
  const firstName = e.firstName || e.first_name || '';
  const lastName = e.lastName || e.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return fullName || e.displayName || e.name || e.fullName || e.email || 'Unknown';
};

/* ####################################################################
   ##  1) COMPLETED VERIFICATIONS — eligible-for-QC list + move action ##
   #################################################################### */

// GET /api/qc/completed/list?checkTypeId=&search=
// Powers the "Completed Verifications" tab in verification-split.jsx —
// every check that has finished verification and has NOT yet been moved
// to QC (qcStatus is empty).
router.get(`${API_BASE}/completed/list`, async (req, res) => {
  try {
    const { checkTypeId, search = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.status': { $in: VERIFICATION_DONE_STATUSES } })
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (!VERIFICATION_DONE_STATUSES.includes(c.status)) return;
        if (c.qcStatus) return; // already moved to / through QC
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;
        if (c.stopped) return;

        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          status: c.status,
          assignedToName: c.assignedTo && !isValidId(c.assignedTo) ? c.assignedTo : (c.assignedToName || ''),
          completedAt: c.completedAt || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /qc/completed/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/qc/:workorderId/checks/:slNo/move-to-qc
// body: { movedBy }
router.put(`${API_BASE}/:workorderId/checks/:slNo/move-to-qc`, async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    const { movedBy } = req.body || {};
    if (!isValidId(workorderId)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
    if (!VERIFICATION_DONE_STATUSES.includes(checks[idx].status)) {
      return res.status(400).json({ success: false, message: 'This check has not finished verification yet.' });
    }
    if (checks[idx].qcStatus) {
      return res.status(400).json({ success: false, message: 'This check has already been moved to QC.' });
    }

    const now = new Date();
    checks[idx] = {
      ...checks[idx],
      status: 'qc',
      qcStatus: 'pending',
      movedToQCAt: now,
      movedToQCBy: movedBy || null,
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    res.json({
      success: true,
      message: 'Check moved to QC.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (err) {
    console.error('PUT /qc/:workorderId/checks/:slNo/move-to-qc error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/qc/rejected/list?checkTypeId=&search=
// Powers the "QC Request" tab in verification-split.jsx — every check a
// QC reviewer sent back (status === 'qc-rejected'), scoped to a single
// check type just like the Assignment / Verification tabs. The row
// action there re-opens the SAME verifier form used everywhere else;
// resubmitting clears 'qc-rejected' automatically (see the /verify
// rejection branch above for why no extra endpoint is needed for that).
router.get(`${API_BASE}/rejected/list`, async (req, res) => {
  try {
    const { checkTypeId, search = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.status': 'qc-rejected' })
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (c.status !== 'qc-rejected') return;
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;

        rows.push({
          _id: wo._id.toString(),
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          status: c.status,
          assignedToName: c.assignedTo && !isValidId(c.assignedTo) ? c.assignedTo : (c.assignedToName || ''),
          qcRejectionReason: c.qcRejectionReason || '',
          qcVerifiedBy: c.qcVerifiedBy || null,
          qcCompletedAt: c.qcCompletedAt || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /qc/rejected/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ####################################################################
   ##  2) QC ASSIGNMENT TEAM — list qcStatus='pending', assign a member ##
   #################################################################### */

// GET /api/qc/assignment/list?search=&status=pending|assigned
//   status defaults to 'pending' (checks awaiting assignment). Pass
//   status=assigned to power the "Assigned" tab — every check already
//   handed to a QC member, regardless of who.
router.get(`${API_BASE}/assignment/list`, async (req, res) => {
  try {
    const { search = '', status = 'pending' } = req.query;
    const searchTerm = search.toLowerCase().trim();
    const targetQcStatus = status === 'assigned' ? 'assigned' : 'pending';

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.qcStatus': targetQcStatus })
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (c.qcStatus !== targetQcStatus) return;
        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          movedToQCAt: c.movedToQCAt || null,
          qcAssignedTo: c.qcAssignedTo || '',
          qcAssignedToId: c.qcAssignedToId || null,
          qcAssignedAt: c.qcAssignedAt || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /qc/assignment/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/qc/assignment/assignees
// Combined employee + vendor list for the QC "Assign" dropdown.
router.get(`${API_BASE}/assignment/assignees`, async (req, res) => {
  try {
    const employees = await req.db
      .collection(EMPLOYEE_COLLECTION)
      .find({})
      .project({ password: 0 })
      .toArray();

    let vendors = [];
    try {
      vendors = await req.db
        .collection(VENDOR_COLLECTION)
        .find({})
        .project({ portalPassword: 0 })
        .toArray();
    } catch {
      vendors = [];
    }

    res.json({
      success: true,
      internal: employees.map((e) => ({
        id: e._id.toString(),
        name: employeeDisplayName(e),
        email: e.email || '',
      })),
      external: vendors.map((v) => ({
        id: v._id.toString(),
        name: v.companyName || v.name || employeeDisplayName(v),
        email: v.email || v.portalEmail || '',
      })),
    });
  } catch (err) {
    console.error('GET /qc/assignment/assignees error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/qc/assignment/assign
// body: { workorderId, checkSlNo, assignedToId, assignedToName, assignedToEmail, assignmentType, notes }
router.post(`${API_BASE}/assignment/assign`, async (req, res) => {
  try {
    const {
      workorderId,
      checkSlNo,
      assignedToId,
      assignedToName,
      assignedToEmail,
      assignmentType,
      notes,
    } = req.body || {};

    if (!isValidId(workorderId) || checkSlNo === undefined || !assignedToId) {
      return res.status(400).json({ success: false, message: 'workorderId, checkSlNo and assignedToId are required.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(checkSlNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
    if (checks[idx].qcStatus !== 'pending') {
      return res.status(400).json({ success: false, message: 'This check is not awaiting QC assignment.' });
    }

    const now = new Date();
    checks[idx] = {
      ...checks[idx],
      qcAssignedTo: assignedToName || '',
      qcAssignedToId: assignedToId,
      qcAssignedToEmail: assignedToEmail || '',
      qcAssignmentType: assignmentType || 'internal',
      qcAssignedAt: now,
      qcStatus: 'assigned',
      qcNotes: notes || checks[idx].qcNotes || '',
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    safeSend('sendCheckAssignmentNotification', {
      assigneeEmail: assignedToEmail,
      assigneeName: assignedToName,
      bgvRef: wo.bgvRef,
      candidateName: wo.fullName,
      checkType: checks[idx].checkType,
      subType: checks[idx].subType,
      workorderId,
      slNo: checkSlNo,
    });

    res.json({
      success: true,
      message: 'Check assigned to QC member.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (err) {
    console.error('POST /qc/assignment/assign error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ####################################################################
   ##  3) QC MEMBER SCREEN — a QC member's own queue                  ##
   #################################################################### */

// GET /api/qc/member/list?assignedToId=&checkTypeId=&from=&to=&search=
//   By default (no assignedToId) shows EVERY check currently assigned to
//   ANY QC member — the QC Member Queue screen's default "all QC" view.
//   Pass assignedToId to scope to one member. Optional checkTypeId and
//   from/to (on qcAssignedAt) filters power the screen's filter row.
router.get(`${API_BASE}/member/list`, async (req, res) => {
  try {
    const { assignedToId, checkTypeId, from, to, search = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const matchQuery = { 'checks.qcStatus': 'assigned' };
    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find(matchQuery)
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (c.qcStatus !== 'assigned') return;
        if (assignedToId && String(c.qcAssignedToId) !== String(assignedToId)) return;
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;
        if (fromDate && (!c.qcAssignedAt || new Date(c.qcAssignedAt) < fromDate)) return;
        if (toDate && (!c.qcAssignedAt || new Date(c.qcAssignedAt) > toDate)) return;

        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          qcAssignedTo: c.qcAssignedTo || '',
          qcAssignedToId: c.qcAssignedToId || null,
          qcAssignedAt: c.qcAssignedAt || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /qc/member/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/qc/member/completed/list?assignedToId=&checkTypeId=&from=&to=&search=
//   "Completed" tab on the QC Member Queue screen — every check THIS
//   module has finished QC on (qcStatus === 'completed'), i.e. already
//   moved to Report. Same optional filters as the Assigned list above.
router.get(`${API_BASE}/member/completed/list`, async (req, res) => {
  try {
    const { assignedToId, checkTypeId, from, to, search = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.qcStatus': 'completed' })
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (c.qcStatus !== 'completed') return;
        if (assignedToId && String(c.qcAssignedToId) !== String(assignedToId)) return;
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;
        if (fromDate && (!c.qcCompletedAt || new Date(c.qcCompletedAt) < fromDate)) return;
        if (toDate && (!c.qcCompletedAt || new Date(c.qcCompletedAt) > toDate)) return;

        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          qcAssignedTo: c.qcAssignedTo || '',
          qcAssignedToId: c.qcAssignedToId || null,
          qcResult: c.qcResult || 'approved',
          qcCompletedAt: c.qcCompletedAt || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /qc/member/completed/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/qc/:workorderId/checks/:slNo/detail
// Full detail for the split-screen Verify QC modal.
//   left  = Data Management side: check.data.__structured (candidate-provided
//           data), candidateDetails, documents, and who the check was
//           assigned to for data entry (resolved via employee_login).
//   right = Verifier side: check.verifier (+ unableToVerify flags etc).
const getQcCheckDetail = async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    if (!isValidId(workorderId)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const check = checks.find((c) => String(c.slNo) === String(slNo));
    if (!check) return res.status(404).json({ success: false, message: 'Check not found.' });

    // Resolve who performed the original data-entry / verification, from
    // employee_login (assignedToId is the employee id per the workorder
    // check's own assignedToId field).
    const dataEntryEmployee = await getEmployeeById(req.db, check.assignedToId);
    const qcEmployee = await getEmployeeById(req.db, check.qcAssignedToId);

    res.json({
      success: true,
      candidate: {
        workorderId: wo._id.toString(),
        bgvRef: wo.bgvRef || '',
        fullName: wo.fullName || '',
        email: wo.email || '',
        phone: wo.phone || '',
        client: wo.client || '',
        branch: wo.branch || '',
        packageName: wo.packageName || '',
        priority: wo.priority || '',
        initiationMode: wo.initiationMode || '',
      },
      candidateDetails: wo.candidateDetails || {},
      documents: Array.isArray(wo.documents) ? wo.documents : [],
      check: {
        slNo: check.slNo,
        checkType: check.checkType || '',
        subType: check.subType || '',
        status: check.status || '',
        notes: check.notes || '',
        assignedTo: check.assignedTo || '',
        assignedToId: check.assignedToId || null,
        completedAt: check.completedAt || null,
        qcStatus: check.qcStatus || null,
        qcAssignedTo: check.qcAssignedTo || '',
        qcAssignedAt: check.qcAssignedAt || null,
        qcResult: check.qcResult || null,
        qcNotes: check.qcNotes || '',
        qcCompletedAt: check.qcCompletedAt || null,
      },
      // LEFT PANEL — everything captured at data-entry time.
      dataManagementSide: {
        structured: check?.data?.__structured || {},
        rawData: check?.data || {},
        performedBy: dataEntryEmployee
          ? {
              id: dataEntryEmployee._id.toString(),
              name: employeeDisplayName(dataEntryEmployee),
              email: dataEntryEmployee.email || '',
              department: dataEntryEmployee.department || '',
              role: dataEntryEmployee.role || '',
            }
          : (check.assignedTo ? { id: null, name: check.assignedTo, email: '', department: '', role: '' } : null),
      },
      // RIGHT PANEL — everything captured at verification time.
      verifierSide: {
        verifier: check.verifier || {},
      },
      qcMember: qcEmployee
        ? {
            id: qcEmployee._id.toString(),
            name: employeeDisplayName(qcEmployee),
            email: qcEmployee.email || '',
          }
        : null,
    });
  } catch (err) {
    console.error('GET /qc/:workorderId/checks/:slNo/detail error', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

router.get(`${API_BASE}/:workorderId/checks/:slNo/detail`, getQcCheckDetail);

// PUT /api/qc/:workorderId/checks/:slNo/verify
// body: { qcResult: 'approved' | 'rejected', qcNotes, verifiedBy }
//   approved -> status: 'report', qcStatus: 'completed'  (-> Report screen)
//   rejected -> status: 'verification-pending', qcStatus: null (kicked back
//               to the original verifier queue with the rejection reason
//               recorded on qcRejectionReason)
router.put(`${API_BASE}/:workorderId/checks/:slNo/verify`, async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    const { qcResult, qcNotes, verifiedBy } = req.body || {};

    if (!isValidId(workorderId)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    }
    if (!['approved', 'rejected'].includes(qcResult)) {
      return res.status(400).json({ success: false, message: "qcResult must be 'approved' or 'rejected'." });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
    if (checks[idx].qcStatus !== 'assigned') {
      return res.status(400).json({ success: false, message: 'This check is not currently awaiting QC verification.' });
    }

    const now = new Date();

    if (qcResult === 'approved') {
      checks[idx] = {
        ...checks[idx],
        status: 'report',
        qcStatus: 'completed',
        qcResult: 'approved',
        qcNotes: qcNotes || checks[idx].qcNotes || '',
        qcCompletedAt: now,
        qcVerifiedBy: verifiedBy || null,
      };
    } else {
      // Rejected checks do NOT go straight back into the normal
      // verification-pending queue — they land in a dedicated "QC Request"
      // tab (scoped per check type, in verification-split.jsx) so the
      // verifier can see exactly which checks QC sent back and why. Once
      // the verifier re-submits via the SAME verifier form / SAME
      // POST /api/verifications/complete endpoint used everywhere else,
      // that endpoint's own statusMap moves the check out of
      // 'qc-rejected' automatically — no special-casing needed there.
      checks[idx] = {
        ...checks[idx],
        status: 'qc-rejected',
        qcStatus: null,
        qcResult: 'rejected',
        qcRejectionReason: qcNotes || '',
        qcCompletedAt: now,
        qcVerifiedBy: verifiedBy || null,
      };
    }

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    if (qcResult === 'rejected') {
      safeSend('sendCheckAssignmentNotification', {
        assigneeEmail: checks[idx].assignedToEmail,
        assigneeName: checks[idx].assignedTo,
        bgvRef: wo.bgvRef,
        candidateName: wo.fullName,
        checkType: checks[idx].checkType,
        subType: checks[idx].subType,
        workorderId,
        slNo,
        note: `Sent back by QC: ${qcNotes || 'No reason provided.'}`,
      });
    }

    res.json({
      success: true,
      message: qcResult === 'approved' ? 'QC approved — moved to Report.' : 'QC rejected — sent back to verifier.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (err) {
    console.error('PUT /qc/:workorderId/checks/:slNo/verify error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ####################################################################
   ##  4) REPORT SCREEN — finalized (qcStatus='completed') checks     ##
   #################################################################### */

// GET /api/report/list?search=&client=&checkTypeId=&from=&to=&finalized=
//   finalized: 'true' -> only checks already sent to a client (Report
//   Delivery); 'false' -> only not-yet-finalized; omitted -> all
//   QC-approved checks. Powers both the Report screen's "All" tab
//   (finalized omitted) and "Finalized" tab (finalized=true).
router.get(`${REPORT_BASE}/list`, async (req, res) => {
  try {
    const { search = '', client = '', checkTypeId = '', from = '', to = '', finalized = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();
    const clientTerm = client.toLowerCase().trim();
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.qcStatus': 'completed' })
      .sort({ updatedAt: -1 })
      .toArray();

    const rows = [];
    workorders.forEach((wo) => {
      if (searchTerm) {
        const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${wo.client || ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) return;
      }
      if (clientTerm && !(wo.client || '').toLowerCase().includes(clientTerm)) return;

      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (c.qcStatus !== 'completed') return;
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;
        if (fromDate && (!c.qcCompletedAt || new Date(c.qcCompletedAt) < fromDate)) return;
        if (toDate && (!c.qcCompletedAt || new Date(c.qcCompletedAt) > toDate)) return;
        if (finalized === 'true' && !c.reportFinalized) return;
        if (finalized === 'false' && c.reportFinalized) return;

        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          packageName: wo.packageName || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          qcResult: c.qcResult || 'approved',
          qcCompletedAt: c.qcCompletedAt || null,
          qcAssignedTo: c.qcAssignedTo || '',
          reportFinalized: !!c.reportFinalized,
          reportFinalizedAt: c.reportFinalizedAt || null,
          reportSentTo: c.reportSentTo || '',
          reportDeliveryStatus: c.reportDeliveryStatus || null,
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /report/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/report/:workorderId/checks/:slNo
// Read-only detail view — reuses the exact same handler/shape as the QC
// detail endpoint above so the Report screen can reuse the same viewer.
router.get(`${REPORT_BASE}/:workorderId/checks/:slNo`, getQcCheckDetail);

module.exports = router;
// routes/workorderRoutes.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  sendCandidateInviteEmail,
  sendNewWorkorderSupporterNotification,
  sendCheckHoldNotification,
  sendCaseHoldNotification,
  sendStopCheckNotification,
  sendStopWorkorderNotification,
} = require('../config/emailservice');
const XLSX = require('xlsx')
const API_BASE = '/api';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const CHECKTYPE_COLLECTION = 'checktype-creation';
const CLIENT_COLLECTION = 'client-details';
const PACKAGE_COLLECTION = 'package-creation';
const EMPLOYEE_COLLECTION = 'employee_login';
const VENDOR_COLLECTION = 'vendors'; // FIX: was referenced in GET /vendors but never defined — every call threw a ReferenceError.
const ASSIGNMENT_COLLECTION = 'Workorder-Assignment';
const INSUFFICIENCY_COLLECTION = 'Workorder-Insufficiency';

// ====================================================================
// FILE UPLOAD (multer)  [SHARED — used by both employee & client]
// ====================================================================
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'candidates');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.fieldname.replace(/[^a-z0-9_]/gi, '');
    const ext = path.extname(file.originalname) || '';
    cb(null, `${safe}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|pdf/;
  const ok =
    allowed.test(path.extname(file.originalname).toLowerCase()) &&
    allowed.test(file.mimetype);
  if (ok) return cb(null, true);
  cb(new Error('Only JPG, PNG and PDF files are allowed.'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Single-file uploader used by the generic "Upload Documents" tab
// (field name is always 'file'; the document type is passed separately
// in the request body so any number of document kinds can be supported
// without needing a fixed field-name list up front).
const singleDocUpload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const documentFields = [
  { name: 'passportPhoto', maxCount: 1 },
  { name: 'aadhaarFile', maxCount: 1 },
  { name: 'panFile', maxCount: 1 },
  { name: 'passportFile', maxCount: 1 },
  { name: 'dlFile', maxCount: 1 },
  { name: 'otherDocFile', maxCount: 1 },
];

// ---- Helpers  [SHARED] ----
const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

const toObjectIdSafe = (id) => {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
};

const shapeWorkorder = (doc) => {
  if (!doc) return null;
  return { ...doc, _id: doc._id ? doc._id.toString() : undefined };
};

// --------------------------------------------------------------------
// SUPPORTER EMAIL RESOLUTION  [SHARED]
// --------------------------------------------------------------------
const employeeDisplayName = (e) => {
  const firstName = e.firstName || e.first_name || '';
  const lastName = e.lastName || e.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return fullName || e.displayName || e.name || e.email || 'Unknown';
};

const findSupporterEmail = async (db, supporterName) => {
  if (!supporterName) return '';
  try {
    const employees = await db.collection(EMPLOYEE_COLLECTION).find({}).toArray();
    const match = employees.find(
      (e) => employeeDisplayName(e).toLowerCase().trim() === String(supporterName).toLowerCase().trim()
    );
    return match?.email || '';
  } catch (err) {
    console.error('findSupporterEmail error:', err.message);
    return '';
  }
};

const findClientDoc = async (db, clientRef) => {
  if (!clientRef) return null;
  try {
    if (isValidId(clientRef)) {
      const byId = await db.collection(CLIENT_COLLECTION).findOne({ _id: new ObjectId(clientRef) });
      if (byId) return byId;
    }
    return await db.collection(CLIENT_COLLECTION).findOne({
      $or: [{ companyName: clientRef }, { clientCode: clientRef }, { displayName: clientRef }],
    });
  } catch (err) {
    console.error('findClientDoc error:', err.message);
    return null;
  }
};

const notifySupporterOfNewWorkorder = (db, { clientRef, bgvRef, candidateName, workorderId }) => {
  (async () => {
    try {
      const clientDoc = await findClientDoc(db, clientRef);
      const supporterEmail = clientDoc ? await findSupporterEmail(db, clientDoc.customerSupporter) : '';
      await sendNewWorkorderSupporterNotification({
        supporterEmail,
        clientName: clientDoc?.companyName || clientRef,
        bgvRef,
        candidateName,
        workorderId,
      });
    } catch (err) {
      console.error('notifySupporterOfNewWorkorder failed:', err.message);
    }
  })();
};

// --------------------------------------------------------------------
// CREATOR TRACKING  [SHARED]
// --------------------------------------------------------------------
const VALID_ORIGINS = ['employee', 'client'];

const buildCreatedBy = (body = {}, fallbackOrigin = 'employee') => {
  const incoming =
    body.createdBy && typeof body.createdBy === 'object' ? body.createdBy : {};

  let origin =
    (incoming.origin || body.origin || body.creatorRole || '')
      .toString()
      .trim()
      .toLowerCase();

  const hasClientIdentity =
    !!(incoming.clientCode || body.clientCode || incoming.portalEmail ||
       body.portalEmail || incoming.clientId || body.clientId);

  if (!VALID_ORIGINS.includes(origin)) {
    origin = hasClientIdentity ? 'client' : fallbackOrigin;
  }
  if (!VALID_ORIGINS.includes(origin)) origin = 'employee';

  return {
    origin,
    userId: (incoming.userId || body.creatorId || '').toString().trim(),
    name: (incoming.name || body.creatorName || '').toString().trim(),
    email: (incoming.email || body.creatorEmail || '').toString().trim(),
    role: (incoming.role || '').toString().trim(),
    clientCode: (incoming.clientCode || body.clientCode || '').toString().trim(),
    clientId: (incoming.clientId || body.clientId || '').toString().trim(),
    portalEmail: (incoming.portalEmail || body.portalEmail || '').toString().trim(),
    branchName: (incoming.branchName || body.branchName || '').toString().trim(),
    createdAt: new Date(),
  };
};

// Normalize a single check — KEEPS dynamic fields + filled data  [SHARED]
const normalizeCheck = (c, i) => ({
  slNo: i + 1,
  checkType: c.checkType || '',
  checkTypeId: c.checkTypeId || '',
  subType: c.subType || '',
  subCheckId: c.subCheckId || null,
  infoNeeded: c.infoNeeded || 'Candidate',
  count: Number(c.count) || 1,
  fields: Array.isArray(c.fields) ? c.fields : [],
  data: c.data && typeof c.data === 'object' ? c.data : {},
  status: c.status || 'pending',
  notes: c.notes || '',
  // ---- Data Management assignment fields (preserved across saves) ----
  assignedTo: c.assignedTo || '',
  assignedToId: c.assignedToId || null,
  assignedToEmail: c.assignedToEmail || '',
  assignmentType: c.assignmentType || null,
  slaDeadline: c.slaDeadline || null,
  assignedAt: c.assignedAt || null,
  completedAt: c.completedAt || null,
  // ---- Insufficiency fields (preserved across saves) ----
  previousStatus: c.previousStatus || null,
  insufficiencyDescription: c.insufficiencyDescription || '',
  insufficiencyRaisedAt: c.insufficiencyRaisedAt || null,
  insufficiencyClearedAt: c.insufficiencyClearedAt || null,
  // ---- Check Hold fields (preserved across saves) ----
  holdPreviousStatus: c.holdPreviousStatus || null,
  holdReason: c.holdReason || '',
  holdRaisedAt: c.holdRaisedAt || null,
  holdClearedAt: c.holdClearedAt || null,
  holdRaisedBy: c.holdRaisedBy || null,
  // ---- Stop Check fields (preserved across saves) ----
  // A stop is PERMANENT (unlike hold) and can be raised AT ANY TIME — there
  // is no time restriction on when it can be raised. What varies is only
  // whether Verifitech's payment-liability policy applies (see
  // PAYMENT_GRACE_WINDOW_MS below), which is informational only and never
  // blocks the action.
  stopped: !!c.stopped,
  stoppedAt: c.stoppedAt || null,
  stopReason: c.stopReason || '',
  stoppedBy: c.stoppedBy || null,
  paymentDue: c.paymentDue !== undefined ? !!c.paymentDue : false,
  previousStatusBeforeStop: c.previousStatusBeforeStop || null,
});

const normalizeChecks = (checks) =>
  Array.isArray(checks) ? checks.map(normalizeCheck) : [];

const buildWorkorderDoc = (body) => {
  const {
    fullName = '',
    email = '',
    phone = '',
    client = '',
    branch = '',
    packageName = '',
    priority = 'Standard',
    clientRef = '',
    initiationMode = 'Candidate',
    checks = [],
    candidateDetails = {},
    status = 'draft',
    assignedTo = '',
    target = '',
  } = body || {};

  return {
    fullName: String(fullName).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    client: String(client).trim(),
    branch: String(branch).trim(),
    packageName: String(packageName).trim(),
    priority: String(priority).trim() || 'Standard',
    clientRef: String(clientRef).trim(),
    initiationMode: String(initiationMode).trim() || 'Candidate',
    checks: normalizeChecks(checks),
    candidateDetails: candidateDetails || {},
    documents: [],
    status: status || 'draft',
    assignedTo: String(assignedTo).trim(),
    target: target || '',
    locked: false,
    lockedAt: null,
    lockedBy: null,
    // ---- Case Hold fields ----
    casePreviousStatus: null,
    caseHoldReason: '',
    caseHoldRaisedAt: null,
    caseHoldClearedAt: null,
    caseHoldRaisedBy: null,
    // ---- Stop Workorder fields (PERMANENT, no time restriction to raise) ----
    stopped: false,
    stoppedAt: null,
    stopReason: '',
    stoppedBy: null,
    paymentDue: false,
    previousStatusBeforeWorkorderStop: null,
  };
};

const generateBgvRef = async (db) => {
  const year = new Date().getFullYear();
  const prefix = `BGV-${year}-`;
  const last = await db
    .collection(WORKORDER_COLLECTION)
    .find({ bgvRef: { $regex: `^${prefix}` } })
    .sort({ bgvRef: -1 })
    .limit(1)
    .toArray();

  let nextSeq = 1;
  if (last.length && last[0].bgvRef) {
    const seq = parseInt(last[0].bgvRef.split('-')[2], 10);
    if (!isNaN(seq)) nextSeq = seq + 1;
  }
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
};

const computeProgress = (wo) => {
  const checks = Array.isArray(wo.checks) ? wo.checks : [];
  const total = Math.max(checks.length, 1);
  let done = checks.filter(
    (c) => (c.data && Object.keys(c.data).length > 0) || c.status === 'completed'
  ).length;
  if (checks.length === 0) {
    const cd = wo.candidateDetails || {};
    done = cd && Object.keys(cd).length > 0 ? 1 : 0;
  }
  return { done, total };
};

const shapeCheckFromMaster = (master) => {
  if (!master) return null;
  const rawFields =
    master.fields ||
    master.formFields ||
    master.customFields ||
    master.checkFields ||
    [];

  const fields = Array.isArray(rawFields)
    ? rawFields
        .map((f) => {
          if (typeof f === 'string') return { name: f, label: f, type: 'text' };
          return {
            name: f.name || f.key || f.fieldName || f.label,
            label: f.label || f.name || f.key || 'Field',
            type: f.type || f.fieldType || 'text',
            required: !!f.required,
            options: f.options || f.choices || [],
            placeholder: f.placeholder || '',
          };
        })
        .filter((f) => f.name)
    : [];

  const subType =
    (Array.isArray(master.subChecks) && master.subChecks[0]) ||
    (Array.isArray(master.subCheckTypes) && master.subCheckTypes[0]) ||
    master.subType ||
    '';

  return {
    checkTypeId: master._id ? master._id.toString() : '',
    checkCode: master.code || '',
    checkType: master.name || master.checkTypeName || master.checkType || 'Check',
    subType,
    subChecks: Array.isArray(master.subChecks) ? master.subChecks : [],
    infoNeeded: master.infoNeeded || master.infoSource || 'Candidate',
    sla: master.sla ?? null,
    fieldVisit: !!master.fieldVisit,
    digital: !!master.digital,
    count: 1,
    fields,
    data: {},
    status: 'pending',
    notes: '',
  };
};

const syncWorkorderAssignment = async (db, workorderId, { assignedTo, assignedToId, assignmentType, status }) => {
  const objectId = toObjectIdSafe(workorderId);
  await db.collection(WORKORDER_COLLECTION).updateOne(
    { _id: objectId || workorderId },
    {
      $set: {
        assignedTo: assignedTo ?? '',
        assignedToId: assignedToId ?? null,
        assignmentType: assignmentType ?? null,
        ...(status ? { status } : {}),
        updatedAt: new Date(),
      },
    }
  );
};

// --------------------------------------------------------------------
// PAYMENT-LIABILITY POLICY  [SHARED — INFORMATIONAL ONLY]
//   Stop Check / Stop Workorder can be raised AT ANY TIME — there is NO
//   time restriction that blocks the action. However, Verifitech's
//   payment policy is: if a stop is raised within this grace window of
//   the workorder's own creation, no payment is owed for work already
//   initiated; if raised after this window has elapsed, payment becomes
//   due for the verification work already carried out. This function
//   only determines which message to show / stamp on the record — it
//   NEVER prevents the stop itself.
// --------------------------------------------------------------------
const PAYMENT_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const isPaymentDue = (createdAt) => {
  if (!createdAt) return true; // unknown creation time — treat conservatively as payment due
  return Date.now() - new Date(createdAt).getTime() > PAYMENT_GRACE_WINDOW_MS;
};

const paymentGraceExpiresAt = (createdAt) =>
  createdAt ? new Date(new Date(createdAt).getTime() + PAYMENT_GRACE_WINDOW_MS) : null;

const paymentPolicyNote = (paymentDue) =>
  paymentDue
    ? 'This action is being taken after the 24-hour payment-review window from workorder creation. As per Verifitech policy, payment is due for the verification work already initiated on this record.'
    : 'This action is within the 24-hour payment-review window from workorder creation. As per Verifitech policy, no payment is due for this stop.';

/* ####################################################################
   ##                    EMPLOYEE WORKORDER API                      ##
   #################################################################### */

router.get(`${API_BASE}/checktypes`, async (req, res) => {
  try {
    const checkTypes = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .find({})
      .sort({ sortOrder: 1, createdAt: -1 })
      .toArray();

    const mapped = checkTypes.map((c) => ({ ...c, _id: c._id.toString() }));
    res.json({ success: true, checkTypes: mapped });
  } catch (error) {
    console.error('Get Check Types Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(`${API_BASE}/workorders`, async (req, res) => {
  try {
    const doc = buildWorkorderDoc(req.body);

    if (!doc.fullName || !doc.email || !doc.phone) {
      return res.status(400).json({ success: false, message: 'Full name, email and phone are required.' });
    }
    if (!doc.client) {
      return res.status(400).json({ success: false, message: 'Client is required.' });
    }

    const forcedOrigin = (req.query.as || '').toString().trim().toLowerCase();
    const fallback = VALID_ORIGINS.includes(forcedOrigin) ? forcedOrigin : 'employee';
    const createdBy = buildCreatedBy(
      forcedOrigin ? { ...req.body, origin: forcedOrigin } : req.body,
      fallback
    );

    const bgvRef = await generateBgvRef(req.db);
    const now = new Date();
    const payload = {
      ...doc,
      createdBy,
      origin: createdBy.origin,
      bgvRef,
      createdAt: now,
      updatedAt: now,
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).insertOne(payload);
    const saved = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: result.insertedId });

    if (createdBy.origin === 'client') {
      notifySupporterOfNewWorkorder(req.db, {
        clientRef: doc.client,
        bgvRef,
        candidateName: doc.fullName,
        workorderId: result.insertedId.toString(),
      });
    }

    res.status(201).json({
      success: true,
      message: `Workorder saved as draft (created by ${createdBy.origin}).`,
      workorder: shapeWorkorder(saved),
    });
  } catch (error) {
    console.error('Create Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/workorders`, async (req, res) => {
  try {
    const origin = (req.query.origin || '').toString().trim().toLowerCase();
    const clientCode = (req.query.clientCode || '').toString().trim();
    const portalEmail = (req.query.portalEmail || '').toString().trim();

    const query = {};
    if (VALID_ORIGINS.includes(origin)) query.origin = origin;
    if (clientCode) query['createdBy.clientCode'] = clientCode;
    if (portalEmail) query['createdBy.portalEmail'] = portalEmail;

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const shaped = workorders.map((wo) => {
      const p = computeProgress(wo);
      return { ...shapeWorkorder(wo), progressDone: p.done, progressTotal: p.total };
    });

    const stats = {
      total: shaped.length,
      active: shaped.filter((w) => w.status !== 'completed' && w.status !== 'cancelled' && w.status !== 'overdue').length,
      completed: shaped.filter((w) => w.status === 'completed').length,
      overdue: shaped.filter((w) => w.status === 'overdue').length,
      onHold: shaped.filter((w) => w.status === 'on-hold').length,
      stopped: shaped.filter((w) => w.stopped).length,
      byEmployee: shaped.filter((w) => w.origin === 'employee').length,
      byClient: shaped.filter((w) => w.origin === 'client').length,
    };

    res.json({ success: true, workorders: shaped, stats });
  } catch (error) {
    console.error('List Workorders Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/workorders/assignment-view`, async (req, res) => {
  try {
    const rawWorkorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    let clientNameById = new Map();
    try {
      const rawClientIds = [...new Set(
        rawWorkorders.map((w) => (w.client ? w.client.toString() : null)).filter(Boolean)
      )];

      if (rawClientIds.length > 0) {
        const clients = await req.db
          .collection(CLIENT_COLLECTION)
          .find({ _id: { $in: rawClientIds } })
          .toArray();

        clientNameById = new Map(
          clients.map((c) => [
            c._id.toString(),
            c.companyName || c.displayName || c.name || 'Unnamed Client',
          ])
        );
      }
    } catch (lookupErr) {
      console.error('Client lookup error:', lookupErr.message);
    }

    const workorders = rawWorkorders.map((w) => {
      const checks = Array.isArray(w.checks) ? w.checks : [];
      const totalChecks = checks.length || 1;
      const completedChecks = checks.filter((c) =>
        ['completed', 'done', 'verified'].includes((c.status || '').toLowerCase())
      ).length;

      const clientId = w.client && w.client.toString ? w.client.toString() : w.client;

      return {
        _id: w._id.toString(),
        bgvRef: w.bgvRef || null,
        candidateName:
          w.fullName ||
          w.candidateName ||
          w.candidateDetails?.nameOnAadhaar ||
          w.candidateDetails?.name ||
          'Unnamed Candidate',
        client: clientNameById.get(clientId) || w.client || 'Unknown Client',
        package: w.packageName || w.package || '—',
        status: w.status || 'draft',
        progress: { current: completedChecks, total: totalChecks },
        assigned:
          w.assignedTo && String(w.assignedTo).trim() !== ''
            ? (typeof w.assignedTo === 'object'
                ? w.assignedTo.name || w.assignedTo.companyName || 'Assigned'
                : w.assignedTo)
            : 'Unassigned',
        createdAt: w.createdAt || null,
        updatedAt: w.updatedAt || null,
      };
    });

    res.json({ success: true, workorders, debug: { clientResolutionCount: clientNameById.size } });
  } catch (error) {
    console.error('Get Workorders (assignment-view) Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/workorders/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    res.json({ success: true, workorder: shapeWorkorder(wo) });
  } catch (error) {
    console.error('Get Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const existing = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: 'Workorder not found.' });
    if (existing.locked) {
      return res.status(423).json({ success: false, message: 'This workorder is finalized and cannot be edited. Unlock it first.' });
    }

    const updateFields = { updatedAt: new Date() };
    const allowed = [
      'fullName', 'email', 'phone', 'client', 'branch', 'packageName',
      'priority', 'clientRef', 'initiationMode', 'checks', 'candidateDetails',
      'status', 'assignedTo', 'target',
    ];

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        if (key === 'checks') {
          updateFields.checks = normalizeChecks(req.body.checks);
        } else {
          updateFields[key] = req.body[key];
        }
      }
    });

    const result = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateFields }, { returnDocument: 'after' });

    const updated = result?.value || result;
    if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    res.json({ success: true, message: 'Workorder updated.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
  } catch (error) {
    console.error('Update Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/lock`, async (req, res) => {
  try {
    const { id } = req.params;
    const { locked } = req.body;

    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    if (typeof locked !== 'boolean') {
      return res.status(400).json({ success: false, message: '`locked` must be true or false.' });
    }

    const now = new Date();
    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          locked,
          lockedAt: locked ? now : null,
          lockedBy: locked ? (req.user?._id || null) : null,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    const updated = result?.value || result;
    if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    res.json({
      success: true,
      message: locked ? 'Workorder finalized.' : 'Workorder unlocked.',
      locked,
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Lock Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/checks/:slNo`, async (req, res) => {
  try {
    const { id, slNo } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

    if (req.body.data && typeof req.body.data === 'object') {
      checks[idx].data = { ...(checks[idx].data || {}), ...req.body.data };
    }
    if (req.body.status !== undefined) checks[idx].status = req.body.status;
    if (req.body.notes !== undefined) checks[idx].notes = req.body.notes;

    const result = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { checks, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

    const updated = result?.value || result;
    res.json({ success: true, message: 'Check updated.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
  } catch (error) {
    console.error('Update Check Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(
  `${API_BASE}/workorders/:id/checks/:slNo/documents`,
  upload.any(),
  async (req, res) => {
    try {
      const { id, slNo } = req.params;
      if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

      const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
      if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

      const checks = Array.isArray(wo.checks) ? wo.checks : [];
      const exists = checks.some((c) => String(c.slNo) === String(slNo));
      if (!exists) return res.status(404).json({ success: false, message: 'Check not found.' });

      const files = req.files || [];
      const saved = files.map((f) => ({
        fieldname: f.fieldname,
        url: `/uploads/candidates/${f.filename}`,
        originalName: f.originalname,
      }));

      res.json({ success: true, files: saved });
    } catch (error) {
      console.error('Upload Check Document Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  `${API_BASE}/workorders/:id/documents`,
  singleDocUpload.single('file'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
      if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

      const documentType = (req.body.documentType || 'Other').toString().trim();
      const checkSlNo = req.body.checkSlNo ? String(req.body.checkSlNo).trim() : null;

      const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
      if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

      const docEntry = {
        id: new ObjectId().toString(),
        documentType,
        checkSlNo,
        url: `/uploads/candidates/${req.file.filename}`,
        originalName: req.file.originalname,
        uploadedAt: new Date(),
      };

      const documents = Array.isArray(wo.documents) ? [...wo.documents] : [];
      documents.push(docEntry);

      const result = await req.db
        .collection(WORKORDER_COLLECTION)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { documents, updatedAt: new Date() } },
          { returnDocument: 'after' }
        );

      const updated = result?.value || result;
      res.status(201).json({
        success: true,
        message: 'Document uploaded successfully.',
        document: docEntry,
        workorder: shapeWorkorder(updated.value ? updated.value : updated),
      });
    } catch (error) {
      console.error('Upload Workorder Document Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(`${API_BASE}/workorders/:id/documents`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    res.json({ success: true, documents: Array.isArray(wo.documents) ? wo.documents : [] });
  } catch (error) {
    console.error('List Workorder Documents Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete(`${API_BASE}/workorders/:id/documents/:docId`, async (req, res) => {
  try {
    const { id, docId } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const existingDocs = Array.isArray(wo.documents) ? wo.documents : [];
    const target = existingDocs.find((d) => d.id === docId);
    const documents = existingDocs.filter((d) => d.id !== docId);

    if (!target) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    if (target.url) {
      const filePath = path.join(__dirname, '..', target.url.replace(/^\//, ''));
      fs.unlink(filePath, (err) => {
        if (err) console.warn('Could not delete physical file:', filePath, err.message);
      });
    }

    const result = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { documents, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

    const updated = result?.value || result;
    res.json({
      success: true,
      message: 'Document removed successfully.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Delete Workorder Document Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/candidate`, upload.fields(documentFields), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    let candidateDetails = {};
    if (req.body.candidateDetails) {
      try {
        candidateDetails = typeof req.body.candidateDetails === 'string'
          ? JSON.parse(req.body.candidateDetails) : req.body.candidateDetails;
      } catch { candidateDetails = {}; }
    }

    const files = req.files || {};
    const fileUrl = (f) => (f && f[0] ? `/uploads/candidates/${f[0].filename}` : undefined);

    const documents = { ...(candidateDetails.documents || {}) };
    if (fileUrl(files.passportPhoto)) documents.passportPhoto = fileUrl(files.passportPhoto);
    if (fileUrl(files.aadhaarFile)) documents.aadhaarFile = fileUrl(files.aadhaarFile);
    if (fileUrl(files.panFile)) documents.panFile = fileUrl(files.panFile);
    if (fileUrl(files.passportFile)) documents.passportFile = fileUrl(files.passportFile);
    if (fileUrl(files.dlFile)) documents.dlFile = fileUrl(files.dlFile);
    if (fileUrl(files.otherDocFile)) documents.otherDocFile = fileUrl(files.otherDocFile);
    candidateDetails.documents = documents;

    const updateFields = {
      candidateDetails,
      status: req.body.status || 'candidate-details',
      updatedAt: new Date(),
    };

    const result = await req.db
      .collection(WORKORDER_COLLECTION)
      .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateFields }, { returnDocument: 'after' });

    const updated = result?.value || result;
    if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    res.json({ success: true, message: 'Candidate details saved.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
  } catch (error) {
    console.error('Save Candidate Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(`${API_BASE}/workorders/:id/send-invite`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    if ((wo.initiationMode || 'Candidate') !== 'Candidate') {
      return res.json({
        success: true,
        skipped: true,
        message: 'Initiation mode is "Verifitech" — no candidate invite needed.',
      });
    }

    const email = req.body.email || wo.email;
    const fullName = req.body.fullName || wo.fullName;

    const emailResult = await sendCandidateInviteEmail({
      to: email,
      fullName,
      bgvRef: wo.bgvRef,
      workorderId: id,
    });

    res.json({
      success: !!emailResult.success,
      message: emailResult.success ? 'Invite email sent successfully.' : 'Failed to send invite email.',
      emailResult,
    });
  } catch (error) {
    console.error('Send Invite Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete(`${API_BASE}/workorders/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const deleteResult = await req.db.collection(WORKORDER_COLLECTION).deleteOne({ _id: new ObjectId(id) });
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Workorder not found.' });
    }

    const [assignmentDelete, insufficiencyDelete] = await Promise.all([
      req.db.collection(ASSIGNMENT_COLLECTION).deleteMany({ workorderId: id }),
      req.db.collection(INSUFFICIENCY_COLLECTION).deleteMany({ workorderId: id }),
    ]);

    res.json({
      success: true,
      message: 'Workorder and related assignment records deleted successfully.',
      deletedAssignments: assignmentDelete.deletedCount,
      deletedInsufficiencies: insufficiencyDelete.deletedCount,
    });
  } catch (error) {
    console.error('Delete Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/package-checks`, async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    const code = (req.query.code || '').trim();

    if (!name && !code) {
      return res
        .status(400)
        .json({ success: false, message: 'Package name or code is required.' });
    }

    const query = name ? { name } : { code };
    const pkg = await req.db.collection(PACKAGE_COLLECTION).findOne(query);

    if (!pkg) {
      return res
        .status(404)
        .json({ success: false, message: `Package "${name || code}" not found.`, checks: [] });
    }

    let checkCodes = [];
    if (Array.isArray(pkg.checks) && pkg.checks.length) {
      checkCodes = pkg.checks.filter(Boolean);
    } else if (Array.isArray(pkg.checkComponents) && pkg.checkComponents.length) {
      checkCodes = pkg.checkComponents
        .map((c) =>
          typeof c === 'string'
            ? c
            : c.code || c.checkCode || c.checkType || c.checkTypeCode
        )
        .filter(Boolean);
    }

    if (!checkCodes.length) {
      return res.json({
        success: true,
        package: { id: pkg._id.toString(), name: pkg.name, code: pkg.code },
        checks: [],
      });
    }

    const masters = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .find({ code: { $in: checkCodes } })
      .toArray();

    const byCode = new Map(masters.map((m) => [m.code, m]));
    const checks = checkCodes
      .map((c) => byCode.get(c))
      .filter(Boolean)
      .map(shapeCheckFromMaster)
      .filter(Boolean);

    res.json({
      success: true,
      package: {
        id: pkg._id.toString(),
        name: pkg.name,
        code: pkg.code,
        description: pkg.description || '',
      },
      checks,
    });
  } catch (error) {
    console.error('Resolve Package Checks Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ####################################################################
   ##   SHARED: CHECK HOLD / CASE HOLD / STOP (NO TIME RESTRICTION)   ##
   #################################################################### */

router.put(`${API_BASE}/workorders/:id/checks/:slNo/hold`, async (req, res) => {
  try {
    const { id, slNo } = req.params;
    const { reason, raisedBy } = req.body;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'A reason for the hold is required.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

    const now = new Date();
    const holdPreviousStatus = checks[idx].status || 'assignment-pending';
    checks[idx] = {
      ...checks[idx],
      holdPreviousStatus,
      status: 'hold',
      holdReason: reason.trim(),
      holdRaisedAt: now,
      holdClearedAt: null,
      holdRaisedBy: raisedBy || null,
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    sendCheckHoldNotification({
      assigneeEmail: checks[idx].assignedToEmail,
      bgvRef: wo.bgvRef,
      candidateName: wo.fullName,
      checkType: checks[idx].checkType,
      subType: checks[idx].subType,
      reason: reason.trim(),
    }).catch((e) => console.error('Check hold email failed:', e.message));

    if (raisedBy?.origin === 'client') {
      (async () => {
        try {
          const clientDoc = await findClientDoc(req.db, wo.client);
          const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
          await sendCheckHoldNotification({
            supporterEmail,
            bgvRef: wo.bgvRef,
            candidateName: wo.fullName,
            checkType: checks[idx].checkType,
            subType: checks[idx].subType,
            reason: reason.trim(),
          });
        } catch (e) {
          console.error('Client check hold supporter email failed:', e.message);
        }
      })();
    }

    res.json({
      success: true,
      message: 'Check put on hold.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Workorder Check Hold Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/checks/:slNo/hold/clear`, async (req, res) => {
  try {
    const { id, slNo } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

    const now = new Date();
    const restoredStatus = checks[idx].holdPreviousStatus || 'assignment-pending';
    checks[idx] = { ...checks[idx], status: restoredStatus, holdClearedAt: now };

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    res.json({
      success: true,
      message: 'Check hold cleared.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Workorder Clear Check Hold Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/case-hold`, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, raisedBy } = req.body;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'A reason for the case hold is required.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
    if (wo.status === 'on-hold') {
      return res.status(400).json({ success: false, message: 'This case is already on hold.' });
    }

    const now = new Date();
    const casePreviousStatus = wo.status || 'draft';

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          casePreviousStatus,
          status: 'on-hold',
          caseHoldReason: reason.trim(),
          caseHoldRaisedAt: now,
          caseHoldClearedAt: null,
          caseHoldRaisedBy: raisedBy || null,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    (async () => {
      try {
        const clientDoc = await findClientDoc(req.db, wo.client);
        const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
        await sendCaseHoldNotification({
          supporterEmail,
          bgvRef: wo.bgvRef,
          candidateName: wo.fullName,
          clientName: clientDoc?.companyName || wo.client,
          reason: reason.trim(),
        });
      } catch (e) {
        console.error('Case hold email failed:', e.message);
      }
    })();

    res.json({
      success: true,
      message: 'Case put on hold. Every check on this workorder is paused.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Workorder Case Hold Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put(`${API_BASE}/workorders/:id/case-hold/clear`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const now = new Date();
    const restoredStatus = wo.casePreviousStatus || 'draft';

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status: restoredStatus, caseHoldClearedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    res.json({
      success: true,
      message: 'Case hold cleared.',
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Workorder Clear Case Hold Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// [SHARED] PAYMENT-POLICY PREVIEW  (read-only, used to render the
//   professional pop-up message BEFORE the user confirms a Stop)
//   GET /api/workorders/:id/payment-policy
//   Never mutates anything.
// ====================================================================
router.get(`${API_BASE}/workorders/:id/payment-policy`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const paymentDue = isPaymentDue(wo.createdAt);
    res.json({
      success: true,
      paymentDue,
      note: paymentPolicyNote(paymentDue),
      graceWindowExpiresAt: paymentGraceExpiresAt(wo.createdAt),
    });
  } catch (error) {
    console.error('Payment Policy Preview Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// [SHARED] STOP A SINGLE CHECK  (PERMANENT — may be raised at any time,
//   no time restriction. Payment liability is informational only.)
//   PUT /api/workorders/:id/checks/:slNo/stop   body: { reason, stoppedBy }
// ====================================================================
router.put(`${API_BASE}/workorders/:id/checks/:slNo/stop`, async (req, res) => {
  try {
    const { id, slNo } = req.params;
    const { reason, stoppedBy } = req.body;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
    if (checks[idx].stopped) {
      return res.status(400).json({ success: false, message: 'This check has already been stopped.' });
    }

    const now = new Date();
    const paymentDue = isPaymentDue(wo.createdAt);

    checks[idx] = {
      ...checks[idx],
      stopped: true,
      stoppedAt: now,
      stopReason: (reason || '').trim(),
      stoppedBy: stoppedBy || null,
      paymentDue,
      previousStatusBeforeStop: checks[idx].status || 'assignment-pending',
      status: 'stopped',
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    if (stoppedBy?.origin === 'client') {
      (async () => {
        try {
          const clientDoc = await findClientDoc(req.db, wo.client);
          const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
          await sendStopCheckNotification({
            supporterEmail,
            clientName: clientDoc?.companyName || wo.client,
            bgvRef: wo.bgvRef,
            candidateName: wo.fullName,
            checkType: checks[idx].checkType,
            subType: checks[idx].subType,
            reason: reason || '',
            stoppedByName: stoppedBy?.name || '',
            paymentDue,
          });
        } catch (e) {
          console.error('Stop check supporter email failed:', e.message);
        }
      })();
    }

    res.json({
      success: true,
      message: 'Check stopped.',
      paymentDue,
      paymentNote: paymentPolicyNote(paymentDue),
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Stop Check Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// [SHARED] STOP AN ENTIRE WORKORDER  (PERMANENT — may be raised at any
//   time, no time restriction. Payment liability is informational only.)
//   PUT /api/workorders/:id/stop   body: { reason, stoppedBy }
// ====================================================================
router.put(`${API_BASE}/workorders/:id/stop`, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, stoppedBy } = req.body;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
    if (wo.stopped) {
      return res.status(400).json({ success: false, message: 'This workorder has already been stopped.' });
    }

    const now = new Date();
    const paymentDue = isPaymentDue(wo.createdAt);

    const checks = (Array.isArray(wo.checks) ? wo.checks : []).map((c) => ({
      ...c,
      stopped: true,
      stoppedAt: now,
      paymentDue,
      previousStatusBeforeStop: c.status || 'assignment-pending',
      status: 'stopped',
    }));

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          checks,
          stopped: true,
          stoppedAt: now,
          stopReason: (reason || '').trim(),
          stoppedBy: stoppedBy || null,
          paymentDue,
          previousStatusBeforeWorkorderStop: wo.status || 'draft',
          status: 'stopped',
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );
    const updated = result?.value || result;

    if (stoppedBy?.origin === 'client') {
      (async () => {
        try {
          const clientDoc = await findClientDoc(req.db, wo.client);
          const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
          await sendStopWorkorderNotification({
            supporterEmail,
            clientName: clientDoc?.companyName || wo.client,
            bgvRef: wo.bgvRef,
            candidateName: wo.fullName,
            reason: reason || '',
            stoppedByName: stoppedBy?.name || '',
            paymentDue,
          });
        } catch (e) {
          console.error('Stop workorder supporter email failed:', e.message);
        }
      })();
    }

    res.json({
      success: true,
      message: 'Workorder stopped — every check on it has been halted.',
      paymentDue,
      paymentNote: paymentPolicyNote(paymentDue),
      workorder: shapeWorkorder(updated.value ? updated.value : updated),
    });
  } catch (error) {
    console.error('Stop Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// [EMPLOYEE] LIST EVERY STOPPED WORKORDER / CHECK — individual view screen
//   GET /api/workorders/stopped/list
// ====================================================================
router.get(`${API_BASE}/workorders/stopped/list`, async (req, res) => {
  try {
    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ $or: [{ stopped: true }, { 'checks.stopped': true }] })
      .sort({ updatedAt: -1 })
      .toArray();

    const stoppedWorkorders = [];
    const stoppedChecks = [];

    workorders.forEach((wo) => {
      if (wo.stopped) {
        stoppedWorkorders.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          candidateName: wo.fullName || '',
          client: wo.client || '',
          stopReason: wo.stopReason || '',
          stoppedAt: wo.stoppedAt || null,
          stoppedBy: wo.stoppedBy || null,
          paymentDue: !!wo.paymentDue,
          checkCount: Array.isArray(wo.checks) ? wo.checks.length : 0,
        });
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (!c.stopped) return;
        stoppedChecks.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          candidateName: wo.fullName || '',
          client: wo.client || '',
          slNo: c.slNo,
          checkType: c.checkType || '',
          subType: c.subType || '',
          stopReason: c.stopReason || '',
          stoppedAt: c.stoppedAt || null,
          stoppedBy: c.stoppedBy || null,
          paymentDue: !!c.paymentDue,
          partOfWorkorderStop: !!wo.stopped,
        });
      });
    });

    res.json({ success: true, stoppedWorkorders, stoppedChecks });
  } catch (error) {
    console.error('List Stopped Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ####################################################################
   ##                     CLIENT WORKORDER API                       ##
   #################################################################### */

router.post(`${API_BASE}/client/workorders`, async (req, res) => {
  try {
    const doc = buildWorkorderDoc(req.body);

    if (!doc.fullName || !doc.email || !doc.phone) {
      return res.status(400).json({ success: false, message: 'Full name, email and phone are required.' });
    }

    const clientId = (req.body.clientId || '').toString().trim();
    const clientCode = (req.body.clientCode || '').toString().trim();
    const portalEmail = (req.body.portalEmail || '').toString().trim();

    if (!clientId && !clientCode && !portalEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientId, clientCode or portalEmail is required for client-created workorders.',
      });
    }

    let clientQuery = null;
    if (clientId && isValidId(clientId)) clientQuery = { _id: new ObjectId(clientId) };
    else if (clientCode) clientQuery = { clientCode };
    else if (portalEmail) clientQuery = { portalEmail };

    const clientDoc = clientQuery
      ? await req.db.collection(CLIENT_COLLECTION).findOne(clientQuery)
      : null;

    if (!clientDoc) {
      return res.status(404).json({ success: false, message: 'Client not found.' });
    }

    if (!doc.client) doc.client = clientDoc.companyName || clientDoc.clientCode || '';

    const createdBy = buildCreatedBy(
      {
        ...req.body,
        origin: 'client',
        clientId: clientDoc._id.toString(),
        clientCode: clientDoc.clientCode || clientCode,
        portalEmail: clientDoc.portalEmail || portalEmail,
        name: req.body.creatorName || clientDoc.companyName || '',
        email: req.body.creatorEmail || clientDoc.portalEmail || portalEmail,
        branchName: req.body.branchName || clientDoc.branchName || '',
      },
      'client'
    );

    const bgvRef = await generateBgvRef(req.db);
    const now = new Date();
    const payload = {
      ...doc,
      createdBy,
      origin: 'client',
      bgvRef,
      createdAt: now,
      updatedAt: now,
    };

    const result = await req.db.collection(WORKORDER_COLLECTION).insertOne(payload);
    const saved = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: result.insertedId });

    (async () => {
      try {
        const supporterEmail = await findSupporterEmail(req.db, clientDoc.customerSupporter);
        await sendNewWorkorderSupporterNotification({
          supporterEmail,
          clientName: clientDoc.companyName,
          bgvRef,
          candidateName: doc.fullName,
          workorderId: result.insertedId.toString(),
        });
      } catch (err) {
        console.error('Client workorder supporter notification failed:', err.message);
      }
    })();

    res.status(201).json({
      success: true,
      message: 'Client workorder saved as draft.',
      workorder: shapeWorkorder(saved),
    });
  } catch (error) {
    console.error('Create Client Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/client/workorders`, async (req, res) => {
  try {
    const clientId = (req.query.clientId || '').toString().trim();
    const clientCode = (req.query.clientCode || '').toString().trim();
    const portalEmail = (req.query.portalEmail || '').toString().trim();

    if (!clientId && !clientCode && !portalEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientId, clientCode or portalEmail is required.',
      });
    }

    const orConds = [];
    if (clientId) orConds.push({ 'createdBy.clientId': clientId });
    if (clientCode) orConds.push({ 'createdBy.clientCode': clientCode });
    if (portalEmail) orConds.push({ 'createdBy.portalEmail': portalEmail });

    const query = { origin: 'client', $or: orConds };

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const shaped = workorders.map((wo) => {
      const p = computeProgress(wo);
      return { ...shapeWorkorder(wo), progressDone: p.done, progressTotal: p.total };
    });

    const stats = {
      total: shaped.length,
      active: shaped.filter((w) => w.status !== 'completed' && w.status !== 'cancelled' && w.status !== 'overdue').length,
      completed: shaped.filter((w) => w.status === 'completed').length,
      overdue: shaped.filter((w) => w.status === 'overdue').length,
      onHold: shaped.filter((w) => w.status === 'on-hold').length,
      stopped: shaped.filter((w) => w.stopped).length,
    };

    res.json({ success: true, workorders: shaped, stats });
  } catch (error) {
    console.error('List Client Workorders Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/client/workorders/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });

    const clientId = (req.query.clientId || '').toString().trim();
    const clientCode = (req.query.clientCode || '').toString().trim();
    const portalEmail = (req.query.portalEmail || '').toString().trim();

    if (!clientId && !clientCode && !portalEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientId, clientCode or portalEmail is required.',
      });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const cb = wo.createdBy || {};
    const owns =
      (clientId && cb.clientId === clientId) ||
      (clientCode && cb.clientCode === clientCode) ||
      (portalEmail && cb.portalEmail === portalEmail);

    if (wo.origin !== 'client' || !owns) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workorder.' });
    }

    res.json({ success: true, workorder: shapeWorkorder(wo) });
  } catch (error) {
    console.error('Get Client Workorder Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/client-package-checks`, async (req, res) => {
  try {
    const clientCode = (req.query.clientCode || '').trim();
    const clientId = (req.query.clientId || '').trim();
    const portalEmail = (req.query.portalEmail || '').trim();

    if (!clientCode && !clientId && !portalEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientCode, clientId or portalEmail is required.',
      });
    }

    let clientQuery = null;
    if (clientId && isValidId(clientId)) {
      clientQuery = { _id: new ObjectId(clientId) };
    } else if (clientCode) {
      clientQuery = { clientCode };
    } else if (portalEmail) {
      clientQuery = { portalEmail };
    }

    const client = clientQuery
      ? await req.db.collection(CLIENT_COLLECTION).findOne(clientQuery)
      : null;

    if (!client) {
      return res
        .status(404)
        .json({ success: false, message: 'Client not found.', checks: [] });
    }

    const packageName = (client.assignedPackage || '').trim();
    if (!packageName) {
      return res.json({
        success: true,
        client: {
          clientCode: client.clientCode,
          companyName: client.companyName,
          branchName: client.branchName,
        },
        package: null,
        checks: [],
      });
    }

    const pkg = await req.db
      .collection(PACKAGE_COLLECTION)
      .findOne({ name: packageName });

    if (!pkg) {
      return res.status(404).json({
        success: false,
        message: `Assigned package "${packageName}" not found.`,
        checks: [],
      });
    }

    let checkCodes = [];
    if (Array.isArray(pkg.checks) && pkg.checks.length) {
      checkCodes = pkg.checks.filter(Boolean);
    } else if (Array.isArray(pkg.checkComponents) && pkg.checkComponents.length) {
      checkCodes = pkg.checkComponents
        .map((c) =>
          typeof c === 'string'
            ? c
            : c.code || c.checkCode || c.checkType || c.checkTypeCode
        )
        .filter(Boolean);
    }

    let checks = [];
    if (checkCodes.length) {
      const masters = await req.db
        .collection(CHECKTYPE_COLLECTION)
        .find({ code: { $in: checkCodes } })
        .toArray();

      const byCode = new Map(masters.map((m) => [m.code, m]));
      checks = checkCodes
        .map((c) => byCode.get(c))
        .filter(Boolean)
        .map(shapeCheckFromMaster)
        .filter(Boolean);
    }

    res.json({
      success: true,
      client: {
        clientCode: client.clientCode,
        companyName: client.companyName,
        branchName: client.branchName,
        assignedPackage: packageName,
      },
      package: {
        id: pkg._id.toString(),
        name: pkg.name,
        code: pkg.code,
        description: pkg.description || '',
      },
      checks,
    });
  } catch (error) {
    console.error('Resolve Client Package Checks Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// [CLIENT] LIST A CLIENT'S OWN STOPPED WORKORDERS / CHECKS
//   GET /api/client/workorders/stopped/list?clientCode=..&clientId=..&portalEmail=..
//   Scoped equivalent of GET /api/workorders/stopped/list above — powers
//   the client-facing ClientStoppedManagement.jsx screen so a client only
//   ever sees their own stopped records.
// ====================================================================
router.get(`${API_BASE}/client/workorders/stopped/list`, async (req, res) => {
  try {
    const clientId = (req.query.clientId || '').toString().trim();
    const clientCode = (req.query.clientCode || '').toString().trim();
    const portalEmail = (req.query.portalEmail || '').toString().trim();

    if (!clientId && !clientCode && !portalEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientId, clientCode or portalEmail is required.',
      });
    }

    const orConds = [];
    if (clientId) orConds.push({ 'createdBy.clientId': clientId });
    if (clientCode) orConds.push({ 'createdBy.clientCode': clientCode });
    if (portalEmail) orConds.push({ 'createdBy.portalEmail': portalEmail });

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({
        origin: 'client',
        $and: [{ $or: orConds }, { $or: [{ stopped: true }, { 'checks.stopped': true }] }],
      })
      .sort({ updatedAt: -1 })
      .toArray();

    const stoppedWorkorders = [];
    const stoppedChecks = [];

    workorders.forEach((wo) => {
      if (wo.stopped) {
        stoppedWorkorders.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          candidateName: wo.fullName || '',
          client: wo.client || '',
          stopReason: wo.stopReason || '',
          stoppedAt: wo.stoppedAt || null,
          stoppedBy: wo.stoppedBy || null,
          paymentDue: !!wo.paymentDue,
          checkCount: Array.isArray(wo.checks) ? wo.checks.length : 0,
        });
      }
      (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
        if (!c.stopped) return;
        stoppedChecks.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          candidateName: wo.fullName || '',
          client: wo.client || '',
          slNo: c.slNo,
          checkType: c.checkType || '',
          subType: c.subType || '',
          stopReason: c.stopReason || '',
          stoppedAt: c.stoppedAt || null,
          stoppedBy: c.stoppedBy || null,
          paymentDue: !!c.paymentDue,
          partOfWorkorderStop: !!wo.stopped,
        });
      });
    });

    res.json({ success: true, stoppedWorkorders, stoppedChecks });
  } catch (error) {
    console.error('List Client Stopped Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* ####################################################################
   ##       Employee WORKORDER Assignment API                        ##
   #################################################################### */

router.get(`${API_BASE}/employees`, async (req, res) => {
  try {
    const employees = await req.db
      .collection(EMPLOYEE_COLLECTION)
      .find({})
      .project({ password: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      employees: employees.map((e) => ({ ...e, _id: e._id.toString() })),
    });
  } catch (error) {
    console.error('Get Employees Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/vendors`, async (req, res) => {
  try {
    const vendors = await req.db
      .collection(VENDOR_COLLECTION)
      .find({})
      .project({ portalPassword: 0 })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      vendors: vendors.map((v) => ({ ...v, _id: v._id.toString() })),
    });
  } catch (error) {
    console.error('Get Vendors Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/workorder-assignment/:workorderId`, async (req, res) => {
  try {
    const { workorderId } = req.params;

    const assignment = await req.db
      .collection(ASSIGNMENT_COLLECTION)
      .findOne({ workorderId, status: 'assigned' }, { sort: { assignedAt: -1 } });

    res.json({ success: true, assignment: assignment || null });
  } catch (error) {
    console.error('Get Assignment Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get(`${API_BASE}/workorder-assignment`, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};

    const assignments = await req.db
      .collection(ASSIGNMENT_COLLECTION)
      .find(filter)
      .sort({ assignedAt: -1 })
      .toArray();

    res.json({ success: true, assignments });
  } catch (error) {
    console.error('List Assignments Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(`${API_BASE}/workorder-assignment`, async (req, res) => {
  try {
    const {
      workorderId,
      bgvRef,
      candidateName,
      assignmentType,
      assignedToId,
      assignedToName,
      notes,
      slaDays,
      slaDeadline,
      assignedBy,
    } = req.body;

    if (!workorderId || !assignmentType || !assignedToId) {
      return res.status(400).json({
        success: false,
        message: 'workorderId, assignmentType and assignedToId are required',
      });
    }

    if (!['internal', 'external'].includes(assignmentType)) {
      return res.status(400).json({
        success: false,
        message: "assignmentType must be 'internal' or 'external'",
      });
    }

    const now = new Date();

    const assignmentPayload = {
      workorderId,
      bgvRef: bgvRef || null,
      candidateName: candidateName || null,
      assignmentType,
      assignedToId,
      assignedToName: assignedToName || null,
      notes: notes || '',
      slaDays: slaDays || 7,
      slaDeadline: slaDeadline ? new Date(slaDeadline) : null,
      status: 'assigned',
      assignedBy: assignedBy || null,
      updatedAt: now,
    };

    const existing = await req.db
      .collection(ASSIGNMENT_COLLECTION)
      .findOne({ workorderId, status: 'assigned' });

    let savedAssignment;

    if (existing) {
      await req.db
        .collection(ASSIGNMENT_COLLECTION)
        .updateOne({ _id: existing._id }, { $set: { ...assignmentPayload, assignedAt: now } });

      savedAssignment = await req.db
        .collection(ASSIGNMENT_COLLECTION)
        .findOne({ _id: existing._id });
    } else {
      const insertResult = await req.db.collection(ASSIGNMENT_COLLECTION).insertOne({
        ...assignmentPayload,
        assignedAt: now,
        createdAt: now,
      });

      savedAssignment = await req.db
        .collection(ASSIGNMENT_COLLECTION)
        .findOne({ _id: insertResult.insertedId });
    }

    await syncWorkorderAssignment(req.db, workorderId, {
      assignedTo: assignedToName,
      assignedToId,
      assignmentType,
      status: 'in-progress',
    });

    res.json({
      success: true,
      message: existing ? 'Check reassigned successfully' : 'Check assigned successfully',
      assignment: savedAssignment,
    });
  } catch (error) {
    console.error('Assign Check Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// ====================================================================
// BULK WORKORDER UPLOAD
// POST /api/workorder-assignment/bulk
// ====================================================================
const BULK_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'bulk-temp');
if (!fs.existsSync(BULK_UPLOAD_DIR)) fs.mkdirSync(BULK_UPLOAD_DIR, { recursive: true });

const bulkUpload = multer({
 storage: multer.diskStorage({
 destination: (req, file, cb) => cb(null, BULK_UPLOAD_DIR),
 filename: (req, file, cb) => {
 const ext = path.extname(file.originalname) || '.xlsx';
 cb(null, `bulk-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
 },
 }),
 fileFilter: (req, file, cb) => {
 const ext = path.extname(file.originalname).toLowerCase();
 if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
 cb(new Error('Only .xlsx, .xls, .csv files allowed.'));
 },
 limits: { fileSize: 10 * 1024 * 1024 },
});

function parseBulkCSVLine(line) {
 const result = []; let current = ''; let inQuotes = false;
 for (let i = 0; i < line.length; i++) {
 const ch = line[i];
 if (inQuotes) {
 if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
 else if (ch === '"') { inQuotes = false; }
 else { current += ch; }
 } else {
 if (ch === '"') { inQuotes = true; }
 else if (ch === ',') { result.push(current); current = ''; }
 else { current += ch; }
 }
 }
 result.push(current);
 return result;
}
router.post(`${API_BASE}/workorder-assignment/bulk`, bulkUpload.single('file'), async (req, res) => {
 console.log('═══════════════════════════════════════');
 console.log('[BULK] Request received');
 console.log('[BULK] File:', req.file ? req.file.originalname : 'NONE');
 console.log('[BULK] Client:', req.body.companyName || req.body.clientCode || 'UNKNOWN');

 try {
 if (!req.file) {
 return res.status(400).json({ success: false, message: 'No file uploaded.' });
 }

 let rows = [];
 const filePath = req.file.path;
 const ext = path.extname(req.file.originalname).toLowerCase();

 try {
 if (ext === '.csv') {
 const content = fs.readFileSync(filePath, 'utf-8');
 const lines = content.split(/\r?\n/).filter(l => l.trim());
 if (lines.length < 2) {
 return res.status(400).json({ success: false, message: 'CSV must have header + at least 1 data row.' });
 }
 const headers = parseBulkCSVLine(lines[0]);
 for (let i = 1; i < lines.length; i++) {
 const values = parseBulkCSVLine(lines[i]);
 const row = {};
 headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
 rows.push(row);
 }
 } else {
 const workbook = XLSX.readFile(filePath);
 const worksheet = workbook.Sheets[workbook.SheetNames[0]];
 rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
 rows = rows.map(row => {
 const cleaned = {};
 Object.keys(row).forEach(key => {
 cleaned[key.trim()] = typeof row[key] === 'string' ? row[key].trim() : row[key];
 });
 return cleaned;
 });
 }
 } catch (parseErr) {
 console.error('[BULK] Parse error:', parseErr.message);
 return res.status(400).json({ success: false, message: `File parse error: ${parseErr.message}` });
 }

 if (rows.length === 0) {
 return res.status(400).json({ success: false, message: 'No data rows found in file.' });
 }
 console.log(`[BULK] Parsed ${rows.length} rows`);

 const results = { created: 0, failed: 0, errors: [], workorderIds: [] };
 const yesValues = ['yes', 'y', 'true', '1', 'required'];

 const checkMappings = [
 { field: 'isAddressPresentRequired', name: 'Address Verification - Present' },
 { field: 'isAddressPermanentRequired', name: 'Address Verification - Permanent' },
 { field: 'isEducationPgRequired', name: 'Education Verification - PG' },
 { field: 'isEducationUgRequired', name: 'Education Verification - UG' },
 { field: 'isEducationDiplomaRequired', name: 'Education Verification - Diploma' },
 { field: 'isEducation12thRequired', name: 'Education Verification - 12th' },
 { field: 'isEducation10thRequired', name: 'Education Verification - 10th' },
 { field: 'isEmploymentLatestRequired', name: 'Employment Verification - Latest' },
 { field: 'isCriminalPresentRequired', name: 'Criminal Check - Present' },
 { field: 'isCriminalPermanentRequired', name: 'Criminal Check - Permanent' },
 { field: 'isCourtPresentRequired', name: 'Court Record Check - Present' },
 { field: 'isCourtPermanentRequired', name: 'Court Record Check - Permanent' },
 { field: 'isDrugPanel10Required', name: 'Drug Test - Panel 10' },
 { field: 'isDrugPanel5Required', name: 'Drug Test - Panel 5' },
 { field: 'isDrugPanel4Required', name: 'Drug Test - Panel 4' },
 { field: 'isDrugPanel3Required', name: 'Drug Test - Panel 3' },
 { field: 'isDrugPanel2Required', name: 'Drug Test - Panel 2' },
 { field: 'isIdPanCardRequired', name: 'ID Verification - PAN Card' },
 { field: 'isIdDrivingLicenseRequired', name: 'ID Verification - Driving License' },
 { field: 'isIdVoterIdRequired', name: 'ID Verification - Voter ID' },
 { field: 'isIdAadharIdRequired', name: 'ID Verification - Aadhar' },
 { field: 'isIdPassportIdRequired', name: 'ID Verification - Passport' },
 ];

 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 const rowNum = i + 2;
 const rowKeys = Object.keys(row);

 // Case-insensitive field getter
 const getField = (fieldName) => {
 const key = rowKeys.find(k => k.toLowerCase() === fieldName.toLowerCase());
 return key ? String(row[key] || '').trim() : '';
 };

 try {
 const candidateName = getField('candidateName');
 if (!candidateName) {
 results.failed++;
 results.errors.push(`Row ${rowNum}: Missing candidateName. Your columns: ${rowKeys.join(', ')}`);
 continue;
 }

 const checks = [];
 checkMappings.forEach(mapping => {
 const val = getField(mapping.field).toLowerCase();
 if (yesValues.includes(val)) {
 let count = 1;
 if (mapping.field.toLowerCase() === 'isemploymentlatestrequired') {
 count = parseInt(getField('totalEmploymentToBeVerify')) || 1;
 }
 checks.push({
 slNo: checks.length + 1,
 checkType: mapping.name,
 checkTypeId: '', subType: '', count,
 fields: [], data: {}, status: 'pending', notes: '',
 assignedTo: '', assignedToId: null, assignedToEmail: '',
 assignmentType: null, slaDeadline: null, assignedAt: null, completedAt: null,
 previousStatus: null, insufficiencyDescription: '',
 insufficiencyRaisedAt: null, insufficiencyClearedAt: null,
 holdPreviousStatus: null, holdReason: '', holdRaisedAt: null,
 holdClearedAt: null, holdRaisedBy: null,
 stopped: false, stoppedAt: null, stopReason: '',
 stoppedBy: null, paymentDue: false, previousStatusBeforeStop: null,
 });
 }
 });

 const refCount = parseInt(getField('numberOfReferences')) || 0;
 if (refCount > 0) {
 checks.push({
 slNo: checks.length + 1,
 checkType: 'Reference Check',
 checkTypeId: '', subType: '', count: refCount,
 fields: [], data: {}, status: 'pending', notes: '',
 assignedTo: '', assignedToId: null, assignedToEmail: '',
 assignmentType: null, slaDeadline: null, assignedAt: null, completedAt: null,
 previousStatus: null, insufficiencyDescription: '',
 insufficiencyRaisedAt: null, insufficiencyClearedAt: null,
 holdPreviousStatus: null, holdReason: '', holdRaisedAt: null,
 holdClearedAt: null, holdRaisedBy: null,
 stopped: false, stoppedAt: null, stopReason: '',
 stoppedBy: null, paymentDue: false, previousStatusBeforeStop: null,
 });
 }

 const bgvRef = await generateBgvRef(req.db);
 const now = new Date();
 const createdBy = buildCreatedBy({ ...req.body, origin: req.body.origin || 'client' }, 'client');

 const doc = {
 fullName: candidateName,
 email: getField('emailId') || getField('email'),
 phone: getField('phoneNumber') || getField('phone'),
 client: req.body.companyName || req.body.clientCode || '',
 branch: '', packageName: '', priority: 'Standard',
 clientRef: req.body.clientCode || '',
 initiationMode: 'Bulk Upload',
 checks: normalizeChecks(checks),
 candidateDetails: {
 fatherName: getField('fatherName'),
 gender: getField('gender'),
 dob: getField('dob'),
 placeOfJoin: getField('placeOfJoin'),
 },
 documents: [], status: 'pending', assignedTo: '', target: '',
 locked: false, lockedAt: null, lockedBy: null,
 casePreviousStatus: null, caseHoldReason: '',
 caseHoldRaisedAt: null, caseHoldClearedAt: null, caseHoldRaisedBy: null,
 stopped: false, stoppedAt: null, stopReason: '',
 stoppedBy: null, paymentDue: false, previousStatusBeforeWorkorderStop: null,
 createdBy, origin: 'client', bgvRef,
 bulkUploadRef: now.toISOString(),
 createdAt: now, updatedAt: now,
 };

 const result = await req.db.collection(WORKORDER_COLLECTION).insertOne(doc);
 results.created++;
 results.workorderIds.push(result.insertedId.toString());

 notifySupporterOfNewWorkorder(req.db, {
 clientRef: doc.client, bgvRef,
 candidateName: doc.fullName,
 workorderId: result.insertedId.toString(),
 });

 } catch (rowErr) {
 results.failed++;
 results.errors.push(`Row ${rowNum} (${getField('candidateName') || 'unknown'}): ${rowErr.message}`);
 console.error(`[BULK] Row ${rowNum} error:`, rowErr.message);
 }
 }

 try { fs.unlinkSync(filePath); } catch (e) {
 console.warn('[BULK] Temp cleanup failed:', e.message);
 }

 console.log(`[BULK] Done: ${results.created} created, ${results.failed} failed`);

 return res.status(200).json({
 success: true,
 message: `Bulk upload complete: ${results.created} created, ${results.failed} failed`,
 total: rows.length,
 created: results.created,
 failed: results.failed,
 errors: results.errors,
 workorderIds: results.workorderIds,
 });

 } catch (serverErr) {
 console.error('[BULK] SERVER ERROR:', serverErr);
 return res.status(500).json({
 success: false,
 message: 'Internal server error during bulk upload.',
 errors: [serverErr.message],
 });
 }
});


router.put(`${API_BASE}/workorder-assignment/:workorderId/unassign`, async (req, res) => {
  try {
    const { workorderId } = req.params;
    const { unassignedBy, reason } = req.body || {};

    const existing = await req.db
      .collection(ASSIGNMENT_COLLECTION)
      .findOne({ workorderId, status: 'assigned' });

    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: 'No active assignment found for this workorder' });
    }

    const now = new Date();

    const result = await req.db.collection(ASSIGNMENT_COLLECTION).findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          status: 'unassigned',
          unassignedAt: now,
          unassignedBy: unassignedBy || null,
          unassignReason: reason || null,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    const updatedDoc = result?.value || result;

    await syncWorkorderAssignment(req.db, workorderId, {
      assignedTo: '',
      assignedToId: null,
      assignmentType: null,
      status: 'ready-for-assignment',
    });

    res.json({ success: true, message: 'Check unassigned successfully', assignment: updatedDoc });
  } catch (error) {
    console.error('Unassign Check Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(`${API_BASE}/workorder-assignment/insufficiency`, async (req, res) => {
  try {
    const { workorderId, bgvRef, candidateName, description, docType, raisedBy } = req.body;

    if (!workorderId || !description || !docType) {
      return res.status(400).json({
        success: false,
        message: 'workorderId, description and docType are required',
      });
    }

    const now = new Date();

    const insertResult = await req.db.collection(INSUFFICIENCY_COLLECTION).insertOne({
      workorderId,
      bgvRef: bgvRef || null,
      candidateName: candidateName || null,
      description,
      docType,
      status: 'pending',
      raisedBy: raisedBy || null,
      createdAt: now,
      updatedAt: now,
    });

    await req.db
      .collection(ASSIGNMENT_COLLECTION)
      .updateOne(
        { workorderId, status: 'assigned' },
        { $set: { hasOpenInsufficiency: true, updatedAt: now } }
      );

    const inserted = await req.db
      .collection(INSUFFICIENCY_COLLECTION)
      .findOne({ _id: insertResult.insertedId });

    res.json({ success: true, message: 'Insufficiency raised successfully', insufficiency: inserted });
  } catch (error) {
    console.error('Raise Insufficiency Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
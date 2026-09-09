// routes/workorderRoutes.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const {
 sendCandidateInviteEmail,
 sendNewWorkorderSupporterNotification,
 sendCheckHoldNotification,
 sendCaseHoldNotification,
 sendStopCheckNotification,
 sendStopWorkorderNotification,
} = require('../config/emailservice');

const API_BASE = '/api';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const CHECKTYPE_COLLECTION = 'checktype-creation';
const CLIENT_COLLECTION = 'client-details';
const PACKAGE_COLLECTION = 'package-creation';
const EMPLOYEE_COLLECTION = 'employee_login';
const VENDOR_COLLECTION = 'vendors';
const ASSIGNMENT_COLLECTION = 'Workorder-Assignment';
const INSUFFICIENCY_COLLECTION = 'Workorder-Insufficiency';

// ====================================================================
// FILE UPLOAD (multer) [SHARED — used by both employee & client]
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
 const ok = allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
 if (ok) return cb(null, true);
 cb(new Error('Only JPG, PNG and PDF files are allowed.'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const singleDocUpload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const documentFields = [
 { name: 'passportPhoto', maxCount: 1 },
 { name: 'aadhaarFile', maxCount: 1 },
 { name: 'panFile', maxCount: 1 },
 { name: 'passportFile', maxCount: 1 },
 { name: 'dlFile', maxCount: 1 },
 { name: 'otherDocFile', maxCount: 1 },
];

// ====================================================================
// BULK UPLOAD (memory storage for CSV / XLSX)
// ====================================================================
const bulkUpload = multer({
 storage: multer.memoryStorage(),
 limits: { fileSize: 5 * 1024 * 1024 },
 fileFilter: (req, file, cb) => {
 const ext = path.extname(file.originalname).toLowerCase();
 if (['.csv', '.xlsx', '.xls'].includes(ext)) return cb(null, true);
 cb(new Error('Only CSV and XLSX files are allowed.'));
 },
});

// ---- Helpers [SHARED] ----
const isValidId = (id) => {
 try { return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id); } catch { return false; }
};

const toObjectIdSafe = (id) => {
 try { return new ObjectId(id); } catch { return null; }
};

const shapeWorkorder = (doc) => {
 if (!doc) return null;
 return { ...doc, _id: doc._id ? doc._id.toString() : undefined };
};

// --------------------------------------------------------------------
// SUPPORTER EMAIL RESOLUTION [SHARED]
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
 const match = employees.find((e) => employeeDisplayName(e).toLowerCase().trim() === String(supporterName).toLowerCase().trim());
 return match?.email || '';
 } catch (err) { console.error('findSupporterEmail error:', err.message); return ''; }
};

const findClientDoc = async (db, clientRef) => {
 if (!clientRef) return null;
 try {
 if (isValidId(clientRef)) { const byId = await db.collection(CLIENT_COLLECTION).findOne({ _id: new ObjectId(clientRef) }); if (byId) return byId; }
 return await db.collection(CLIENT_COLLECTION).findOne({ $or: [{ companyName: clientRef }, { clientCode: clientRef }, { displayName: clientRef }] });
 } catch (err) { console.error('findClientDoc error:', err.message); return null; }
};

const notifySupporterOfNewWorkorder = (db, { clientRef, bgvRef, candidateName, workorderId }) => {
 (async () => {
 try {
 const clientDoc = await findClientDoc(db, clientRef);
 const supporterEmail = clientDoc ? await findSupporterEmail(db, clientDoc.customerSupporter) : '';
 await sendNewWorkorderSupporterNotification({ supporterEmail, clientName: clientDoc?.companyName || clientRef, bgvRef, candidateName, workorderId });
 } catch (err) { console.error('notifySupporterOfNewWorkorder failed:', err.message); }
 })();
};

// --------------------------------------------------------------------
// CREATOR TRACKING [SHARED]
// --------------------------------------------------------------------
const VALID_ORIGINS = ['employee', 'client'];

const buildCreatedBy = (body = {}, fallbackOrigin = 'employee') => {
 const incoming = body.createdBy && typeof body.createdBy === 'object' ? body.createdBy : {};
 let origin = (incoming.origin || body.origin || body.creatorRole || '').toString().trim().toLowerCase();
 const hasClientIdentity = !!(incoming.clientCode || body.clientCode || incoming.portalEmail || body.portalEmail || incoming.clientId || body.clientId);
 if (!VALID_ORIGINS.includes(origin)) { origin = hasClientIdentity ? 'client' : fallbackOrigin; }
 if (!VALID_ORIGINS.includes(origin)) origin = 'employee';
 return {
 origin, userId: (incoming.userId || body.creatorId || '').toString().trim(), name: (incoming.name || body.creatorName || '').toString().trim(),
 email: (incoming.email || body.creatorEmail || '').toString().trim(), role: (incoming.role || '').toString().trim(),
 clientCode: (incoming.clientCode || body.clientCode || '').toString().trim(), clientId: (incoming.clientId || body.clientId || '').toString().trim(),
 portalEmail: (incoming.portalEmail || body.portalEmail || '').toString().trim(), branchName: (incoming.branchName || body.branchName || '').toString().trim(),
 createdAt: new Date(),
 };
};

const normalizeCheck = (c, i) => ({
 slNo: i + 1, checkType: c.checkType || '', checkTypeId: c.checkTypeId || '', subType: c.subType || '', subCheckId: c.subCheckId || null,
 infoNeeded: c.infoNeeded || 'Candidate', count: Number(c.count) || 1, fields: Array.isArray(c.fields) ? c.fields : [],
 data: c.data && typeof c.data === 'object' ? c.data : {}, status: c.status || 'pending', notes: c.notes || '',
 assignedTo: c.assignedTo || '', assignedToId: c.assignedToId || null, assignedToEmail: c.assignedToEmail || '',
 assignmentType: c.assignmentType || null, slaDeadline: c.slaDeadline || null, assignedAt: c.assignedAt || null, completedAt: c.completedAt || null,
 previousStatus: c.previousStatus || null, insufficiencyDescription: c.insufficiencyDescription || '',
 insufficiencyRaisedAt: c.insufficiencyRaisedAt || null, insufficiencyClearedAt: c.insufficiencyClearedAt || null,
 holdPreviousStatus: c.holdPreviousStatus || null, holdReason: c.holdReason || '', holdRaisedAt: c.holdRaisedAt || null,
 holdClearedAt: c.holdClearedAt || null, holdRaisedBy: c.holdRaisedBy || null,
 stopped: !!c.stopped, stoppedAt: c.stoppedAt || null, stopReason: c.stopReason || '', stoppedBy: c.stoppedBy || null,
 paymentDue: c.paymentDue !== undefined ? !!c.paymentDue : false, previousStatusBeforeStop: c.previousStatusBeforeStop || null,
});

const normalizeChecks = (checks) => Array.isArray(checks) ? checks.map(normalizeCheck) : [];

const buildWorkorderDoc = (body) => {
 const { fullName = '', email = '', phone = '', client = '', branch = '', packageName = '', priority = 'Standard', clientRef = '', initiationMode = 'Candidate', checks = [], candidateDetails = {}, status = 'draft', assignedTo = '', target = '' } = body || {};
 return {
 fullName: String(fullName).trim(), email: String(email).trim(), phone: String(phone).trim(), client: String(client).trim(),
 branch: String(branch).trim(), packageName: String(packageName).trim(), priority: String(priority).trim() || 'Standard',
 clientRef: String(clientRef).trim(), initiationMode: String(initiationMode).trim() || 'Candidate', checks: normalizeChecks(checks),
 candidateDetails: candidateDetails || {}, documents: [], status: status || 'draft', assignedTo: String(assignedTo).trim(), target: target || '',
 locked: false, lockedAt: null, lockedBy: null,
 casePreviousStatus: null, caseHoldReason: '', caseHoldRaisedAt: null, caseHoldClearedAt: null, caseHoldRaisedBy: null,
 stopped: false, stoppedAt: null, stopReason: '', stoppedBy: null, paymentDue: false, previousStatusBeforeWorkorderStop: null,
 };
};

const generateBgvRef = async (db) => {
 const year = new Date().getFullYear();
 const prefix = `BGV-${year}-`;
 const last = await db.collection(WORKORDER_COLLECTION).find({ bgvRef: { $regex: `^${prefix}` } }).sort({ bgvRef: -1 }).limit(1).toArray();
 let nextSeq = 1;
 if (last.length && last[0].bgvRef) { const seq = parseInt(last[0].bgvRef.split('-')[2], 10); if (!isNaN(seq)) nextSeq = seq + 1; }
 return `${prefix}${String(nextSeq).padStart(5, '0')}`;
};

const computeProgress = (wo) => {
 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const total = Math.max(checks.length, 1);
 let done = checks.filter((c) => (c.data && Object.keys(c.data).length > 0) || c.status === 'completed').length;
 if (checks.length === 0) { const cd = wo.candidateDetails || {}; done = cd && Object.keys(cd).length > 0 ? 1 : 0; }
 return { done, total };
};

const shapeCheckFromMaster = (master) => {
 if (!master) return null;
 const rawFields = master.fields || master.formFields || master.customFields || master.checkFields || [];
 const fields = Array.isArray(rawFields) ? rawFields.map((f) => {
 if (typeof f === 'string') return { name: f, label: f, type: 'text' };
 return { name: f.name || f.key || f.fieldName || f.label, label: f.label || f.name || f.key || 'Field', type: f.type || f.fieldType || 'text', required: !!f.required, options: f.options || f.choices || [], placeholder: f.placeholder || '' };
 }).filter((f) => f.name) : [];
 const subType = (Array.isArray(master.subChecks) && master.subChecks[0]) || (Array.isArray(master.subCheckTypes) && master.subCheckTypes[0]) || master.subType || '';
 return { checkTypeId: master._id ? master._id.toString() : '', checkCode: master.code || '', checkType: master.name || master.checkTypeName || master.checkType || 'Check', subType, subChecks: Array.isArray(master.subChecks) ? master.subChecks : [], infoNeeded: master.infoNeeded || master.infoSource || 'Candidate', sla: master.sla ?? null, fieldVisit: !!master.fieldVisit, digital: !!master.digital, count: 1, fields, data: {}, status: 'pending', notes: '' };
};

const syncWorkorderAssignment = async (db, workorderId, { assignedTo, assignedToId, assignmentType, status }) => {
 const objectId = toObjectIdSafe(workorderId);
 await db.collection(WORKORDER_COLLECTION).updateOne({ _id: objectId || workorderId }, { $set: { assignedTo: assignedTo ?? '', assignedToId: assignedToId ?? null, assignmentType: assignmentType ?? null, ...(status ? { status } : {}), updatedAt: new Date() } });
};

const PAYMENT_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
const isPaymentDue = (createdAt) => { if (!createdAt) return true; return Date.now() - new Date(createdAt).getTime() > PAYMENT_GRACE_WINDOW_MS; };
const paymentGraceExpiresAt = (createdAt) => createdAt ? new Date(new Date(createdAt).getTime() + PAYMENT_GRACE_WINDOW_MS) : null;
const paymentPolicyNote = (paymentDue) => paymentDue ? 'This action is being taken after the 24-hour payment-review window from workorder creation. As per Verifitech policy, payment is due for the verification work already initiated on this record.' : 'This action is within the 24-hour payment-review window from workorder creation. As per Verifitech policy, no payment is due for this stop.';

/* ####################################################################
 ## EMPLOYEE WORKORDER API ##
 #################################################################### */

router.get(`${API_BASE}/checktypes`, async (req, res) => {
 try {
 const checkTypes = await req.db.collection(CHECKTYPE_COLLECTION).find({}).sort({ sortOrder: 1, createdAt: -1 }).toArray();
 res.json({ success: true, checkTypes: checkTypes.map((c) => ({ ...c, _id: c._id.toString() })) });
 } catch (error) { console.error('Get Check Types Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.post(`${API_BASE}/workorders`, async (req, res) => {
 try {
 const doc = buildWorkorderDoc(req.body);
 if (!doc.fullName || !doc.email || !doc.phone) return res.status(400).json({ success: false, message: 'Full name, email and phone are required.' });
 if (!doc.client) return res.status(400).json({ success: false, message: 'Client is required.' });
 const forcedOrigin = (req.query.as || '').toString().trim().toLowerCase();
 const fallback = VALID_ORIGINS.includes(forcedOrigin) ? forcedOrigin : 'employee';
 const createdBy = buildCreatedBy(forcedOrigin ? { ...req.body, origin: forcedOrigin } : req.body, fallback);
 const bgvRef = await generateBgvRef(req.db);
 const now = new Date();
 const payload = { ...doc, createdBy, origin: createdBy.origin, bgvRef, createdAt: now, updatedAt: now };
 const result = await req.db.collection(WORKORDER_COLLECTION).insertOne(payload);
 const saved = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: result.insertedId });
 if (createdBy.origin === 'client') { notifySupporterOfNewWorkorder(req.db, { clientRef: doc.client, bgvRef, candidateName: doc.fullName, workorderId: result.insertedId.toString() }); }
 res.status(201).json({ success: true, message: `Workorder saved as draft (created by ${createdBy.origin}).`, workorder: shapeWorkorder(saved) });
 } catch (error) { console.error('Create Workorder Error:', error); res.status(500).json({ success: false, message: error.message }); }
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
 const workorders = await req.db.collection(WORKORDER_COLLECTION).find(query).sort({ createdAt: -1 }).toArray();

 let clientNameById = new Map();
 try {
 const rawClientIds = [...new Set(workorders.map((w) => { const c = w.client; return c && typeof c === 'string' && isValidId(c) ? c : null; }).filter(Boolean))];
 if (rawClientIds.length > 0) {
 const clients = await req.db.collection(CLIENT_COLLECTION).find({ _id: { $in: rawClientIds.map((id) => new ObjectId(id)) } }).toArray();
 clientNameById = new Map(clients.map((c) => [c._id.toString(), c.companyName || c.displayName || c.name || 'Unnamed Client']));
 }
 } catch (lookupErr) { console.error('Client name lookup error:', lookupErr.message); }

 const shaped = workorders.map((wo) => {
 const p = computeProgress(wo);
 const clientId = wo.client && typeof wo.client === 'string' ? wo.client : '';
 const resolvedClientName = clientId && clientNameById.has(clientId) ? clientNameById.get(clientId) : wo.clientName || wo.client || '—';
 return { ...shapeWorkorder(wo), progressDone: p.done, progressTotal: p.total, client: resolvedClientName, companyName: resolvedClientName };
 });

 const stats = {
 total: shaped.length, active: shaped.filter((w) => w.status !== 'completed' && w.status !== 'cancelled' && w.status !== 'overdue').length,
 completed: shaped.filter((w) => w.status === 'completed').length, overdue: shaped.filter((w) => w.status === 'overdue').length,
 onHold: shaped.filter((w) => w.status === 'on-hold').length, stopped: shaped.filter((w) => w.stopped).length,
 byEmployee: shaped.filter((w) => w.origin === 'employee').length, byClient: shaped.filter((w) => w.origin === 'client').length,
 };
 res.json({ success: true, workorders: shaped, stats });
 } catch (error) { console.error('List Workorders Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.get(`${API_BASE}/workorders/assignment-view`, async (req, res) => {
 try {
 const rawWorkorders = await req.db.collection(WORKORDER_COLLECTION).find({}).sort({ createdAt: -1 }).toArray();
 let clientNameById = new Map();
 try {
 const rawClientIds = [...new Set(rawWorkorders.map((w) => (w.client ? w.client.toString() : null)).filter(Boolean))];
 if (rawClientIds.length > 0) {
 const clients = await req.db.collection(CLIENT_COLLECTION).find({ _id: { $in: rawClientIds } }).toArray();
 clientNameById = new Map(clients.map((c) => [c._id.toString(), c.companyName || c.displayName || c.name || 'Unnamed Client']));
 }
 } catch (lookupErr) { console.error('Client lookup error:', lookupErr.message); }

 const workorders = rawWorkorders.map((w) => {
 const checks = Array.isArray(w.checks) ? w.checks : [];
 const totalChecks = checks.length || 1;
 const completedChecks = checks.filter((c) => ['completed', 'done', 'verified'].includes((c.status || '').toLowerCase())).length;
 const clientId = w.client && w.client.toString ? w.client.toString() : w.client;
 return {
 _id: w._id.toString(), bgvRef: w.bgvRef || null,
 candidateName: w.fullName || w.candidateName || w.candidateDetails?.nameOnAadhaar || w.candidateDetails?.name || 'Unnamed Candidate',
 client: clientNameById.get(clientId) || w.client || 'Unknown Client', package: w.packageName || w.package || '—',
 status: w.status || 'draft', progress: { current: completedChecks, total: totalChecks },
 assigned: w.assignedTo && String(w.assignedTo).trim() !== '' ? (typeof w.assignedTo === 'object' ? w.assignedTo.name || w.assignedTo.companyName || 'Assigned' : w.assignedTo) : 'Unassigned',
 createdAt: w.createdAt || null, updatedAt: w.updatedAt || null,
 };
 });
 res.json({ success: true, workorders, debug: { clientResolutionCount: clientNameById.size } });
 } catch (error) { console.error('Get Workorders (assignment-view) Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.get(`${API_BASE}/workorders/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 res.json({ success: true, workorder: shapeWorkorder(wo) });
 } catch (error) { console.error('Get Workorder Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const existing = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!existing) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 if (existing.locked) return res.status(423).json({ success: false, message: 'This workorder is finalized and cannot be edited. Unlock it first.' });
 const updateFields = { updatedAt: new Date() };
 const allowed = ['fullName', 'email', 'phone', 'client', 'branch', 'packageName', 'priority', 'clientRef', 'initiationMode', 'checks', 'candidateDetails', 'status', 'assignedTo', 'target'];
 allowed.forEach((key) => { if (req.body[key] !== undefined) { if (key === 'checks') updateFields.checks = normalizeChecks(req.body.checks); else updateFields[key] = req.body[key]; } });
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateFields }, { returnDocument: 'after' });
 const updated = result?.value || result;
 if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 res.json({ success: true, message: 'Workorder updated.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Update Workorder Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id/lock`, async (req, res) => {
 try {
 const { id } = req.params; const { locked } = req.body;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 if (typeof locked !== 'boolean') return res.status(400).json({ success: false, message: '`locked` must be true or false.' });
 const now = new Date();
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { locked, lockedAt: locked ? now : null, lockedBy: locked ? (req.user?._id || null) : null, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 res.json({ success: true, message: locked ? 'Workorder finalized.' : 'Workorder unlocked.', locked, workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Lock Workorder Error:', error); res.status(500).json({ success: false, message: error.message }); }
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
 if (req.body.data && typeof req.body.data === 'object') checks[idx].data = { ...(checks[idx].data || {}), ...req.body.data };
 if (req.body.status !== undefined) checks[idx].status = req.body.status;
 if (req.body.notes !== undefined) checks[idx].notes = req.body.notes;
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checks, updatedAt: new Date() } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 res.json({ success: true, message: 'Check updated.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Update Check Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.post(`${API_BASE}/workorders/:id/checks/:slNo/documents`, upload.any(), async (req, res) => {
 try {
 const { id, slNo } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const exists = checks.some((c) => String(c.slNo) === String(slNo));
 if (!exists) return res.status(404).json({ success: false, message: 'Check not found.' });
 const files = req.files || [];
 const saved = files.map((f) => ({ fieldname: f.fieldname, url: `/uploads/candidates/${f.filename}`, originalName: f.originalname }));
 res.json({ success: true, files: saved });
 } catch (error) { console.error('Upload Check Document Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.post(`${API_BASE}/workorders/:id/documents`, singleDocUpload.single('file'), async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
 const documentType = (req.body.documentType || 'Other').toString().trim();
 const checkSlNo = req.body.checkSlNo ? String(req.body.checkSlNo).trim() : null;
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const docEntry = { id: new ObjectId().toString(), documentType, checkSlNo, url: `/uploads/candidates/${req.file.filename}`, originalName: req.file.originalname, uploadedAt: new Date() };
 const documents = Array.isArray(wo.documents) ? [...wo.documents] : [];
 documents.push(docEntry);
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { documents, updatedAt: new Date() } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 res.status(201).json({ success: true, message: 'Document uploaded successfully.', document: docEntry, workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Upload Workorder Document Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.get(`${API_BASE}/workorders/:id/documents`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 res.json({ success: true, documents: Array.isArray(wo.documents) ? wo.documents : [] });
 } catch (error) { console.error('List Workorder Documents Error:', error); res.status(500).json({ success: false, message: error.message }); }
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
 if (!target) return res.status(404).json({ success: false, message: 'Document not found.' });
 if (target.url) { const filePath = path.join(__dirname, '..', target.url.replace(/^\//, '')); fs.unlink(filePath, (err) => { if (err) console.warn('Could not delete physical file:', filePath, err.message); }); }
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { documents, updatedAt: new Date() } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 res.json({ success: true, message: 'Document removed successfully.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Delete Workorder Document Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id/candidate`, upload.fields(documentFields), async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 let candidateDetails = {};
 if (req.body.candidateDetails) { try { candidateDetails = typeof req.body.candidateDetails === 'string' ? JSON.parse(req.body.candidateDetails) : req.body.candidateDetails; } catch { candidateDetails = {}; } }
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
 const updateFields = { candidateDetails, status: req.body.status || 'candidate-details', updatedAt: new Date() };
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateFields }, { returnDocument: 'after' });
 const updated = result?.value || result;
 if (!updated) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 res.json({ success: true, message: 'Candidate details saved.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Save Candidate Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.post(`${API_BASE}/workorders/:id/send-invite`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 if ((wo.initiationMode || 'Candidate') !== 'Candidate') return res.json({ success: true, skipped: true, message: 'Initiation mode is "Verifitech" — no candidate invite needed.' });
 const email = req.body.email || wo.email;
 const fullName = req.body.fullName || wo.fullName;
 const emailResult = await sendCandidateInviteEmail({ to: email, fullName, bgvRef: wo.bgvRef, workorderId: id });
 res.json({ success: !!emailResult.success, message: emailResult.success ? 'Invite email sent successfully.' : 'Failed to send invite email.', emailResult });
 } catch (error) { console.error('Send Invite Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.delete(`${API_BASE}/workorders/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const deleteResult = await req.db.collection(WORKORDER_COLLECTION).deleteOne({ _id: new ObjectId(id) });
 if (deleteResult.deletedCount === 0) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const [assignmentDelete, insufficiencyDelete] = await Promise.all([req.db.collection(ASSIGNMENT_COLLECTION).deleteMany({ workorderId: id }), req.db.collection(INSUFFICIENCY_COLLECTION).deleteMany({ workorderId: id })]);
 res.json({ success: true, message: 'Workorder and related assignment records deleted successfully.', deletedAssignments: assignmentDelete.deletedCount, deletedInsufficiencies: insufficiencyDelete.deletedCount });
 } catch (error) { console.error('Delete Workorder Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.get(`${API_BASE}/package-checks`, async (req, res) => {
 try {
 const name = (req.query.name || '').trim(); const code = (req.query.code || '').trim();
 if (!name && !code) return res.status(400).json({ success: false, message: 'Package name or code is required.' });
 const query = name ? { name } : { code };
 const pkg = await req.db.collection(PACKAGE_COLLECTION).findOne(query);
 if (!pkg) return res.status(404).json({ success: false, message: `Package "${name || code}" not found.`, checks: [] });
 let checkCodes = [];
 if (Array.isArray(pkg.checks) && pkg.checks.length) checkCodes = pkg.checks.filter(Boolean);
 else if (Array.isArray(pkg.checkComponents) && pkg.checkComponents.length) checkCodes = pkg.checkComponents.map((c) => typeof c === 'string' ? c : c.code || c.checkCode || c.checkType || c.checkTypeCode).filter(Boolean);
 if (!checkCodes.length) return res.json({ success: true, package: { id: pkg._id.toString(), name: pkg.name, code: pkg.code }, checks: [] });
 const masters = await req.db.collection(CHECKTYPE_COLLECTION).find({ code: { $in: checkCodes } }).toArray();
 const byCode = new Map(masters.map((m) => [m.code, m]));
 const checks = checkCodes.map((c) => byCode.get(c)).filter(Boolean).map(shapeCheckFromMaster).filter(Boolean);
 res.json({ success: true, package: { id: pkg._id.toString(), name: pkg.name, code: pkg.code, description: pkg.description || '' }, checks });
 } catch (error) { console.error('Resolve Package Checks Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

/* ####################################################################
 ## SHARED: CHECK HOLD / CASE HOLD / STOP (NO TIME RESTRICTION) ##
 #################################################################### */

router.put(`${API_BASE}/workorders/:id/checks/:slNo/hold`, async (req, res) => {
 try {
 const { id, slNo } = req.params; const { reason, raisedBy } = req.body;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'A reason for the hold is required.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 const now = new Date();
 const holdPreviousStatus = checks[idx].status || 'assignment-pending';
 checks[idx] = { ...checks[idx], holdPreviousStatus, status: 'hold', holdReason: reason.trim(), holdRaisedAt: now, holdClearedAt: null, holdRaisedBy: raisedBy || null };
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checks, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 sendCheckHoldNotification({ assigneeEmail: checks[idx].assignedToEmail, bgvRef: wo.bgvRef, candidateName: wo.fullName, checkType: checks[idx].checkType, subType: checks[idx].subType, reason: reason.trim() }).catch((e) => console.error('Check hold email failed:', e.message));
 if (raisedBy?.origin === 'client') {
 (async () => {
 try {
 const clientDoc = await findClientDoc(req.db, wo.client);
 const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
 await sendCheckHoldNotification({ supporterEmail, bgvRef: wo.bgvRef, candidateName: wo.fullName, checkType: checks[idx].checkType, subType: checks[idx].subType, reason: reason.trim() });
 } catch (e) { console.error('Client check hold supporter email failed:', e.message); }
 })();
 }
 res.json({ success: true, message: 'Check put on hold.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Workorder Check Hold Error:', error); res.status(500).json({ success: false, message: error.message }); }
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
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checks, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 res.json({ success: true, message: 'Check hold cleared.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Workorder Clear Check Hold Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id/case-hold`, async (req, res) => {
 try {
 const { id } = req.params; const { reason, raisedBy } = req.body;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: 'A reason for the case hold is required.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 if (wo.status === 'on-hold') return res.status(400).json({ success: false, message: 'This case is already on hold.' });
 const now = new Date();
 const casePreviousStatus = wo.status || 'draft';
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { casePreviousStatus, status: 'on-hold', caseHoldReason: reason.trim(), caseHoldRaisedAt: now, caseHoldClearedAt: null, caseHoldRaisedBy: raisedBy || null, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 (async () => {
 try {
 const clientDoc = await findClientDoc(req.db, wo.client);
 const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
 await sendCaseHoldNotification({ supporterEmail, bgvRef: wo.bgvRef, candidateName: wo.fullName, clientName: clientDoc?.companyName || wo.client, reason: reason.trim() });
 } catch (e) { console.error('Case hold email failed:', e.message); }
 })();
 res.json({ success: true, message: 'Case put on hold. Every check on this workorder is paused.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Workorder Case Hold Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id/case-hold/clear`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const now = new Date();
 const restoredStatus = wo.casePreviousStatus || 'draft';
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { status: restoredStatus, caseHoldClearedAt: now, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 res.json({ success: true, message: 'Case hold cleared.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Workorder Clear Case Hold Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.get(`${API_BASE}/workorders/:id/payment-policy`, async (req, res) => {
 try {
 const { id } = req.params;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const paymentDue = isPaymentDue(wo.createdAt);
 res.json({ success: true, paymentDue, note: paymentPolicyNote(paymentDue), graceWindowExpiresAt: paymentGraceExpiresAt(wo.createdAt) });
 } catch (error) { console.error('Payment Policy Preview Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

router.put(`${API_BASE}/workorders/:id/checks/:slNo/stop`, async (req, res) => {
 try {
 const { id, slNo } = req.params; const { reason, stoppedBy } = req.body;
 if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(id) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) return res.status(400).json({ success: false, message: 'This check has already been stopped.' });
 const now = new Date();
 const paymentDue = isPaymentDue(wo.createdAt);
 checks[idx] = { ...checks[idx], stopped: true, stoppedAt: now, stopReason: (reason || '').trim(), stoppedBy: stoppedBy || null, paymentDue, previousStatusBeforeStop: checks[idx].status || 'assignment-pending', status: 'stopped' };
 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { checks, updatedAt: now } }, { returnDocument: 'after' });
 const updated = result?.value || result;
 if (stoppedBy?.origin === 'client') {
 (async () => {
 try {
 const clientDoc = await findClientDoc(req.db, wo.client);
 const supporterEmail = clientDoc ? await findSupporterEmail(req.db, clientDoc.customerSupporter) : '';
 await sendStopCheckNotification({ supporterEmail, clientName: clientDoc?.companyName || wo.client, bgvRef: wo.bgvRef, candidateName: wo.fullName, checkType: checks[idx].checkType, reason: (reason || '').trim() });
 } catch (e) { console.error('Client stop check supporter email failed:', e.message); }
 })();
 }
 res.json({ success: true, message: 'Check stopped.', workorder: shapeWorkorder(updated.value ? updated.value : updated) });
 } catch (error) { console.error('Workorder Check Stop Error:', error); res.status(500).json({ success: false, message: error.message }); }
});

/* ####################################################################
 ## BULK UPLOAD ##
 #################################################################### */

// Helper: parse CSV or XLSX buffer into array of row-objects using XLSX (already imported)
function parseSpreadsheetBuffer(buffer, originalName) {
 const workbook = XLSX.read(buffer, { type: 'buffer' });
 const sheetName = workbook.SheetNames[0];
 if (!sheetName) return [];
 return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

// GET /api/workorder-assignment/bulk/template
router.get(`${API_BASE}/workorder-assignment/bulk/template`, (req, res) => {
 const headers = ['firstName', 'lastName', 'email', 'phone', 'gender', 'dob', 'aadhaarNumber', 'client', 'branch', 'packageName', 'priority', 'clientRef', 'checkTypes'];
 const csvLine = headers.join(',');
 const sampleRow = ['John', 'Doe', 'john.doe@example.com', '9876543210', 'Male', '1990-01-15', '123456789012', 'ClientA', 'Mumbai', 'IT Package', 'Standard', 'REF-001', 'Address,Employment,Education,Criminal,Court'].join(',');
 res.setHeader('Content-Type', 'text/csv');
 res.setHeader('Content-Disposition', 'attachment; filename=bulk_workorder_template.csv');
 res.send(csvLine + '\n' + sampleRow + '\n');
});

// POST /api/workorder-assignment/bulk
router.post(`${API_BASE}/workorder-assignment/bulk`, bulkUpload.single('file'), async (req, res) => {
 try {
 if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

 const rows = parseSpreadsheetBuffer(req.file.buffer, req.file.originalname);
 if (!rows || rows.length === 0) return res.status(400).json({ success: false, message: 'File is empty or has no data rows.' });
 if (rows.length > 500) return res.status(400).json({ success: false, message: 'Maximum 500 rows per upload.' });

 const requiredCols = ['firstName', 'lastName', 'email', 'phone', 'client', 'packageName'];
 const errors = [];
 const created = [];
 const seenEmails = new Set();

 // Load check-type name→id map
 let checkTypeMap = {};
 try {
 const checkTypes = await req.db.collection(CHECKTYPE_COLLECTION).find({}).toArray();
 checkTypes.forEach((ct) => {
 const id = ct._id ? ct._id.toString() : '';
 if (!id) return;
 const name = (ct.name || '').toLowerCase().trim();
 const nameCompact = name.replace(/\s+/g, '');
 const code = (ct.code || '').toLowerCase().trim();
 if (name) { checkTypeMap[name] = id; checkTypeMap[nameCompact] = id; }
 if (code) checkTypeMap[code] = id;
 });
 } catch (e) { console.warn('Bulk upload: could not load check types:', e.message); }

 for (let i = 0; i < rows.length; i++) {
 const row = rows[i];
 const rowNum = i + 2;

 const missing = requiredCols.filter((col) => !row[col] || !String(row[col]).trim());
 if (missing.length > 0) { errors.push({ row: rowNum, message: `Missing: ${missing.join(', ')}` }); continue; }

 const email = String(row.email).trim();
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row: rowNum, message: `Invalid email: ${email}` }); continue; }

 const emailLower = email.toLowerCase();
 if (seenEmails.has(emailLower)) { errors.push({ row: rowNum, message: `Duplicate email in this file: ${email}` }); continue; }
 seenEmails.add(emailLower);

 const candidateDetails = {
 personal: {
 firstName: String(row.firstName).trim(), lastName: String(row.lastName).trim(), fatherName: String(row.fatherName || '').trim(),
 motherName: String(row.motherName || '').trim(), email, gender: String(row.gender || '').trim(), dob: String(row.dob || '').trim(),
 maritalStatus: String(row.maritalStatus || '').trim(), nationality: String(row.nationality || 'Indian').trim(),
 aadhaarNumber: String(row.aadhaarNumber || '').trim(), mobile: String(row.phone || '').trim(), altMobile: String(row.altMobile || '').trim(),
 bloodGroup: String(row.bloodGroup || '').trim(), isFresher: String(row.isFresher || '').trim(), isExServiceman: String(row.isExServiceman || '').trim(),
 physicallyChallenged: String(row.physicallyChallenged || '').toLowerCase() === 'yes', disabilityDetails: String(row.disabilityDetails || '').trim(),
 chronicCondition: String(row.chronicCondition || '').toLowerCase() === 'yes', chronicConditionDetails: String(row.chronicConditionDetails || '').trim(),
 },
 secondaryContacts: [],
 additional: {
 panNumber: String(row.panNumber || '').trim(), nameOnPan: String(row.nameOnPan || '').trim(),
 drivingLicenseNo: String(row.drivingLicenseNo || '').trim(), voterId: String(row.voterId || '').trim(),
 passportNumber: String(row.passportNumber || '').trim(), uanNumber: String(row.uanNumber || '').trim(),
 },
 address: {
 currentAddress: String(row.currentAddress || '').trim(), currentCity: String(row.currentCity || '').trim(),
 currentState: String(row.currentState || '').trim(), pinCode: String(row.pinCode || '').trim(),
 country: String(row.country || 'India').trim(), sameAsCurrent: false,
 permanentAddress: String(row.permanentAddress || '').trim(), permanentCity: String(row.permanentCity || '').trim(),
 permanentState: String(row.permanentState || '').trim(), permanentPinCode: String(row.permanentPinCode || '').trim(),
 },
 education: [], employment: [], documents: {},
 };

 // Build checks from checkTypes column
 const checks = [];
 const checkTypesStr = String(row.checkTypes || '').trim();
 if (checkTypesStr) {
 const typeNames = checkTypesStr.split(',').map((s) => s.trim()).filter(Boolean);
 for (const typeName of typeNames) {
 const key = typeName.toLowerCase().trim();
 const keyCompact = key.replace(/\s+/g, '');
 const ctId = checkTypeMap[key] || checkTypeMap[keyCompact] || null;
 checks.push(normalizeCheck({ checkType: typeName, checkTypeId: ctId || '', status: 'assignment-pending', priority: String(row.priority || 'Standard').trim() }, checks.length));
 }
 }

 const bgvRef = await generateBgvRef(req.db);
 const now = new Date();
 const createdBy = buildCreatedBy({ origin: 'employee' }, 'employee');

 const doc = {
 ...buildWorkorderDoc({
 fullName: `${String(row.firstName).trim()} ${String(row.lastName).trim()}`, email, phone: String(row.phone || '').trim(),
 client: String(row.client || '').trim(), branch: String(row.branch || '').trim(), packageName: String(row.packageName || '').trim(),
 priority: String(row.priority || 'Standard').trim(), clientRef: String(row.clientRef || '').trim(), initiationMode: 'Bulk Upload',
 status: 'candidate-details', checks, candidateDetails,
 }),
 bgvRef, createdBy, origin: 'employee', createdAt: now, updatedAt: now,
 };

 try {
 const result = await req.db.collection(WORKORDER_COLLECTION).insertOne(doc);
 if (result.insertedId) created.push({ _id: result.insertedId.toString(), bgvRef, email });
 } catch (dbErr) {
 let msg = dbErr.message;
 if (dbErr.code === 11000) { const field = Object.keys(dbErr.keyValue || {})[0] || 'field'; msg = `Duplicate value for ${field}`; }
 errors.push({ row: rowNum, message: msg });
 }
 }

 return res.status(200).json({
 success: true,
 message: `Processed ${rows.length} rows: ${created.length} created, ${errors.length} failed`,
 created: created.length, failed: errors.length, errors,
 workorders: created.map((w) => w._id),
 });
 } catch (err) {
 console.error('Bulk upload error:', err);
 return res.status(500).json({ success: false, message: err.message || 'Internal server error during bulk upload.' });
 }
});

module.exports = router;

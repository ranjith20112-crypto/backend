// routes/dataManagementRoutes.js
// ============================================================================
// DATA MANAGEMENT MODULE
// ============================================================================

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const {
 sendCheckAssignmentNotification,
 sendCheckCompletedNotification,
 sendInsufficiencyEmail,
 sendCheckHoldNotification,
 sendCaseHoldNotification,
 sendStopCheckNotification,
 sendStopWorkorderNotification,
} = require('../config/emailservice');

const API_BASE = '/api';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const EMPLOYEE_COLLECTION = 'employee_login';
const VENDOR_COLLECTION = 'vendors';
const CLIENT_COLLECTION = 'client-details';
const INSUFFICIENCY_COLLECTION = 'Workorder-Insufficiency';
const HOLD_COLLECTION = 'Workorder-Hold';

const employeeDisplayName = (e) => {
 const firstName = e.firstName || e.first_name || '';
 const lastName = e.lastName || e.last_name || '';
 const fullName = [firstName, lastName].filter(Boolean).join(' ');
 return fullName || e.displayName || e.name || e.email || 'Unknown';
};

const findSupporterEmailForClient = async (db, clientRef) => {
 if (!clientRef) return '';
 try {
 let clientDoc = null;
 if (ObjectId.isValid(clientRef) && String(new ObjectId(clientRef)) === String(clientRef)) {
 clientDoc = await db.collection(CLIENT_COLLECTION).findOne({ _id: new ObjectId(clientRef) });
 }
 if (!clientDoc) {
 clientDoc = await db.collection(CLIENT_COLLECTION).findOne({
 $or: [{ companyName: clientRef }, { clientCode: clientRef }, { displayName: clientRef }],
 });
 }
 if (!clientDoc || !clientDoc.customerSupporter) return '';

 const employees = await db.collection(EMPLOYEE_COLLECTION).find({}).toArray();
 const match = employees.find(
 (e) => employeeDisplayName(e).toLowerCase().trim() === String(clientDoc.customerSupporter).toLowerCase().trim()
 );
 return match?.email || '';
 } catch (err) {
 console.error('findSupporterEmailForClient error:', err.message);
 return '';
 }
};

const fetchClientNameMap = async (db, workorders) => {
 const clientIds = [...new Set(
 workorders
 .map((wo) => wo.client)
 .filter((c) => c && isValidId(c))
 )];

 const map = {};
 if (clientIds.length > 0) {
 try {
 const clientDocs = await db
 .collection(CLIENT_COLLECTION)
 .find({ _id: { $in: clientIds.map((id) => new ObjectId(id)) } })
 .toArray();
 clientDocs.forEach((doc) => {
 map[doc._id.toString()] =
 doc.companyName ||
 doc.clientName ||
 doc.name ||
 doc.organizationName ||
 doc.displayName ||
 '';
 });
 } catch (err) {
 console.error('fetchClientNameMap error:', err.message);
 }
 }
 return map;
};

const resolveClientName = (clientRef, clientMap) => {
 if (!clientRef) return '';
 if (clientMap && clientMap[clientRef]) return clientMap[clientRef];
 if (!isValidId(clientRef)) return clientRef;
 return clientRef;
};

const isValidId = (id) => {
 try {
 return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
 } catch {
 return false;
 }
};

const shapeWorkorder = (doc) =>
 doc ? { ...doc, _id: doc._id ? doc._id.toString() : undefined } : null;

// ✅ FIXED: Added 'qc' to eligible statuses
const DATA_MGMT_ELIGIBLE_STATUSES = [
 'draft',
 'pending',
 'candidate-details',
 'ready-for-assignment',
 'submitted',
 'in-progress',
 'in progress',
 'completed',
 'assignment-pending',
 'qc',
];

const PAYMENT_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

const isPaymentDue = (createdAt) => {
 if (!createdAt) return true;
 return Date.now() - new Date(createdAt).getTime() > PAYMENT_GRACE_WINDOW_MS;
};

const paymentGraceExpiresAt = (createdAt) =>
 createdAt ? new Date(new Date(createdAt).getTime() + PAYMENT_GRACE_WINDOW_MS) : null;

const paymentPolicyNote = (paymentDue) =>
 paymentDue
 ? 'This action is being taken after the 24-hour payment-review window from workorder creation. As per Verifitech policy, payment is due for the verification work already initiated on this record.'
 : 'This action is within the 24-hour payment-review window from workorder creation. As per Verifitech policy, no payment is due for this stop.';

// ====================================================================
// GET /api/data-management
// ====================================================================


// ====================================================================
// GET /api/data-management/stats
// ====================================================================
router.get(`${API_BASE}/data-management/stats`, async (req, res) => {
 try {
 const eligibleStatuses = [...DATA_MGMT_ELIGIBLE_STATUSES, 'on-hold', 'stopped'];

 const workorders = await req.db
 .collection(WORKORDER_COLLECTION)
 .find({ status: { $in: eligibleStatuses } })
 .toArray();

 let total = 0;
 let unassigned = 0;
 let inProgress = 0;
 let qc = 0;
 let insufficient = 0;
 let stopped = 0;

 workorders.forEach((wo) => {
 const checks = Array.isArray(wo.checks) ? wo.checks : [];

 checks.forEach((c) => {
 const s = (c.status || 'assignment-pending').toLowerCase();

 // Count active checks (not completed, not on-hold at case level)
 if (s !== 'report' && s !== 'insufficient' && s !== 'hold' && !c.stopped) {
 total++;
 }

 if (!c.assignedToId && s !== 'report' && !c.stopped) unassigned++;
 if (s === 'verification-pending') inProgress++;
 if (s === 'qc') qc++;
 if (s === 'insufficient') insufficient++;
 if (c.stopped || s === 'stopped') stopped++;
 });
 });

 res.json({
 success: true,
 stats: { total, unassigned, inProgress, qc, insufficient, stopped },
 });
 } catch (error) {
 console.error('Data Management Stats Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});
router.get(`${API_BASE}/data-management`, async (req, res) => {
 try {
 const {
 status,
 assignedToId,
 unassigned,
 search,
 excludeCompleted,
 excludeInsufficient,
 excludeHold,
 excludeStopped,
 } = req.query;

 const eligibleStatuses = [...DATA_MGMT_ELIGIBLE_STATUSES, 'on-hold', 'stopped'];

 const workorders = await req.db
 .collection(WORKORDER_COLLECTION)
 .find({ status: { $in: eligibleStatuses } })
 .sort({ createdAt: -1 })
 .toArray();

 const clientMap = await fetchClientNameMap(req.db, workorders);

 const rows = [];
 let completedCount = 0;
 let insufficientCount = 0;
 let holdCount = 0;
 let stoppedCount = 0;

 workorders.forEach((wo) => {
 const clientName = resolveClientName(wo.client, clientMap);

 const searchTerm = (search || '').toLowerCase().trim();
 if (searchTerm) {
 const haystack = `${wo.bgvRef || ''} ${wo.fullName || ''} ${clientName}`.toLowerCase();
 if (!haystack.includes(searchTerm)) return;
 }

 (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
 const effectiveStatus = c.status || 'assignment-pending';

 if (effectiveStatus === 'report') completedCount += 1;
 if (effectiveStatus === 'insufficient') insufficientCount += 1;
 if (effectiveStatus === 'hold') holdCount += 1;
 if (c.stopped) stoppedCount += 1;

 if (excludeCompleted === 'true' && effectiveStatus === 'report') return;
 if (excludeInsufficient === 'true' && effectiveStatus === 'insufficient') return;
 if (excludeHold === 'true' && effectiveStatus === 'hold') return;
 if (excludeStopped === 'true' && c.stopped) return;
 if (status && effectiveStatus !== status) return;
 if (assignedToId && String(c.assignedToId || '') !== String(assignedToId)) return;
 if (unassigned === 'true' && c.assignedToId) return;

 rows.push({
 workorderId: wo._id.toString(),
 bgvRef: wo.bgvRef || '',
 candidateName: wo.fullName || '',
 candidateEmail: wo.email || '',
 client: clientName,
 initiationMode: wo.initiationMode || 'Candidate',
 slNo: c.slNo,
 checkType: c.checkType || '',
 subType: c.subType || '',
 checkTypeId: c.checkTypeId || '',
 subCheckId: c.subCheckId || null,
 status: c.status || 'assignment-pending',
 assignedTo: c.assignedTo || '',
 assignedToId: c.assignedToId || null,
 assignedToEmail: c.assignedToEmail || '',
 assignmentType: c.assignmentType || null,
 assignedAt: c.assignedAt || null,
 completedAt: c.completedAt || null,
 previousStatus: c.previousStatus || null,
 insufficiencyDescription: c.insufficiencyDescription || '',
 insufficiencyRaisedAt: c.insufficiencyRaisedAt || null,
 insufficiencyClearedAt: c.insufficiencyClearedAt || null,
 holdPreviousStatus: c.holdPreviousStatus || null,
 holdReason: c.holdReason || '',
 holdRaisedAt: c.holdRaisedAt || null,
 holdClearedAt: c.holdClearedAt || null,
 holdRaisedBy: c.holdRaisedBy || null,
 stopped: !!c.stopped,
 stoppedAt: c.stoppedAt || null,
 stopReason: c.stopReason || '',
 stoppedBy: c.stoppedBy || null,
 paymentDue: !!c.paymentDue,
 hasData: !!(c.data && Object.keys(c.data).length > 0),
 workorderCreatedAt: wo.createdAt || null,
 caseOnHold: wo.status === 'on-hold',
 caseHoldReason: wo.caseHoldReason || '',
 caseHoldRaisedAt: wo.caseHoldRaisedAt || null,
 workorderStopped: !!wo.stopped,
 workorderStopReason: wo.stopReason || '',
 workorderStoppedAt: wo.stoppedAt || null,
 workorderPaymentDue: !!wo.paymentDue,
 });
 });
 });

 const stats = {
 total: rows.length,
 unassigned: rows.filter((r) => !r.assignedToId).length,
 inProgress: rows.filter((r) => ['assignment-pending', 'verification-pending'].includes(r.status)).length,
 qc: rows.filter((r) => r.status === 'qc').length,
 completed: completedCount,
 insufficient: insufficientCount,
 hold: holdCount,
 stopped: stoppedCount,
 };

 res.json({ success: true, rows, stats });
 } catch (error) {
 console.error('Data Management List Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// GET /api/data-management/assignees/list
// ====================================================================
router.get(`${API_BASE}/data-management/assignees/list`, async (req, res) => {
 try {
 let employees = [];
 try {
 employees = await req.db
 .collection(EMPLOYEE_COLLECTION)
 .find({})
 .project({ password: 0, portalPassword: 0 })
 .toArray();
 } catch (err) {
 console.error('Assignees: failed to fetch employees:', err.message);
 employees = [];
 }

 let vendors = [];
 try {
 vendors = await req.db
 .collection(VENDOR_COLLECTION)
 .find({})
 .project({ password: 0, portalPassword: 0 })
 .toArray();
 } catch (err) {
 console.error('Assignees: failed to fetch vendors:', err.message);
 vendors = [];
 }

 const shapeName = (e) =>
 [e.firstName || e.first_name, e.lastName || e.last_name].filter(Boolean).join(' ')
 || e.displayName || e.name || e.email || 'Unknown';

 res.json({
 success: true,
 internal: employees.map((e) => ({
 id: e._id.toString(),
 name: shapeName(e),
 email: e.email || '',
 })),
 external: vendors.map((v) => ({
 id: v._id.toString(),
 name: v.companyName || v.name || shapeName(v),
 email: v.email || v.portalEmail || '',
 })),
 });
 } catch (error) {
 console.error('Data Management Assignees Error:', error);
 res.status(500).json({ success: false, message: error.message, internal: [], external: [] });
 }
});

// ====================================================================
// GET /api/data-management/stopped/list
// ====================================================================
router.get(`${API_BASE}/data-management/stopped/list`, async (req, res) => {
 try {
 const workorders = await req.db
 .collection(WORKORDER_COLLECTION)
 .find({ $or: [{ stopped: true }, { 'checks.stopped': true }] })
 .sort({ updatedAt: -1 })
 .toArray();

 const clientMap = await fetchClientNameMap(req.db, workorders);

 const stoppedWorkorders = [];
 const stoppedChecks = [];

 workorders.forEach((wo) => {
 const clientName = resolveClientName(wo.client, clientMap);

 if (wo.stopped) {
 stoppedWorkorders.push({
 workorderId: wo._id.toString(),
 bgvRef: wo.bgvRef || '',
 candidateName: wo.fullName || '',
 client: clientName,
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
 client: clientName,
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
 console.error('Data Management List Stopped Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/assign
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/assign`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 const { assignedToId, assignedToName, assignedToEmail, assignmentType } = req.body;

 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }
 if (!assignedToId || !assignedToName) {
 return res.status(400).json({ success: false, message: 'assignedToId and assignedToName are required.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) {
 return res.status(400).json({ success: false, message: 'This check has been permanently stopped and cannot be assigned.' });
 }

 const now = new Date();

 const updatedCheck = Object.assign({}, checks[idx], {
 assignedTo: assignedToName,
 assignedToId: String(assignedToId),
 assignedToEmail: assignedToEmail || '',
 assignmentType: assignmentType || 'internal',
 assignedAt: now.toISOString(),
 status:
 !checks[idx].status || checks[idx].status === 'assignment-pending'
 ? 'verification-pending'
 : checks[idx].status,
 });
 checks[idx] = updatedCheck;

 const updateOptions = { returnDocument: 'after' };
 try {
 await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 updateOptions
 );
 } catch (dbErr) {
 await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnNewDocument: true }
 );
 }

 res.json({
 success: true,
 message: 'Check assigned successfully.',
 });

 if (assignedToEmail) {
 sendCheckAssignmentNotification({
 to: assignedToEmail,
 assigneeName: assignedToName,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 checkType: updatedCheck.checkType,
 subType: updatedCheck.subType,
 workorderId,
 slNo,
 }).catch((e) => console.error('Assignment email failed:', e.message));
 }
 } catch (error) {
 console.error('Data Management Assign Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// GET /api/data-management/:workorderId
// ====================================================================
router.get(`${API_BASE}/data-management/:workorderId`, async (req, res) => {
 try {
 const { workorderId } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 res.json({ success: true, workorder: shapeWorkorder(wo) });
 } catch (error) {
 console.error('Data Management Get Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/data
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/data`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) {
 return res.status(400).json({ success: false, message: 'This check has been permanently stopped and can no longer be edited.' });
 }

 if (req.body.data && typeof req.body.data === 'object') {
 checks[idx].data = { ...(checks[idx].data || {}), ...req.body.data };
 }
 if (req.body.status !== undefined) checks[idx].status = req.body.status;
 if (req.body.notes !== undefined) checks[idx].notes = req.body.notes;

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: new Date() } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 res.json({
 success: true,
 message: 'Check data saved.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Save Data Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/complete
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/complete`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) {
 return res.status(400).json({ success: false, message: 'This check has been permanently stopped and cannot be marked complete.' });
 }

 const now = new Date();
 checks[idx].status = 'report';
 checks[idx].completedAt = now;

 const allDone = checks.every((c) => c.status === 'report');
 const setFields = { checks, updatedAt: now };
 if (allDone) setFields.status = 'completed';

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: setFields },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 sendCheckCompletedNotification({
 to: checks[idx].assignedToEmail || '',
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 checkType: checks[idx].checkType,
 subType: checks[idx].subType,
 }).catch((e) => console.error('Completion email failed:', e.message));

 res.json({
 success: true,
 message: allDone ? 'Check completed. All checks done — workorder marked completed.' : 'Check marked complete.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Complete Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/insufficiency
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/insufficiency`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 const { description, raisedBy } = req.body;

 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }
 if (!description || !description.trim()) {
 return res.status(400).json({ success: false, message: 'A description of the insufficiency is required.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) {
 return res.status(400).json({ success: false, message: 'This check has been permanently stopped.' });
 }

 const now = new Date();
 const previousStatus = checks[idx].status || 'assignment-pending';

 checks[idx] = {
 ...checks[idx],
 previousStatus,
 status: 'insufficient',
 insufficiencyDescription: description.trim(),
 insufficiencyRaisedAt: now,
 insufficiencyClearedAt: null,
 };

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 req.db.collection(INSUFFICIENCY_COLLECTION).insertOne({
 workorderId,
 slNo: checks[idx].slNo,
 bgvRef: wo.bgvRef || null,
 candidateName: wo.fullName || null,
 description: description.trim(),
 docType: checks[idx].checkType || '',
 status: 'pending',
 raisedBy: raisedBy || null,
 createdAt: now,
 updatedAt: now,
 }).catch((e) => console.error('Insufficiency audit insert failed:', e.message));

 sendInsufficiencyEmail({
 to: wo.email,
 candidateName: wo.fullName,
 bgvRef: wo.bgvRef,
 checkType: checks[idx].checkType,
 subType: checks[idx].subType,
 description: description.trim(),
 }).catch((e) => console.error('Insufficiency email failed:', e.message));

 res.json({
 success: true,
 message: 'Insufficiency raised and candidate notified by email.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Raise Insufficiency Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/insufficiency/clear
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/insufficiency/clear`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

 const now = new Date();
 const restoredStatus = checks[idx].previousStatus || 'verification-pending';

 checks[idx] = {
 ...checks[idx],
 status: restoredStatus,
 insufficiencyClearedAt: now,
 };

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 req.db.collection(INSUFFICIENCY_COLLECTION)
 .updateMany(
 { workorderId, slNo: checks[idx].slNo, status: 'pending' },
 { $set: { status: 'resolved', resolvedAt: now, updatedAt: now } }
 )
 .catch((e) => console.error('Insufficiency audit resolve failed:', e.message));

 res.json({
 success: true,
 message: 'Insufficiency cleared — check moved back to Data Management.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Clear Insufficiency Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/hold
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/hold`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 const { reason, raisedBy } = req.body;

 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }
 if (!reason || !reason.trim()) {
 return res.status(400).json({ success: false, message: 'A reason for the hold is required.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
 if (checks[idx].stopped) {
 return res.status(400).json({ success: false, message: 'This check has been permanently stopped and cannot be held.' });
 }

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
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 req.db.collection(HOLD_COLLECTION).insertOne({
 scope: 'check',
 workorderId,
 slNo: checks[idx].slNo,
 bgvRef: wo.bgvRef || null,
 candidateName: wo.fullName || null,
 reason: reason.trim(),
 checkType: checks[idx].checkType || '',
 status: 'active',
 raisedBy: raisedBy || null,
 createdAt: now,
 updatedAt: now,
 }).catch((e) => console.error('Check hold audit insert failed:', e.message));

 sendCheckHoldNotification({
 to: checks[idx].assignedToEmail,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 checkType: checks[idx].checkType,
 subType: checks[idx].subType,
 reason: reason.trim(),
 }).catch((e) => console.error('Check hold email failed:', e.message));

 if (raisedBy?.origin === 'client') {
 (async () => {
 try {
 const supporterEmail = await findSupporterEmailForClient(req.db, wo.client);
 if (supporterEmail) {
 await sendCheckHoldNotification({
 to: supporterEmail,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 checkType: checks[idx].checkType,
 subType: checks[idx].subType,
 reason: reason.trim(),
 });
 }
 } catch (e) {
 console.error('DM client check hold supporter email failed:', e.message);
 }
 })();
 }

 res.json({
 success: true,
 message: 'Check put on hold.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Check Hold Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/hold/clear
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/hold/clear`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const checks = Array.isArray(wo.checks) ? wo.checks : [];
 const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
 if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

 const now = new Date();
 const restoredStatus = checks[idx].holdPreviousStatus || 'verification-pending';

 checks[idx] = {
 ...checks[idx],
 status: restoredStatus,
 holdClearedAt: now,
 };

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 req.db.collection(HOLD_COLLECTION)
 .updateMany(
 { scope: 'check', workorderId, slNo: checks[idx].slNo, status: 'active' },
 { $set: { status: 'resolved', resolvedAt: now, updatedAt: now } }
 )
 .catch((e) => console.error('Check hold audit resolve failed:', e.message));

 res.json({
 success: true,
 message: 'Check hold cleared — moved back to Data Management.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Clear Check Hold Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/case-hold
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/case-hold`, async (req, res) => {
 try {
 const { workorderId } = req.params;
 const { reason, raisedBy } = req.body;

 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }
 if (!reason || !reason.trim()) {
 return res.status(400).json({ success: false, message: 'A reason for the case hold is required.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });
 if (wo.stopped) {
 return res.status(400).json({ success: false, message: 'This workorder has been permanently stopped and cannot be held.' });
 }
 if (wo.status === 'on-hold') {
 return res.status(400).json({ success: false, message: 'This case is already on hold.' });
 }

 const now = new Date();
 const casePreviousStatus = wo.status || 'candidate-details';

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
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

 req.db.collection(HOLD_COLLECTION).insertOne({
 scope: 'case',
 workorderId,
 bgvRef: wo.bgvRef || null,
 candidateName: wo.fullName || null,
 reason: reason.trim(),
 status: 'active',
 raisedBy: raisedBy || null,
 createdAt: now,
 updatedAt: now,
 }).catch((e) => console.error('Case hold audit insert failed:', e.message));

 (async () => {
 try {
 const supporterEmail = await findSupporterEmailForClient(req.db, wo.client);
 if (supporterEmail) {
 await sendCaseHoldNotification({
 to: supporterEmail,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 clientName: wo.client,
 reason: reason.trim(),
 });
 }
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
 console.error('Data Management Case Hold Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/case-hold/clear
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/case-hold/clear`, async (req, res) => {
 try {
 const { workorderId } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const now = new Date();
 const restoredStatus = wo.casePreviousStatus || 'candidate-details';

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 {
 $set: {
 status: restoredStatus,
 caseHoldClearedAt: now,
 updatedAt: now,
 },
 },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 req.db.collection(HOLD_COLLECTION)
 .updateMany(
 { scope: 'case', workorderId, status: 'active' },
 { $set: { status: 'resolved', resolvedAt: now, updatedAt: now } }
 )
 .catch((e) => console.error('Case hold audit resolve failed:', e.message));

 res.json({
 success: true,
 message: 'Case hold cleared — workorder moved back to Data Management.',
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Clear Case Hold Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// GET /api/data-management/holds/list
// ====================================================================
router.get(`${API_BASE}/data-management/holds/list`, async (req, res) => {
 try {
 const eligibleWorkorders = await req.db
 .collection(WORKORDER_COLLECTION)
 .find({ status: { $in: DATA_MGMT_ELIGIBLE_STATUSES } })
 .sort({ createdAt: -1 })
 .toArray();

 const heldWorkorders = await req.db
 .collection(WORKORDER_COLLECTION)
 .find({ status: 'on-hold' })
 .sort({ caseHoldRaisedAt: -1 })
 .toArray();

 const allWorkorders = [...eligibleWorkorders, ...heldWorkorders];
 const clientMap = await fetchClientNameMap(req.db, allWorkorders);

 const checkHolds = [];
 eligibleWorkorders.forEach((wo) => {
 const clientName = resolveClientName(wo.client, clientMap);
 (Array.isArray(wo.checks) ? wo.checks : []).forEach((c) => {
 if ((c.status || '') !== 'hold') return;
 checkHolds.push({
 workorderId: wo._id.toString(),
 bgvRef: wo.bgvRef || '',
 candidateName: wo.fullName || '',
 client: clientName,
 initiationMode: wo.initiationMode || 'Candidate',
 slNo: c.slNo,
 checkType: c.checkType || '',
 subType: c.subType || '',
 assignedTo: c.assignedTo || '',
 assignedToId: c.assignedToId || null,
 assignmentType: c.assignmentType || null,
 holdReason: c.holdReason || '',
 holdRaisedAt: c.holdRaisedAt || null,
 holdPreviousStatus: c.holdPreviousStatus || null,
 holdRaisedBy: c.holdRaisedBy || null,
 });
 });
 });

 const caseHolds = heldWorkorders.map((wo) => {
 const clientName = resolveClientName(wo.client, clientMap);
 return {
 workorderId: wo._id.toString(),
 bgvRef: wo.bgvRef || '',
 candidateName: wo.fullName || '',
 client: clientName,
 initiationMode: wo.initiationMode || 'Candidate',
 caseHoldReason: wo.caseHoldReason || '',
 caseHoldRaisedAt: wo.caseHoldRaisedAt || null,
 casePreviousStatus: wo.casePreviousStatus || null,
 caseHoldRaisedBy: wo.caseHoldRaisedBy || null,
 checkCount: Array.isArray(wo.checks) ? wo.checks.length : 0,
 checks: (Array.isArray(wo.checks) ? wo.checks : []).map((c) => ({
 slNo: c.slNo,
 checkType: c.checkType || '',
 subType: c.subType || '',
 status: c.status || 'assignment-pending',
 assignedTo: c.assignedTo || '',
 })),
 };
 });

 res.json({
 success: true,
 checkHolds,
 caseHolds,
 stats: { checkHoldCount: checkHolds.length, caseHoldCount: caseHolds.length },
 });
 } catch (error) {
 console.error('Data Management Holds List Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// GET /api/data-management/:workorderId/payment-policy
// ====================================================================
router.get(`${API_BASE}/data-management/:workorderId/payment-policy`, async (req, res) => {
 try {
 const { workorderId } = req.params;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
 if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

 const paymentDue = isPaymentDue(wo.createdAt);
 res.json({
 success: true,
 paymentDue,
 note: paymentPolicyNote(paymentDue),
 graceWindowExpiresAt: paymentGraceExpiresAt(wo.createdAt),
 });
 } catch (error) {
 console.error('Data Management Payment Policy Preview Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/checks/:slNo/stop
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/checks/:slNo/stop`, async (req, res) => {
 try {
 const { workorderId, slNo } = req.params;
 const { reason, stoppedBy } = req.body;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
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
 { _id: new ObjectId(workorderId) },
 { $set: { checks, updatedAt: now } },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 if (stoppedBy?.origin === 'client') {
 (async () => {
 try {
 const supporterEmail = await findSupporterEmailForClient(req.db, wo.client);
 if (supporterEmail) {
 await sendStopCheckNotification({
 to: supporterEmail,
 clientName: wo.client,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 checkType: checks[idx].checkType,
 subType: checks[idx].subType,
 reason: reason || '',
 stoppedByName: stoppedBy?.name || '',
 paymentDue,
 });
 }
 } catch (e) {
 console.error('DM stop check supporter email failed:', e.message);
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
 console.error('Data Management Stop Check Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

// ====================================================================
// PUT /api/data-management/:workorderId/stop
// ====================================================================
router.put(`${API_BASE}/data-management/:workorderId/stop`, async (req, res) => {
 try {
 const { workorderId } = req.params;
 const { reason, stoppedBy } = req.body;
 if (!isValidId(workorderId)) {
 return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
 }

 const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
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
 stopReason: (reason || '').trim(),
 stoppedBy: stoppedBy || null,
 paymentDue,
 previousStatusBeforeStop: c.status || 'assignment-pending',
 status: 'stopped',
 }));

 const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
 { _id: new ObjectId(workorderId) },
 {
 $set: {
 stopped: true,
 stoppedAt: now,
 stopReason: (reason || '').trim(),
 stoppedBy: stoppedBy || null,
 paymentDue,
 previousStatusBeforeStop: wo.status || 'candidate-details',
 status: 'stopped',
 checks,
 updatedAt: now,
 },
 },
 { returnDocument: 'after' }
 );
 const updated = result?.value || result;

 if (stoppedBy?.origin === 'client') {
 (async () => {
 try {
 const supporterEmail = await findSupporterEmailForClient(req.db, wo.client);
 if (supporterEmail) {
 await sendStopWorkorderNotification({
 to: supporterEmail,
 clientName: wo.client,
 bgvRef: wo.bgvRef,
 candidateName: wo.fullName,
 reason: reason || '',
 stoppedByName: stoppedBy?.name || '',
 paymentDue,
 checkCount: checks.length,
 });
 }
 } catch (e) {
 console.error('DM stop workorder supporter email failed:', e.message);
 }
 })();
 }

 res.json({
 success: true,
 message: 'Workorder stopped. All checks halted.',
 paymentDue,
 paymentNote: paymentPolicyNote(paymentDue),
 workorder: shapeWorkorder(updated.value ? updated.value : updated),
 });
 } catch (error) {
 console.error('Data Management Stop Workorder Error:', error);
 res.status(500).json({ success: false, message: error.message });
 }
});

module.exports = router;
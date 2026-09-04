// routes/reportDeliveryRoutes.js
// ============================================================================
//  REPORT DELIVERY MODULE
//  ----------------------------------------------------------------------
//  "Finalize & Send to Client" on the Report screen calls
//  POST /api/report/:workorderId/checks/:slNo/finalize, which:
//    1. builds the PDF (reuses buildReportPdf from reportPdfRoutes.js —
//       same generator the manual "Download PDF" button uses)
//    2. emails it to the given client address with the branded template
//       from config/reportEmailTemplate.js
//    3. stamps the check as finalized/sent, so it now shows up in the
//       Report Delivery screen (GET /api/report-delivery/list)
//
//  New check-level fields written here (add to normalizeCheck() in
//  workorderRoutes.js per WIRING_NOTES.md so a full workorder re-save
//  never drops them):
//    reportFinalized        boolean
//    reportFinalizedAt      Date | null
//    reportSentTo           string  (client email)
//    reportSentAt           Date | null
//    reportDeliveryStatus   'sent' | 'failed' | null
//    reportDeliveryError    string
//    reportSentBy           object | null
// ============================================================================

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { buildReportPdf } = require('../report-forms/address-pdfRoute');
const { sendReportDeliveryEmail } = require('../routes/reportmailtemplateRoutes');

const API_BASE = '/api/report';
const DELIVERY_BASE = '/api/report-delivery';
const WORKORDER_COLLECTION = 'new-workorder-creation';

const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

function resolveFinalStatusLabel(check) {
  if (check.status === 'insufficient') return 'INFORMATION UNABLE TO VALIDATE';
  if (check.status === 'discrepancy') return 'ADVERSE REMARK REPORT';
  if (check.qcResult === 'approved' || check.status === 'report') return 'GENUINE';
  return 'PARTIALLY VERIFIED / MINOR DISCREPANCIES';
}

// ----------------------------------------------------------------------
// POST /api/report/:workorderId/checks/:slNo/finalize
//   body: { clientEmail, clientName, sentBy }
//   Generates the PDF, emails it, and marks the check as delivered.
// ----------------------------------------------------------------------
router.post(`${API_BASE}/:workorderId/checks/:slNo/finalize`, async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    const { clientEmail, clientName, sentBy } = req.body || {};

    if (!isValidId(workorderId)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    }
    if (!clientEmail || !/^\S+@\S+\.\S+$/.test(clientEmail)) {
      return res.status(400).json({ success: false, message: 'A valid client email address is required.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });
    if (checks[idx].qcStatus !== 'completed') {
      return res.status(400).json({ success: false, message: 'This check has not been QC-approved yet.' });
    }

    const now = new Date();

    // Build the PDF (same generator as the manual download button).
    let pdfResult;
    try {
      pdfResult = await buildReportPdf(req.db, workorderId, slNo);
    } catch (buildErr) {
      return res.status(buildErr.status || 500).json({ success: false, message: `Failed to build PDF: ${buildErr.message}` });
    }

    const finalStatus = resolveFinalStatusLabel(checks[idx]);

    let emailResult;
    try {
      emailResult = await sendReportDeliveryEmail({
        to: clientEmail,
        candidateName: wo.fullName,
        bgvRef: wo.bgvRef,
        checkType: checks[idx].checkType,
        subType: checks[idx].subType,
        clientName: clientName || wo.client,
        finalStatus,
        pdfBuffer: pdfResult.bytes,
        fileName: pdfResult.fileName,
      });

      checks[idx] = {
        ...checks[idx],
        reportFinalized: true,
        reportFinalizedAt: now,
        reportSentTo: clientEmail,
        reportSentAt: now,
        reportDeliveryStatus: 'sent',
        reportDeliveryError: emailResult.simulated
          ? 'SMTP not configured for this environment — email was simulated (logged to server console), not actually delivered. Set SMTP_HOST / SMTP_USER / SMTP_PASS to send real emails.'
          : '',
        reportSentBy: sentBy || null,
      };
    } catch (mailErr) {
      // A REAL send failure (bad credentials, unreachable host once SMTP
      // *is* configured, etc.) — no longer hit for the "no SMTP configured"
      // case, since that's now simulated instead of thrown.
      checks[idx] = {
        ...checks[idx],
        reportFinalized: true,
        reportFinalizedAt: now,
        reportSentTo: clientEmail,
        reportDeliveryStatus: 'failed',
        reportDeliveryError: mailErr.message,
        reportSentBy: sentBy || null,
      };

      const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
        { _id: new ObjectId(workorderId) },
        { $set: { checks, updatedAt: now } },
        { returnDocument: 'after' }
      );

      return res.status(502).json({
        success: false,
        message: `Report generated but email delivery failed: ${mailErr.message}`,
        workorder: result?.value || result,
      });
    }

    const result = await req.db.collection(WORKORDER_COLLECTION).findOneAndUpdate(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } },
      { returnDocument: 'after' }
    );

    res.json({
      success: true,
      message: emailResult.simulated
        ? `Report generated and moved to Report Delivery. SMTP isn't configured in this environment, so the email to ${clientEmail} was simulated (logged to the server console) rather than actually sent.`
        : `Report emailed to ${clientEmail} and moved to Report Delivery.`,
      simulated: !!emailResult.simulated,
      workorder: result?.value || result,
    });
  } catch (err) {
    console.error('POST /report/:workorderId/checks/:slNo/finalize error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------------------------
// GET /api/report-delivery/list?search=&client=&checkTypeId=&from=&to=&status=
//   Every check that has gone through Finalize (reportFinalized === true).
//   status: 'sent' | 'failed' (delivery status filter)
// ----------------------------------------------------------------------
router.get(`${DELIVERY_BASE}/list`, async (req, res) => {
  try {
    const { search = '', client = '', checkTypeId = '', from = '', to = '', status = '' } = req.query;
    const searchTerm = search.toLowerCase().trim();
    const clientTerm = client.toLowerCase().trim();
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    const workorders = await req.db
      .collection(WORKORDER_COLLECTION)
      .find({ 'checks.reportFinalized': true })
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
        if (!c.reportFinalized) return;
        if (checkTypeId && String(c.checkTypeId) !== String(checkTypeId)) return;
        if (status && c.reportDeliveryStatus !== status) return;
        if (fromDate && (!c.reportSentAt || new Date(c.reportSentAt) < fromDate)) return;
        if (toDate && (!c.reportSentAt || new Date(c.reportSentAt) > toDate)) return;

        rows.push({
          workorderId: wo._id.toString(),
          bgvRef: wo.bgvRef || '',
          fullName: wo.fullName || '',
          client: wo.client || '',
          checkSlNo: c.slNo,
          checkType: c.checkType || '',
          checkTypeId: c.checkTypeId || '',
          subType: c.subType || '',
          reportSentTo: c.reportSentTo || '',
          reportSentAt: c.reportSentAt || null,
          reportFinalizedAt: c.reportFinalizedAt || null,
          reportDeliveryStatus: c.reportDeliveryStatus || 'failed',
          reportDeliveryError: c.reportDeliveryError || '',
        });
      });
    });

    res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /report-delivery/list error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------------------------
// POST /api/report-delivery/:workorderId/checks/:slNo/resend
//   body: { clientEmail? } — reuses the stored reportSentTo if omitted.
// ----------------------------------------------------------------------
router.post(`${DELIVERY_BASE}/:workorderId/checks/:slNo/resend`, async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    const { clientEmail } = req.body || {};
    if (!isValidId(workorderId)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id.' });
    }

    const wo = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
    if (!wo) return res.status(404).json({ success: false, message: 'Workorder not found.' });

    const checks = Array.isArray(wo.checks) ? wo.checks : [];
    const idx = checks.findIndex((c) => String(c.slNo) === String(slNo));
    if (idx === -1) return res.status(404).json({ success: false, message: 'Check not found.' });

    const to = clientEmail || checks[idx].reportSentTo;
    if (!to) return res.status(400).json({ success: false, message: 'No client email on file — provide one to resend.' });

    const pdfResult = await buildReportPdf(req.db, workorderId, slNo);
    const finalStatus = resolveFinalStatusLabel(checks[idx]);

    const emailResult = await sendReportDeliveryEmail({
      to,
      candidateName: wo.fullName,
      bgvRef: wo.bgvRef,
      checkType: checks[idx].checkType,
      subType: checks[idx].subType,
      clientName: wo.client,
      finalStatus,
      pdfBuffer: pdfResult.bytes,
      fileName: pdfResult.fileName,
    });

    const now = new Date();
    checks[idx] = {
      ...checks[idx],
      reportSentTo: to,
      reportSentAt: now,
      reportDeliveryStatus: 'sent',
      reportDeliveryError: emailResult.simulated
        ? 'SMTP not configured for this environment — email was simulated (logged to the server console), not actually delivered.'
        : '',
    };

    await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id: new ObjectId(workorderId) },
      { $set: { checks, updatedAt: now } }
    );

    res.json({
      success: true,
      message: emailResult.simulated
        ? `SMTP isn't configured in this environment, so the resend to ${to} was simulated (logged to the server console).`
        : `Report re-sent to ${to}.`,
      simulated: !!emailResult.simulated,
    });
  } catch (err) {
    console.error('POST /report-delivery/:workorderId/checks/:slNo/resend error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
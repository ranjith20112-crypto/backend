/* ============================================================
   src/routes/verificationDataRoutes.js

   Single-file router (native MongoDB driver, no Mongoose — uses
   req.db exactly like the rest of the Verifitech backend).

   Collection: new-workorder-creation

   PURPOSE
   -------
   The candidate-side intake stores each check's declared data in a
   check-type-specific shape under check.data.__structured (see the
   sample workorder doc — Address/Criminal use present/permanent
   blocks, Employment/Education use a records[] array).

   The verifier screens (AddressVerificationVerifier.jsx,
   EmploymentVerificationVerifier.jsx, EducationVerificationVerifier.jsx)
   render a "Provided" column that reads a FLAT check.providedData
   object with specific keys (address/pinCode/landMark, companyName/
   designation/employeeId, degree/collegeName/serialNo, etc).

   This router bridges the two: on every GET of a workorder, each
   check is enriched with a flat `providedData` object + a flat
   `providedDocuments` array, computed from check.data.__structured.
   The verifier screens don't need to know about __structured at all.

   ROUTES
   ------
   GET  /api/workorders/:id
   PUT  /api/verifications/:workorderId/checks/:slNo/draft
   POST /api/verifications/complete
   ============================================================ */

const express = require('express');
const { ObjectId } = require('mongodb');

const router = express.Router();

const WORKORDER_COLLECTION = 'new-workorder-creation';

/* ───────── helpers ───────── */

function safeObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function mapFiles(files) {
  return (Array.isArray(files) ? files : []).map((f) => ({
    name: f.originalName || f.fieldname || 'Document',
    type: f.fieldname || '',
    url: f.url || '',
  }));
}

/* ───────── per-check-type transformers ─────────
   Each takes the raw `check` object and returns
   { providedData, providedDocuments }             */

function transformAddress(check) {
  const structured = check?.data?.__structured || {};
  // If the candidate said "present == permanent", both blocks are
  // identical copies; otherwise prefer whichever the check actually
  // needs. Default to `present` since that's what's usually verified
  // first; fall back to `permanent` if `present` is missing.
  const block =
    (structured.sameAsPresent === false ? structured.permanent : structured.present) ||
    structured.present ||
    structured.permanent ||
    {};

  return {
    providedData: {
      address: block.address || '',
      country: block.country || '',
      state: block.state || '',
      city: block.city || '',
      pinCode: block.pincode || '',
      landMark: block.landmark || '',
      typeOfAccommodation: block.accommodationType || '',
      ownershipStatus: block.residenceType || '',
      periodFrom: block.periodFrom || '',
      periodTo: block.periodTo || '',
    },
    providedDocuments: mapFiles(block.files),
  };
}

function transformEmployment(check) {
  const structured = check?.data?.__structured || {};
  const rec = (Array.isArray(structured.records) && structured.records[0]) || {};

  const companyName =
    rec.companyName === 'Others' ? rec.companyNameOther || '' : rec.companyName || '';

  return {
    providedData: {
      companyName,
      designation: rec.positionHeld || '',
      department: rec.department || '',
      employeeId: rec.employeeCode || '',
      reportingManager: rec.reportingAuthorityName || '',
      serialNo: rec.employeeCode || '',
      dateOfJoining: rec.dateOfJoining || '', // not captured at intake in current form; left for manual verifier entry
      dateOfRelieving: rec.yetToRelieve ? '' : rec.serviceDate || '',
      companyAddress: rec.companyAddress || '',
    },
    providedDocuments: mapFiles(rec.files),
  };
}

function transformEducation(check) {
  const structured = check?.data?.__structured || {};
  const rec = (Array.isArray(structured.records) && structured.records[0]) || {};

  const collegeName =
    rec.institutionName === 'Others' ? rec.institutionNameOther || '' : rec.institutionName || '';

  return {
    providedData: {
      degree: rec.degreeName || '',
      department: rec.majorSubject || '',
      collegeName,
      collegeAddress: rec.universityNameAddress || '',
      affiliatedUniversity: rec.universityNameAddress || '',
      serialNo: rec.studentId || '',
      periodFrom: rec.courseCommencementDate || '',
      periodTo: rec.courseCompletionDate || '',
    },
    providedDocuments: mapFiles(rec.files),
  };
}

// Criminal Verification currently shares the address-style
// present/permanent shape in the sample data, so it reuses the
// address transformer for its Provided column.
function transformCriminal(check) {
  return transformAddress(check);
}

function enrichCheck(check) {
  const type = (check.checkType || '').toLowerCase();

  let transformed = { providedData: {}, providedDocuments: [] };
  if (type.includes('address')) transformed = transformAddress(check);
  else if (type.includes('employment')) transformed = transformEmployment(check);
  else if (type.includes('education')) transformed = transformEducation(check);
  else if (type.includes('criminal')) transformed = transformCriminal(check);

  return {
    ...check,
    providedData: transformed.providedData,
    providedDocuments: transformed.providedDocuments,
  };
}

function enrichWorkorder(wo) {
  if (!wo) return wo;
  return {
    ...wo,
    checks: (wo.checks || []).map(enrichCheck),
  };
}

/* ───────── routes ───────── */

// GET /api/workorders/:id
router.get('/workorders/:id', async (req, res) => {
  try {
    const _id = safeObjectId(req.params.id);
    if (!_id) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id' });
    }

    const workorder = await req.db.collection(WORKORDER_COLLECTION).findOne({ _id });
    if (!workorder) {
      return res.status(404).json({ success: false, message: 'Workorder not found' });
    }

    res.json({ success: true, workorder: enrichWorkorder(workorder) });
  } catch (err) {
    console.error('GET /workorders/:id failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/verifications/:workorderId/checks/:slNo/draft
// Saves verifier progress without marking the check complete.
router.put('/verifications/:workorderId/checks/:slNo/draft', async (req, res) => {
  try {
    const _id = safeObjectId(req.params.workorderId);
    const slNo = Number(req.params.slNo);
    if (!_id || Number.isNaN(slNo)) {
      return res.status(400).json({ success: false, message: 'Invalid workorder id or slNo' });
    }

    const { data, notes } = req.body || {};

    const result = await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id, 'checks.slNo': slNo },
      {
        $set: {
          'checks.$.verifier': data || {},
          'checks.$.notes': notes || '',
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Check not found on workorder' });
    }

    res.json({ success: true, message: 'Draft saved' });
  } catch (err) {
    console.error('PUT draft failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/verifications/complete
// Marks a check complete with a result (verified / discrepant / insufficient).
router.post('/verifications/complete', async (req, res) => {
  try {
    const { workorderId, checkSlNo, result: verificationResult, notes, data } = req.body || {};

    const _id = safeObjectId(workorderId);
    const slNo = Number(checkSlNo);
    if (!_id || Number.isNaN(slNo)) {
      return res.status(400).json({ success: false, error: 'Invalid workorder id or checkSlNo' });
    }

    const statusMap = {
      verified: 'completed',
      discrepant: 'discrepancy',
      insufficient: 'insufficient',
    };
    const newStatus = statusMap[verificationResult] || 'completed';

    const update = await req.db.collection(WORKORDER_COLLECTION).updateOne(
      { _id, 'checks.slNo': slNo },
      {
        $set: {
          'checks.$.verifier': data || {},
          'checks.$.notes': notes || '',
          'checks.$.status': newStatus,
          'checks.$.result': verificationResult || newStatus,
          'checks.$.completedAt': new Date(),
          updatedAt: new Date(),
        },
      }
    );

    if (update.matchedCount === 0) {
      return res.status(404).json({ success: false, error: 'Check not found on workorder' });
    }

    res.json({ success: true, message: 'Verification completed' });
  } catch (err) {
    console.error('POST /verifications/complete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
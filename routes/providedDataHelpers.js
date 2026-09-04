// src/routes/helpers/providedDataHelpers.js
// -----------------------------------------------------------------------------
// Verifitech BGV Platform — Provided-Data Enrichment Helpers
// -----------------------------------------------------------------------------
// Pure functions, NO route registration in this file. Require these into the
// EXISTING canonical GET /api/workorders/:id handler in workorderRoutes.js
// (around line 528) instead of running a second, competing GET
// /workorders/:id route — Express only ever calls whichever route was
// registered first for a given path, so a second route at the same path is
// silently ignored.
//
// Usage inside workorderRoutes.js:
//
//   const { enrichWorkorderChecks } = require('./helpers/providedDataHelpers');
//
//   router.get(`${API_BASE}/workorders/:id`, async (req, res) => {
//     ...your existing lookup logic...
//     const workorder = await req.db.collection('new-workorder-creation').findOne({ _id });
//     if (!workorder) { ...your existing 404... }
//
//     const enriched = enrichWorkorderChecks(workorder);   // <-- add this line
//
//     return res.json({ success: true, workorder: enriched }); // <-- enriched, not workorder
//   });
//
// -----------------------------------------------------------------------------
// SCHEMA NOTE
// -----------------------------------------------------------------------------
// The candidate-submitted "Provided" data for a check lives directly on the
// check itself, at checks[n].data.__structured.records — NOT in a shared
// candidateDetails.addressHistory / educationHistory / employmentHistory
// array. See mapEmploymentRecord() etc below for the exact field mapping,
// confirmed against a real Employment check record:
//
//   checks[n].data.__structured.records[0] = {
//     companyName: "Zoho",
//     positionHeld: "Developer",
//     department: "Tech",
//     employeeCode: "ZH-876",
//     reportingAuthorityName: "Ravi",
//     serviceDate: "2026-07-28",
//     yetToRelieve: true,
//     files: [ ... ],
//     ...
//   }
// -----------------------------------------------------------------------------

/**
 * Normalizes a date-ish value (Date object, ISO string, or already a plain
 * string like "2024-05" / "2026-07-28") into a plain string safe for
 * <input type="date"> / <input type="month"> value props. Never throws.
 */
function normalizeDateField(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

/**
 * Pulls the candidate-submitted records array off a check, tolerating a few
 * shape variants so this keeps working even if older workorders were saved
 * slightly differently before the __structured convention was finalized.
 */
function extractRecords(check) {
  if (!check || !check.data) return [];

  if (check.data.__structured && Array.isArray(check.data.__structured.records)) {
    return check.data.__structured.records;
  }
  if (Array.isArray(check.data.records)) {
    return check.data.records;
  }
  if (Array.isArray(check.data)) {
    return check.data;
  }
  // Some very old records may have stored a single flat object with no
  // records wrapper at all — treat that object itself as the one record,
  // as long as it isn't just an empty {}.
  if (typeof check.data === 'object' && Object.keys(check.data).length > 0) {
    return [check.data];
  }
  return [];
}

// -----------------------------------------------------------------------------
// Per-check-type field mappers
// -----------------------------------------------------------------------------

function mapEmploymentRecord(record) {
  const currentlyEmployed = !!record.yetToRelieve;
  return {
    companyName: record.companyName || record.companyNameOther || '',
    designation: record.positionHeld || record.designation || '',
    department: record.department || '',
    employeeId: record.employeeCode || record.employeeId || '',
    reportingManager: record.reportingAuthorityName || '',
    serialNo: record.employeeCode || '',
    dateOfJoining: normalizeDateField(record.dateOfJoining || record.serviceDate),
    dateOfRelieving: currentlyEmployed
      ? ''
      : normalizeDateField(record.dateOfRelieving || record.relievingDate),
    companyAddress: record.companyAddress || '',
    currentlyEmployed,

    companyNameOther: record.companyNameOther || '',
    officeLandline: record.officeLandline || '',
    typeOfEmployment: record.typeOfEmployment || '',
    lastSalaryDrawn: record.lastSalaryDrawn || '',
    salaryType: record.salaryType || '',
    reportingAuthorityDesignation: record.reportingAuthorityDesignation || '',
    reportingAuthorityContactNo: record.reportingAuthorityContactNo || '',
    reportingAuthorityEmail: record.reportingAuthorityEmail || '',
    reasonForLeaving: record.reasonForLeaving || '',
    companyWebsite: record.companyWebsite || '',
    companySocialMediaLink: record.companySocialMediaLink || '',
    hrName: record.hrName || '',
    hrEmail: record.hrEmail || '',
    hrContactNo: record.hrContactNo || '',
    hrSocialMediaLink: record.hrSocialMediaLink || '',
    notApplicable: !!record.notApplicable,
  };
}

function mapAddressRecord(record) {
  return {
    address: record.address || record.fullAddress || record.currentAddress || '',
    country: record.country || '',
    state: record.state || '',
    city: record.city || '',
    pinCode: record.pinCode || record.pincode || '',
    landMark: record.landMark || record.landmark || '',
    typeOfAccommodation: record.typeOfAccommodation || '',
    ownershipStatus: record.ownershipStatus || record.natureOfResidence || '',
    periodFrom: normalizeDateField(record.periodFrom || record.fromDate || record.stayFromDate),
    periodTo: normalizeDateField(record.periodTo || record.toDate || record.stayToDate),
  };
}

function mapEducationRecord(record) {
  return {
    degree: record.degree || record.degreeName || record.courseName || '',
    department: record.department || record.specialization || record.major || '',
    collegeName: record.collegeName || record.institutionName || '',
    collegeAddress: record.collegeAddress || record.institutionAddress || '',
    affiliatedUniversity:
      record.affiliatedUniversity || record.university || record.board || '',
    serialNo:
      record.serialNo || record.regNo || record.registerNumber || record.enrollmentNo || '',
    periodFrom: normalizeDateField(record.periodFrom || record.fromDate || record.courseStartDate),
    periodTo: normalizeDateField(record.periodTo || record.toDate || record.courseEndDate),
  };
}

function mapCriminalRecord(record) {
  return {
    address: record.address || record.fullAddress || record.currentAddress || '',
    country: record.country || '',
    state: record.state || '',
    city: record.city || '',
    pinCode: record.pinCode || record.pincode || '',
    periodFrom: normalizeDateField(record.periodFrom || record.fromDate || record.stayFromDate),
    periodTo: normalizeDateField(record.periodTo || record.toDate || record.stayToDate),
  };
}

const MAPPERS_BY_TYPE = [
  { test: (t) => t.includes('employment'), map: mapEmploymentRecord },
  { test: (t) => t.includes('address'), map: mapAddressRecord },
  { test: (t) => t.includes('education'), map: mapEducationRecord },
  { test: (t) => t.includes('criminal'), map: mapCriminalRecord },
];

/**
 * Builds the read-only "Provided" column payload for a single check from
 * its first submitted record. Returns {} if no record was submitted yet
 * (frontend renders '-' per field in that case).
 */
function buildProvidedData(check) {
  const records = extractRecords(check);
  const record = records[0];
  if (!record) return {};

  const type = String(check.checkType || '').toLowerCase();
  const mapper = MAPPERS_BY_TYPE.find((m) => m.test(type));

  if (mapper) return mapper.map(record);

  // Unknown / not-yet-mapped check type — pass the raw record through
  // rather than silently dropping data the candidate actually submitted.
  return { ...record };
}

/**
 * If a check has more than one submitted record (count > 1 — e.g. two
 * employments, two addresses), this returns ALL of them normalized, so a
 * future multi-record verifier UI can iterate over every entry instead of
 * only ever seeing the first.
 */
function buildProvidedRecords(check) {
  const records = extractRecords(check);
  if (records.length === 0) return [];

  const type = String(check.checkType || '').toLowerCase();
  const mapper = MAPPERS_BY_TYPE.find((m) => m.test(type));

  return records.map((record) => (mapper ? mapper.map(record) : { ...record }));
}

/**
 * Builds the read-only "Provided Documents" list for a check from every
 * submitted record's `files` array. Tolerates files stored either as plain
 * URL strings or as { name, url, type } objects.
 */
function buildProvidedDocuments(check) {
  const records = extractRecords(check);
  const docs = [];

  records.forEach((record, recordIdx) => {
    const files = record.files || record.documents || [];
    if (!Array.isArray(files)) return;

    files.forEach((f, fileIdx) => {
      if (!f) return;

      if (typeof f === 'string') {
        docs.push({
          name: f.split('/').pop() || `Document ${recordIdx + 1}.${fileIdx + 1}`,
          type: check.checkType || '',
          url: f,
        });
        return;
      }

      if (typeof f === 'object') {
        const url = f.url || f.path || '';
        docs.push({
          name: f.name || f.fileName || (url ? String(url).split('/').pop() : `Document ${recordIdx + 1}.${fileIdx + 1}`),
          type: f.type || check.checkType || '',
          url,
        });
      }
    });
  });

  return docs;
}

/**
 * Given a raw workorder document from Mongo, returns a copy with every
 * check enriched with computed, read-only providedData / providedRecords /
 * providedDocuments — derived live from each check's own submitted records.
 *
 * This is the ONE function you need to call from your existing canonical
 * GET /api/workorders/:id handler in workorderRoutes.js before you
 * res.json() the workorder.
 */
function enrichWorkorderChecks(workorder) {
  if (!workorder || !Array.isArray(workorder.checks)) return workorder;

  const enrichedChecks = workorder.checks.map((check) => ({
    ...check,
    providedData: buildProvidedData(check),
    providedRecords: buildProvidedRecords(check),
    providedDocuments: buildProvidedDocuments(check),
  }));

  return { ...workorder, checks: enrichedChecks };
}

module.exports = {
  normalizeDateField,
  extractRecords,
  mapEmploymentRecord,
  mapAddressRecord,
  mapEducationRecord,
  mapCriminalRecord,
  buildProvidedData,
  buildProvidedRecords,
  buildProvidedDocuments,
  enrichWorkorderChecks,
};

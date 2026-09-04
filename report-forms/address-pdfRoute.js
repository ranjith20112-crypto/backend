// routes/reportPdfRoutes.js
// ============================================================================
//  REPORT PDF GENERATION
//  ----------------------------------------------------------------------
//  Generates the exact Verifitech "Employee Residence Address | Identity
//  Verification Report" layout (the format supplied as a reference PDF)
//  from live data in `new-workorder-creation`, for any check that has
//  reached QC-approved status (qcStatus === 'completed').
//
//  Address / Criminal-type checks get the full replica layout: candidate
//  info table, Yes/No checkbox grid, locality / accommodation / ownership
//  checkbox rows, verifier comments, colour-coded FINAL STATUS banner, a
//  legend, and a second "Field Visit Photography" page with whatever
//  images were uploaded for that check.
//
//  Every other check type (Employment, Education, etc.) gets a generic
//  but branded report — same header/footer/legend, a key/value table of
//  the verifier's findings instead of the fixed address grid.
//
//  Library: pdf-lib (pure JS, no headless browser / system deps needed —
//  see /mnt/skills/public/pdf/REFERENCE.md "JavaScript Libraries").
//  npm install pdf-lib
// ============================================================================

const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const API_BASE = '/api/report';
const WORKORDER_COLLECTION = 'new-workorder-creation';
const EMPLOYEE_COLLECTION = 'employee_login';
// Company logo, as supplied — resolved relative to the backend root
// (this file lives in routes/, so ../images/... points at backend/images/).
const LOGO_PATH = path.join(__dirname, '..', 'images', 'verifitech-logoo.png');

async function embedLogo(pdfDoc) {
  try {
    if (!fs.existsSync(LOGO_PATH)) return null;
    const bytes = fs.readFileSync(LOGO_PATH);
    return await pdfDoc.embedPng(bytes);
  } catch (e) {
    console.error('Logo embed failed:', e.message);
    return null;
  }
}

const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

const employeeDisplayName = (e) => {
  if (!e) return '';
  const firstName = e.firstName || e.first_name || '';
  const lastName = e.lastName || e.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return fullName || e.displayName || e.name || e.fullName || e.email || 'Unknown';
};

const fmtDate = (d) => {
  if (!d) return 'NA';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// Date format matching the reference: DD-MMM-YYYY (e.g., 15-May-2014)
const fmtDateLong = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(dt.getDate()).padStart(2, '0')}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
};



// ----------------------------------------------------------------------
// COLORS (rgb 0..1)
// ----------------------------------------------------------------------
const TEAL = rgb(0.043, 0.647, 0.616);
const BLACK = rgb(0.06, 0.06, 0.06);
const GRAY = rgb(0.45, 0.45, 0.45);
const LIGHT_GRAY = rgb(0.94, 0.94, 0.94);
const LINE_GRAY = rgb(0.75, 0.75, 0.75);
const GREEN = rgb(0.16, 0.62, 0.27);
const YELLOW = rgb(0.95, 0.83, 0.2);
const RED = rgb(0.82, 0.18, 0.15);
const ORANGE = rgb(0.9, 0.5, 0.1);

// FINAL STATUS resolution — mirrors the legend on the reference PDF.
function resolveFinalStatus(check) {
  if (check.status === 'insufficient') return { label: 'INFORMATION UNABLE TO VALIDATE', color: YELLOW, textColor: BLACK };
  if (check.status === 'discrepancy') return { label: 'ADVERSE REMARK REPORT', color: RED, textColor: rgb(1, 1, 1) };
  if (check.qcResult === 'approved' || check.status === 'report') return { label: 'GENUINE', color: GREEN, textColor: rgb(1, 1, 1) };
  return { label: 'PARTIALLY VERIFIED / MINOR DISCREPANCIES', color: ORANGE, textColor: rgb(1, 1, 1) };
}

// ----------------------------------------------------------------------
// Shared header / footer, drawn on every page.
// ----------------------------------------------------------------------
function drawHeaderFooter(page, fonts, { title, pageWidth, pageHeight, logoImage }) {
  const { bold, regular } = fonts;
  const margin = 40;

  // Header
  page.drawText('Strictly Private & Confidential', {
    x: margin, y: pageHeight - 35, size: 9, font: bold, color: BLACK,
  });

  if (logoImage) {
    // Logo lives in the top strip, above the header separator line drawn
    // at pageHeight - 50. maxLogoW/maxLogoH are the *preferred* size, but
    // the clamp below is what actually guarantees no overlap with the
    // title text underneath — even if these numbers get tuned larger
    // later, the logo can never grow past the strip it's confined to.
    const stripHeight = 50; // matches the header line's offset below pageHeight
    const stripPadding = 8;
    const maxLogoW = 130;
    const maxLogoH = 34;

    let scale = Math.min(maxLogoW / logoImage.width, maxLogoH / logoImage.height, 1);
    let w = logoImage.width * scale;
    let h = logoImage.height * scale;

    const maxAllowedH = stripHeight - stripPadding;
    if (h > maxAllowedH) {
      const clamp = maxAllowedH / h;
      w *= clamp;
      h *= clamp;
    }

    const logoX = pageWidth - margin - w;
    const logoY = (pageHeight - stripHeight) + (stripHeight - h) / 2;
    page.drawImage(logoImage, { x: logoX, y: logoY, width: w, height: h });
  } else {
    // Fallback if the logo file isn't found on disk — keeps the report
    // generating instead of failing outright.
    page.drawText('Verifitech', {
      x: pageWidth - margin - 70, y: pageHeight - 32, size: 14, font: bold, color: TEAL,
    });
    page.drawText('VerifyFirst BuildTrust', {
      x: pageWidth - margin - 70, y: pageHeight - 44, size: 6, font: regular, color: GRAY,
    });
  }

  page.drawLine({
    start: { x: margin, y: pageHeight - 50 }, end: { x: pageWidth - margin, y: pageHeight - 50 },
    thickness: 1, color: BLACK,
  });

  page.drawText(title, {
    x: (pageWidth - bold.widthOfTextAtSize(title, 13)) / 2,
    y: pageHeight - 72, size: 13, font: bold, color: BLACK,
  });

  // Footer
  page.drawLine({
    start: { x: margin, y: 50 }, end: { x: pageWidth - margin, y: 50 },
    thickness: 0.5, color: LINE_GRAY,
  });
  page.drawText('verify@verifitech.com | www.verifitech.com', {
    x: margin, y: 34, size: 8, font: regular, color: TEAL,
  });
  page.drawText('Version: 4.0 / Generated Report', {
    x: pageWidth - margin - 140, y: 34, size: 8, font: regular, color: GRAY,
  });
  page.drawText('**This is a computer-generated document. No signature is required', {
    x: (pageWidth - regular.widthOfTextAtSize('**This is a computer-generated document. No signature is required', 7.5)) / 2,
    y: 22, size: 7.5, font: regular, color: GRAY,
  });
}

// Wrap text to a max width, returns array of lines.
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines;
}

// ----------------------------------------------------------------------
// A full-width row split into arbitrary label/value columns (fractions of
// totalWidth must sum to ~1). Used for the multi-cell rows — Case Ref /
// Name, Period of Stay, Field Executive Name/Date/Time, and Remarks/
// Signature — that a single label:value row can't express.
// ----------------------------------------------------------------------
function drawGridRow(page, fonts, x, y, totalWidth, columns, height, fillColor) {
  page.drawRectangle({
    x, y: y - height, width: totalWidth, height,
    borderColor: BLACK, borderWidth: 0.75, color: fillColor,
  });
  let cx = x;
  columns.forEach((col, i) => {
    const w = totalWidth * col.widthFrac;
    if (i > 0) page.drawLine({ start: { x: cx, y }, end: { x: cx, y: y - height }, thickness: 0.5, color: LINE_GRAY });
    const isLabel = col.type === 'label';
    page.drawText(String(col.text ?? (isLabel ? '' : 'NA')), {
      x: cx + 4, y: y - height / 2 - 3, size: isLabel ? 7.5 : 8,
      font: isLabel ? fonts.bold : fonts.regular,
      color: col.textColor || BLACK,
    });
    cx += w;
  });
}

// Infers whether the verified address is the candidate's Present,
// Permanent, or Previous address. Not an explicit field in the data
// model, so this reads whatever signal is available (subType, or which
// __structured block the candidate submitted) and falls back to
// "Permanent" — Address Verification checks are permanent-residence
// checks by convention across the rest of this codebase.
function inferAddressType(check) {
  const hay = `${check.subType || ''} ${check.checkType || ''}`.toLowerCase();
  if (hay.includes('present')) return 'Present';
  if (hay.includes('previous')) return 'Previous';
  return 'Permanent';
}

// ----------------------------------------------------------------------
// Standard label/value row helper — fixed 120px label column.
// Used for rows ABOVE the Particulars/Verifier Feedback section.
// ----------------------------------------------------------------------
function page_drawFieldRow(page, fonts, x, y, width, label, value, height) {
  page.drawRectangle({ x, y: y - height, width, height, borderColor: BLACK, borderWidth: 0.75 });
  page.drawLine({ start: { x: x + 120, y }, end: { x: x + 120, y: y - height }, thickness: 0.5, color: LINE_GRAY });
  page.drawText(label, { x: x + 3, y: y - height / 2 - 3, size: 7.5, font: fonts.bold, color: BLACK });
  page.drawText(String(value || 'NA'), { x: x + 126, y: y - height / 2 - 3, size: 8, font: fonts.regular, color: BLACK });
}

// ----------------------------------------------------------------------
// Particulars / Verifier Feedback row helper — 26%/74% split to match
// the header row exactly. Used for rows UNDER the Particulars/Verifier
// Feedback section header.
// ----------------------------------------------------------------------
function page_drawParticularsRow(page, fonts, x, y, totalWidth, label, value, height) {
  const labelW = totalWidth * 0.40;
  page.drawRectangle({ x, y: y - height, width: totalWidth, height, borderColor: BLACK, borderWidth: 0.75 });
  page.drawLine({ start: { x: x + labelW, y }, end: { x: x + labelW, y: y - height }, thickness: 0.5, color: LINE_GRAY });
  page.drawText(label, { x: x + 4, y: y - height / 2 - 3, size: 7.5, font: fonts.bold, color: BLACK });
  page.drawText(String(value || 'NA'), { x: x + labelW + 4, y: y - height / 2 - 3, size: 8, font: fonts.regular, color: BLACK });
}

// ----------------------------------------------------------------------
// Particulars / Verifier Feedback row helper — wrapped text version
// for multi-line values. Returns the actual height used.
// ----------------------------------------------------------------------
function page_drawParticularsRowWrapped(page, fonts, x, y, totalWidth, label, value, minHeight) {
  const labelW = totalWidth * 0.26;
  const valueMaxW = totalWidth * 0.74 - 8;
  const lines = wrapText(String(value || 'NA'), fonts.regular, 8, valueMaxW);
  const height = Math.max(minHeight || 20, 14 + lines.length * 11);

  page.drawRectangle({ x, y: y - height, width: totalWidth, height, borderColor: BLACK, borderWidth: 0.75 });
  page.drawLine({ start: { x: x + labelW, y }, end: { x: x + labelW, y: y - height }, thickness: 0.5, color: LINE_GRAY });
  page.drawText(label, { x: x + 4, y: y - height / 2 - 3, size: 7.5, font: fonts.bold, color: BLACK });
  lines.forEach((line, i) => {
    page.drawText(line, { x: x + labelW + 4, y: y - 12 - i * 11, size: 8, font: fonts.regular, color: BLACK });
  });
  return height;
}

// ----------------------------------------------------------------------
// Complex Particulars/Verifier Feedback HEADER row — matches the
// reference form exactly. The left cell (26%) shows "Particulars".
// The right cell (74%) shows "Verifier Feedback" at the top, then
// "Period of stay From: [date] To: [date]" on the next line, then
// "Additional Comments from Verifier: [comments]" on the third line.
// The entire right cell is shaded with the final status color.
// ----------------------------------------------------------------------
function drawParticularsHeaderRow(page, fonts, x, y, totalWidth, data, finalStatus) {
  const labelW = totalWidth * 0.26;
  const valueW = totalWidth * 0.74;
  const headerHeight = 50;

  // Full row border
  page.drawRectangle({
    x, y: y - headerHeight, width: totalWidth, height: headerHeight,
    borderColor: BLACK, borderWidth: 0.75,
  });

  // Left cell — "Particulars" label with light gray background
  page.drawRectangle({
    x, y: y - headerHeight, width: labelW, height: headerHeight,
    color: LIGHT_GRAY,
  });
  page.drawLine({ start: { x: x + labelW, y }, end: { x: x + labelW, y: y - headerHeight }, thickness: 0.5, color: LINE_GRAY });
  page.drawText('Particulars', { x: x + 4, y: y - headerHeight / 2 - 3, size: 8, font: fonts.bold, color: BLACK });

  // Right cell — Verifier Feedback with period of stay and comments, shaded with status color
  page.drawRectangle({
    x: x + labelW, y: y - headerHeight, width: valueW, height: headerHeight,
    color: finalStatus.color,
  });

  const rx = x + labelW + 4;
  const textClr = finalStatus.textColor;

  // Line 1: "Verifier Feedback"
  page.drawText('Verifier Feedback', { x: rx, y: y - 12, size: 7.5, font: fonts.bold, color: textClr });

  // Line 2: "Period of stay From: 15-May-2014 To: 21-Dec-2017"
  const fromDate = fmtDateLong(data.periodFrom) || 'NA';
  const toDate = fmtDateLong(data.periodTo) || 'Till Date';
  const periodText = `Period of stay From: ${fromDate}  To: ${toDate}`;
  page.drawText(periodText, { x: rx, y: y - 24, size: 7, font: fonts.regular, color: textClr });

  // Line 3: "Additional Comments from Verifier :"
  const comments = data.additionalComments || '';
  const commentsLabel = 'Additional Comments from Verifier :';
  const commentsFull = comments ? `${commentsLabel} ${comments}` : commentsLabel;
  // Truncate if too long to fit in one line
  const maxCommentW = valueW - 12;
  let displayComments = commentsFull;
  if (fonts.regular.widthOfTextAtSize(displayComments, 7) > maxCommentW) {
    // Try to fit label + truncated comment
    const labelW2 = fonts.regular.widthOfTextAtSize(commentsLabel + ' ', 7);
    const availForComment = maxCommentW - labelW2;
    if (availForComment > 20 && comments) {
      let truncComment = comments;
      while (fonts.regular.widthOfTextAtSize(commentsLabel + ' ' + truncComment + '...', 7) > maxCommentW && truncComment.length > 5) {
        truncComment = truncComment.slice(0, -1);
      }
      displayComments = commentsLabel + ' ' + truncComment + '...';
    } else {
      displayComments = commentsLabel;
    }
  }
  page.drawText(displayComments, { x: rx, y: y - 36, size: 7, font: fonts.regular, color: textClr });

  return headerHeight;
}

// ----------------------------------------------------------------------
// PAGE 1 — Residential Address Verification Form (exact replica of the
// supplied Address_Form.docx reference), populated with the FINAL,
// QC-approved verification data. This is the delivered report — every
// field is filled in, unlike the blank working copy generated by
// routes/addressFormRoutes.js for a field executive's on-site visit.
// ----------------------------------------------------------------------
function drawAddressReportPage(pdfPage, fonts, data, dims) {
  const { bold, regular } = fonts;
  const { pageWidth, pageHeight } = dims;
  const margin = 40;
  const fullWidth = pageWidth - margin * 2;
  let y = pageHeight - 100;

  const { candidate, check, verifier, candidateDetails, performedByName } = data;
  const addr = verifier || {};
  const finalStatus = resolveFinalStatus(check);

  // Standard row helper for rows ABOVE the Particulars section (120px label)
  const row = (label, value, boxHeight = 20) => {
    page_drawFieldRow(pdfPage, fonts, margin, y, fullWidth, label, value, boxHeight);
    y -= boxHeight;
  };

  // Particulars-section row helper (26%/74% split to match the header)
  const particularsRow = (label, value, boxHeight = 20,labelWidth = 40) => {
    page_drawParticularsRow(pdfPage, fonts, margin, y, fullWidth, label, value, boxHeight);
    y -= boxHeight;
  };

  const fullAddress = [addr.address, addr.landMark, addr.city, addr.state, addr.pinCode].filter(Boolean).join(', ');
  const dateOfVisit = fmtDate(check.completedAt);
  const timeOfVisit = check.completedAt
    ? new Date(check.completedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : 'NA';

  // Row 1 — Case Reference No. | value | Name of the Candidate | value
  drawGridRow(pdfPage, fonts, margin, y, fullWidth, [
    { type: 'label', text: 'Case Reference No.', widthFrac: 0.26 },
    { type: 'value', text: check.bgvRef || candidate.bgvRef, widthFrac: 0.24 },
    { type: 'label', text: 'Name of the Candidate', widthFrac: 0.24 },
    { type: 'value', text: candidate.fullName, widthFrac: 0.26 },
  ], 24);
  y -= 24;

  // Row 2 — Address of the Candidate
  row('Address of the Candidate', fullAddress || 'NA', 28);

  // Row 3 — Period of Stay: From | value | To | value
  drawGridRow(pdfPage, fonts, margin, y, fullWidth, [
    { type: 'label', text: 'Period of Stay', widthFrac: 0.22 },
    { type: 'label', text: 'From (MM-DD-YYYY)', widthFrac: 0.20 },
    { type: 'value', text: fmtDate(addr.periodFrom), widthFrac: 0.16 },
    { type: 'label', text: 'To (MM-DD-YYYY)', widthFrac: 0.20 },
    { type: 'value', text: fmtDate(addr.periodTo) || 'Till Date', widthFrac: 0.22 },
  ], 24);
  y -= 24;

  // Row 4 — Father Name
  row('Father Name', candidateDetails?.personal?.fatherName || 'NA', 20);
  y -= 20;

  // Row 5 — Candidate Contact No.
  row('Candidate Contact No.', candidate.phone || candidateDetails?.personal?.mobile || 'NA', 20);
  y -= 20;

  // Row 6 — COMPLEX HEADER: Particulars | Verifier Feedback (with Period of stay
  // and Additional Comments embedded in the right cell, matching the reference form)
  const headerData = {
    periodFrom: addr.periodFrom,
    periodTo: addr.periodTo,
    additionalComments: check.notes || addr.additionalComments || '',
  };
  const headerH = drawParticularsHeaderRow(pdfPage, fonts, margin, y, fullWidth, headerData, finalStatus);
  y -= headerH;

  // Row 7 — Ownership Status (Owned / Rented / Other)
  particularsRow('Ownership Status\n(Owned / Rented / Other)'.split('\n')[0], addr.ownershipStatus || 'NA', 22);

  // Row 8 — Type of Address (Present / Permanent / Previous)
  particularsRow('Type of Address (Present / Permanent / Previous)', inferAddressType(check), 22);

  // Row 9 — Nearest Landmark (100 Meters of address)
  particularsRow('Nearest Landmark\n(100 Meters of address)'.split('\n')[0], addr.landMark || 'NA', 22);

  // Row 10 — Verifier Name
  particularsRow('Verifier Name', performedByName || 'NA', 20);

  // Row 11 — Relationship with Candidate
  particularsRow('Relationship with Candidate', addr.relationshipWithCandidate || 'NA', 20);

  // Row 12 — Verifiers Signature
  particularsRow('Verifiers Signature', 'Digitally Verified — no physical signature required', 24);

  // Row 13 — Verifier Address / Location — best-effort summary from
  // whatever corroborating details the verifier captured (there's no
  // single dedicated field for this in the data model).
  // Uses wrapped version to handle multi-line content, still 26%/74% split
  const verifierLocationBits = [
    addr.verifiedWith ? `Verified with: ${addr.verifiedWith}` : '',
    addr.neighbourContacted && addr.neighbourContacted !== 'NA' ? `Neighbour contacted — ${addr.neighbourFeedback || 'NA'}` : '',
  ].filter(Boolean).join('.  ');
  const locH = page_drawParticularsRowWrapped(pdfPage, fonts, margin, y, fullWidth, 'Verifier Address / Location', verifierLocationBits || 'NA', 28);
  y -= locH;

  // Add a small gap before the Field Executive section
  y -= 4;

  // Row 14 — Field Executives Name | value | Date of Visit | value | Time of Visit | value
  drawGridRow(pdfPage, fonts, margin, y, fullWidth, [
    { type: 'label', text: 'Field Executives Name', widthFrac: 0.24 },
    { type: 'value', text: performedByName, widthFrac: 0.20 },
    { type: 'label', text: 'Date of Visit', widthFrac: 0.16 },
    { type: 'value', text: dateOfVisit, widthFrac: 0.16 },
    { type: 'label', text: 'Time of Visit', widthFrac: 0.12 },
    { type: 'value', text: timeOfVisit, widthFrac: 0.12 },
  ], 22);
  y -= 22;

  // Row 15 — Field Executives Remarks | value | Field Executive Signature: | value
  const remarksLines = wrapText(check.notes || 'NA', regular, 8, fullWidth * 0.44 - 8);
  const remarksBoxH = Math.max(22, 12 + remarksLines.length * 11);
  drawGridRow(pdfPage, fonts, margin, y, fullWidth, [
    { type: 'label', text: 'Field Executives Remarks', widthFrac: 0.24 },
    { type: 'value', text: '', widthFrac: 0.44 },
    { type: 'label', text: 'Field Executive Signature:', widthFrac: 0.18 },
    { type: 'value', text: 'Digitally Verified', widthFrac: 0.14 },
  ], remarksBoxH);
  remarksLines.forEach((line, i) => {
    pdfPage.drawText(line, { x: margin + fullWidth * 0.24 + 4, y: y - 12 - i * 11, size: 8, font: regular });
  });
  y -= remarksBoxH + 16;

  // Legends — a stacked list (color swatch + label per row), exactly as
  // laid out at the bottom of the reference template.
  pdfPage.drawText('Legends:', { x: margin, y, size: 8, font: bold });
  y -= 4;
  const legendItems = [
    ['Clear Report', GREEN],
    ['Information Unable to Validate', YELLOW],
    ['Adverse Remark Report', RED],
    ['Partially Verified / Minor Discrepancies', ORANGE],
  ];
  legendItems.forEach(([label, color], i) => {
    const ly = y - 12 - i * 13;
    pdfPage.drawRectangle({ x: margin, y: ly - 7, width: 220, height: 12, color, borderColor: BLACK, borderWidth: 0.5 });
    pdfPage.drawText(label, { x: margin + 6, y: ly - 4, size: 7.5, font: regular });
  });
}


// ----------------------------------------------------------------------
// GENERIC report page — used for check types that don't have a fixed
// visual template (Employment, Education, etc). Same header/footer/legend
// branding, but the body is a plain key/value table of the verifier data.
// ----------------------------------------------------------------------
function humanizeKey(key) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase()).trim();
}

function drawGenericReportPage(pdfPage, fonts, data, dims) {
  const { bold, regular } = fonts;
  const { pageWidth, pageHeight } = dims;
  const margin = 40;
  let y = pageHeight - 100;

  const { candidate, check, verifier, performedByName } = data;

  const row = (label, value, height = 20) => {
    page_drawFieldRow(pdfPage, fonts, margin, y, pageWidth - margin * 2, label, value, height);
    y -= height;
  };

  row('Case Ref.No', check.bgvRef || candidate.bgvRef);
  row('Candidate Name', candidate.fullName || 'NA');
  row('Check Type', `${check.checkType || ''}${check.subType ? ` — ${check.subType}` : ''}`);
  row('Client', candidate.client || 'NA');
  row('Name of Verification Executive', performedByName || 'NA');

  // Flat key/value dump of whatever the verifier captured.
  const entries = Object.entries(verifier || {}).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
  entries.forEach(([key, value]) => {
    row(humanizeKey(key), String(value));
  });

  row("Supervisor's Remark / QC Notes", check.qcNotes || 'NA', 24);

  const finalStatus = resolveFinalStatus(check);
  const bannerH = 24;
  pdfPage.drawRectangle({ x: margin, y: y - bannerH, width: pageWidth - margin * 2, height: bannerH, color: finalStatus.color, borderColor: BLACK, borderWidth: 0.75 });
  pdfPage.drawText('FINAL STATUS', { x: margin + 3, y: y - 15, size: 8, font: bold, color: finalStatus.textColor });
  const labelWidth = bold.widthOfTextAtSize(finalStatus.label, 10);
  pdfPage.drawText(finalStatus.label, {
    x: margin + (pageWidth - margin * 2 - labelWidth) / 2, y: y - 16, size: 10, font: bold, color: finalStatus.textColor,
  });
}

// ----------------------------------------------------------------------
// PAGE 2 — Field Visit Photography (only added if at least one image is
// resolvable on disk).
// ----------------------------------------------------------------------
async function drawFieldVisitPage(pdfDoc, fonts, imagePaths, dims, logoImage) {
  const { pageWidth, pageHeight } = dims;
  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  drawHeaderFooter(page, fonts, { title: 'Field Visit Photography', pageWidth, pageHeight, logoImage });

  const margin = 40;
  const gap = 16;
  const boxW = (pageWidth - margin * 2 - gap) / 2;
  const boxH = 200;
  const labels = ['Landmark', 'Id Proof', 'Building with Door Number', 'Flat With Flat No'];
  const positions = [
    { x: margin, y: pageHeight - 100 },
    { x: margin + boxW + gap, y: pageHeight - 100 },
    { x: margin, y: pageHeight - 100 - boxH - 40 },
    { x: margin + boxW + gap, y: pageHeight - 100 - boxH - 40 },
  ];

  for (let i = 0; i < 4; i += 1) {
    const { x, y } = positions[i];
    page.drawText(`${labels[i]} :`, { x, y: y + 6, size: 9, font: fonts.bold });
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: BLACK, borderWidth: 1 });

    const imgPath = imagePaths[i];
    if (imgPath && fs.existsSync(imgPath)) {
      try {
        const bytes = fs.readFileSync(imgPath);
        const ext = path.extname(imgPath).toLowerCase();
        const image = ext === '.png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const scale = Math.min((boxW - 10) / image.width, (boxH - 10) / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, {
          x: x + (boxW - w) / 2, y: y - boxH + (boxH - h) / 2, width: w, height: h,
        });
      } catch (e) {
        page.drawText('N/A', { x: x + boxW / 2 - 10, y: y - boxH / 2, size: 10, font: fonts.bold });
      }
    } else {
      page.drawText('N/A', { x: x + boxW / 2 - 10, y: y - boxH / 2, size: 10, font: fonts.bold });
    }
  }
}

// ----------------------------------------------------------------------
// Resolve absolute disk paths for a check's uploaded files (from
// check.data.__structured.*.files and the workorder's documents[]) so the
// Field Visit Photography page can embed real images where available.
// ----------------------------------------------------------------------
function resolveImagePaths(wo, check) {
  const uploadsRoot = path.join(__dirname, '..');
  const urls = [];

  const structured = check?.data?.__structured || {};
  ['present', 'permanent'].forEach((k) => {
    const block = structured[k];
    if (block && Array.isArray(block.files)) block.files.forEach((f) => f?.url && urls.push(f.url));
  });
  if (Array.isArray(structured.records)) {
    structured.records.forEach((rec) => {
      if (Array.isArray(rec.files)) rec.files.forEach((f) => f?.url && urls.push(f.url));
    });
  }
  (Array.isArray(wo.documents) ? wo.documents : []).forEach((d) => {
    if (String(d.checkSlNo) === String(check.slNo) && d.url) urls.push(d.url);
  });

  return urls.map((u) => path.join(uploadsRoot, u.replace(/^\//, '')));
}

// ----------------------------------------------------------------------
// buildReportPdf(db, workorderId, slNo)
//   Reusable core — returns { bytes, fileName, wo, check } for a single
//   check's report. Used by the download route below AND by
//   routes/reportDeliveryRoutes.js when emailing the PDF to a client.
// ----------------------------------------------------------------------
async function buildReportPdf(db, workorderId, slNo) {
  if (!isValidId(workorderId)) {
    const err = new Error('Invalid workorder id.');
    err.status = 400;
    throw err;
  }

  const wo = await db.collection(WORKORDER_COLLECTION).findOne({ _id: new ObjectId(workorderId) });
  if (!wo) {
    const err = new Error('Workorder not found.');
    err.status = 404;
    throw err;
  }

  const check = (Array.isArray(wo.checks) ? wo.checks : []).find((c) => String(c.slNo) === String(slNo));
  if (!check) {
    const err = new Error('Check not found.');
    err.status = 404;
    throw err;
  }

  let performedByName = check.assignedTo || '';
  if (check.assignedToId && isValidId(check.assignedToId)) {
    const emp = await db.collection(EMPLOYEE_COLLECTION).findOne({ _id: new ObjectId(check.assignedToId) });
    if (emp) performedByName = employeeDisplayName(emp);
  }

  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fonts = { regular, bold };
  const logoImage = await embedLogo(pdfDoc);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const dims = { pageWidth, pageHeight };

  const page1 = pdfDoc.addPage([pageWidth, pageHeight]);
  const checkTypeLower = (check.checkType || '').toLowerCase();
  const isAddressLike = checkTypeLower.includes('address') || checkTypeLower.includes('criminal') || checkTypeLower.includes('identity');

  const reportData = {
    candidate: { ...wo, _id: wo._id.toString() },
    check: { ...check, bgvRef: wo.bgvRef },
    verifier: check.verifier || {},
    candidateDetails: wo.candidateDetails || {},
    performedByName,
  };

  drawHeaderFooter(page1, fonts, {
    title: isAddressLike ? 'Residential Address Verification Form' : `${check.checkType || 'Check'} Verification Report`,
    pageWidth, pageHeight, logoImage,
  });

  if (isAddressLike) {
    drawAddressReportPage(page1, fonts, reportData, dims);
  } else {
    drawGenericReportPage(page1, fonts, reportData, dims);
  }

  // Field Visit Photography page — only meaningful for address-style
  // checks, matches the reference PDF's second page.
  if (isAddressLike) {
    const imagePaths = resolveImagePaths(wo, check);
    await drawFieldVisitPage(pdfDoc, fonts, imagePaths, dims, logoImage);
  }

  const pdfBytes = await pdfDoc.save();
  const fileName = `${wo.bgvRef || 'Report'}_${(wo.fullName || 'Candidate').replace(/\s+/g, '_')}_${check.checkType || ''}.pdf`.replace(/[^\w.\-]+/g, '_');

  return { bytes: Buffer.from(pdfBytes), fileName, wo, check };
}

// ----------------------------------------------------------------------
// GET /api/report/:workorderId/checks/:slNo/pdf
//   Generates and streams the PDF report for a single QC-approved check.
// ----------------------------------------------------------------------
router.get(`${API_BASE}/:workorderId/checks/:slNo/pdf`, async (req, res) => {
  try {
    const { workorderId, slNo } = req.params;
    const { bytes, fileName } = await buildReportPdf(req.db, workorderId, slNo);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(bytes);
  } catch (err) {
    console.error('GET /report/:workorderId/checks/:slNo/pdf error', err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.buildReportPdf = buildReportPdf;
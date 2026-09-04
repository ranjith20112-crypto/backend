const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const WRAPPER = (title, bodyHtml) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#00D4AA,#3B82F6);padding:32px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">${title}</h1>
  </div>
  <div style="padding:32px;">
    ${bodyHtml}
  </div>
  <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #465364;text-align:center;">
    <p style="margin:0;font-size:12px;color:#94a3b8;">This is an automated email from Verifitech BGV Portal. Do not reply to this email.</p>
  </div>
</div>`;

const ROW = (label, value, danger) => `
<tr>
  <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;width:40%;">${label}</td>
  <td style="padding:8px 12px;border:1px solid ${danger ? '#fecaca' : '#e2e8f0'};font-size:14px;color:${danger ? '#991b1b' : '#334155'};font-weight:${danger ? '600' : '400'};">${value || '—'}</td>
</tr>`;

async function sendMail({ to, subject, html }) {
  if (!to) {
    console.log("No recipient email. Skipping mail.");
    return { success: false, message: "No recipient email." };
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_USER,
      to,
      subject,
      html,
    });

    console.log(`Mail sent to ${to}`);
    return { success: true };
  } catch (err) {
    console.error("Email Error:", err.message);
    return { success: false, message: err.message };
  }
}

async function sendCandidateInviteEmail(data = {}) {
  const to = data.to || data.email || data.candidateEmail;
  const name = data.fullName || data.candidateName || "Candidate";
  const bgvRef = data.bgvRef || "N/A";
  const link = `${FRONTEND_URL}/candidate-form/${data.workorderId || ""}`;

  return sendMail({
    to,
    subject: `Background Verification Initiated — ${bgvRef}`,
    html: WRAPPER("Background Verification", `
      <p style="font-size:15px;color:#334155;">Dear <strong>${name}</strong>,</p>
      <p style="font-size:15px;color:#334155;margin-top:12px;">
        Your background verification has been initiated with reference
        <strong style="color:#00D4AA;"> ${bgvRef}</strong>.
      </p>
      <p style="font-size:15px;color:#334155;margin-top:12px;">
        Please click below to complete your verification details:
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${link}"
          style="display:inline-block;background:#00D4AA;color:#000;padding:14px 40px;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;">
          Complete Verification Form
        </a>
      </div>
      <p style="font-size:13px;color:#64748b;">If the button doesn't work, copy this link:</p>
      <p style="font-size:13px;color:#3B82F6;word-break:break-all;">${link}</p>
    `),
  });
}

async function sendNewWorkorderSupporterNotification(data = {}) {
  const to = data.supporterEmail || data.email || data.to;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "";
  const clientName = data.clientName || "";
  const link = `${FRONTEND_URL}/employee-workorder-dashboard`;

  return sendMail({
    to,
    subject: `New Workorder: ${bgvRef} — ${candidateName}`,
    html: WRAPPER("New Workorder Created", `
      <p style="font-size:15px;color:#334155;">
        A new workorder has been created for client <strong>${clientName}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Reference", bgvRef)}
        ${ROW("Candidate", candidateName)}
      </table>
      <div style="text-align:center;margin:20px 0;">
        <a href="${link}"
          style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">
          View Workorder
        </a>
      </div>
    `),
  });
}

// ✅ NEW: Assignment Email
async function sendCheckAssignmentNotification(data = {}) {
  const to = data.to || data.assignedToEmail || data.email;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "N/A";
  const checkLabel = [data.checkType, data.subType].filter(Boolean).join(" — ") || "N/A";
  const assigneeName = data.assigneeName || "Team Member";

  return sendMail({
    to,
    subject: `Check Assigned: ${bgvRef} — ${checkLabel}`,
    html: WRAPPER("Check Assignment", `
      <p style="font-size:15px;color:#334155;">
        Dear <strong>${assigneeName}</strong>,
      </p>
      <p style="font-size:15px;color:#334155;margin-top:12px;">
        A new check has been <strong style="color:#00D4AA;">assigned to you</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Reference", bgvRef)}
        ${ROW("Candidate", candidateName)}
        ${ROW("Check", checkLabel)}
        ${ROW("Assigned To", assigneeName)}
      </table>
    `),
  });
}

// ✅ NEW: Completion Email
async function sendCheckCompletedNotification(data = {}) {
  const to = data.to || data.assignedToEmail || data.email;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "N/A";
  const checkLabel = [data.checkType, data.subType].filter(Boolean).join(" — ") || "N/A";

  return sendMail({
    to,
    subject: `Check Completed: ${bgvRef} — ${checkLabel}`,
    html: WRAPPER("Check Completed", `
      <p style="font-size:15px;color:#334155;">
        A check has been <strong style="color:#00D4AA;">completed successfully</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Reference", bgvRef)}
        ${ROW("Candidate", candidateName)}
        ${ROW("Check", checkLabel)}
        ${ROW("Status", "Completed")}
      </table>
    `),
  });
}

// ✅ NEW: Insufficiency Email
async function sendInsufficiencyEmail(data = {}) {
  const to = data.to || data.candidateEmail || data.email;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "Candidate";
  const checkLabel = [data.checkType, data.subType].filter(Boolean).join(" — ") || "N/A";
  const description = data.description || "Not specified";

  return sendMail({
    to,
    subject: `Insufficiency Raised: ${bgvRef} — ${checkLabel}`,
    html: WRAPPER("Insufficiency Raised", `
      <p style="font-size:15px;color:#334155;">
        Dear <strong>${candidateName}</strong>,
      </p>
      <p style="font-size:15px;color:#334155;margin-top:12px;">
        An insufficiency has been raised for your verification. Please provide the required documents to proceed.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Reference", bgvRef)}
        ${ROW("Check", checkLabel)}
        ${ROW("Description", description, true)}
      </table>
      <p style="font-size:13px;color:#64748b;margin-top:16px;">
        Please log in to your portal and upload the required documents.
      </p>
    `),
  });
}

async function sendCheckHoldNotification(data = {}) {
  const to = data.assigneeEmail || data.supporterEmail || data.email || data.to;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "";
  const checkLabel = [data.checkType, data.subType].filter(Boolean).join(" — ") || "N/A";

  return sendMail({
    to,
    subject: `Check on Hold: ${bgvRef} — ${checkLabel}`,
    html: WRAPPER("Check Hold Notification", `
      <p style="font-size:15px;color:#334155;">
        A check has been <strong style="color:#D97706;">put on hold</strong> on workorder <strong>${bgvRef}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("Candidate", candidateName)}
        ${ROW("Check", checkLabel)}
        ${ROW("Reason", data.reason || "Not specified")}
      </table>
    `),
  });
}

async function sendCaseHoldNotification(data = {}) {
  const to = data.supporterEmail || data.email || data.to;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "";
  const clientName = data.clientName || "";

  return sendMail({
    to,
    subject: `Case on Hold: ${bgvRef} — ${candidateName}`,
    html: WRAPPER("Case Hold Notification", `
      <p style="font-size:15px;color:#334155;">
        Case <strong style="color:#D97706;">put on hold</strong> — all checks paused.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Ref", bgvRef)}
        ${ROW("Candidate", candidateName)}
        ${ROW("Client", clientName)}
        ${ROW("Reason", data.reason || "Not specified")}
      </table>
    `),
  });
}

async function sendStopCheckNotification(data = {}) {
  const to = data.supporterEmail || data.email || data.to;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "";
  const clientName = data.clientName || "";
  const checkLabel = [data.checkType, data.subType].filter(Boolean).join(" — ") || "N/A";
  const paymentDue = !!data.paymentDue;

  return sendMail({
    to,
    subject: `Check Stopped: ${bgvRef} — ${checkLabel}`,
    html: WRAPPER("Check Stopped", `
      <p style="font-size:15px;color:#334155;">
        A check has been <strong style="color:#EF4444;">permanently stopped</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Ref", bgvRef)}
        ${ROW("Candidate", candidateName)}
        ${ROW("Client", clientName)}
        ${ROW("Check", checkLabel)}
        ${ROW("Stopped By", data.stoppedByName || "")}
        ${ROW("Reason", data.reason || "Not specified")}
        ${ROW("Payment Due", paymentDue ? "Yes" : "No", true)}
      </table>
    `),
  });
}

async function sendStopWorkorderNotification(data = {}) {
  const to = data.supporterEmail || data.email || data.to;
  const bgvRef = data.bgvRef || "N/A";
  const candidateName = data.candidateName || "";
  const clientName = data.clientName || "";
  const paymentDue = !!data.paymentDue;

  return sendMail({
    to,
    subject: `Workorder Stopped: ${bgvRef} — ${candidateName}`,
    html: WRAPPER("Workorder Stopped", `
      <p style="font-size:15px;color:#334155;">
        Workorder <strong style="color:#EF4444;">permanently stopped</strong> — all checks halted.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${ROW("BGV Ref", bgvRef)}
        ${ROW("Candidate", candidateName)}
        ${ROW("Client", clientName)}
        ${ROW("Stopped By", data.stoppedByName || "")}
        ${ROW("Reason", data.reason || "Not specified")}
        ${ROW("Payment Due", paymentDue ? "Yes" : "No", true)}
      </table>
    `),
  });
}

module.exports = {
  sendCandidateInviteEmail,
  sendNewWorkorderSupporterNotification,
  sendCheckAssignmentNotification,
  sendCheckCompletedNotification,
  sendInsufficiencyEmail,
  sendCheckHoldNotification,
  sendCaseHoldNotification,
  sendStopCheckNotification,
  sendStopWorkorderNotification,
};
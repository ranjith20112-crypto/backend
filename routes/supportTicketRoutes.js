// routes/supportTicketRoutes.js
const express = require("express");
const { ObjectId } = require("mongodb");
const multer = require("multer");
const nodemailer = require("nodemailer");

const router = express.Router();
const API_BASE = "/api";

// ===================================================================
// EMAIL CONFIGURATION
// ===================================================================
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
 console.warn("⚠️ WARNING: EMAIL_USER or EMAIL_PASS is missing.");
}

const transporter = nodemailer.createTransport({
 host: "smtp.gmail.com",
 port: 587,
 secure: false,
 auth: {
 user: process.env.EMAIL_USER,
 pass: process.env.EMAIL_PASS
 }
});

const sendEmail = async ({ to, subject, html }) => {
 if (!to) return;
 try {
 const info = await transporter.sendMail({
 from: `"Verifitech Support" <${process.env.EMAIL_USER}>`,
 to,
 subject,
 html
 });
 console.log(`✅ Email sent to: ${to}`);
 } catch (error) {
 console.error("❌ Email failed for ${to}:", error.message);
 }
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ticketUpload = upload.array("attachments", 5);

const fileToDataUri = (file) => {
 if (!file) return null;
 return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
};

const generateTicketId = async (db) => {
 const now = new Date();
 const dateStr = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
 const prefix = `TK-${dateStr}-`;
 const lastTicket = await db.collection("support-tickets").find({ ticketId: { $regex: `^${prefix}` } }).sort({ ticketId: -1 }).limit(1).toArray();
 let seq = 1;
 if (lastTicket.length > 0 && lastTicket[0].ticketId) {
 const parts = lastTicket[0].ticketId.split("-");
 const lastSeq = parseInt(parts[parts.length - 1], 10);
 if (!isNaN(lastSeq)) seq = lastSeq + 1;
 }
 return `${prefix}${String(seq).padStart(4, "0")}`;
};

const VALID_CATEGORIES = ["General Inquiry", "Issue Reading", "Tech Cases", "Report", "Kidney", "Case Delay", "Report Discrepancy", "Billing / Fees", "Feature Request", "Other"];
const VALID_PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const VALID_STATUSES = ["open", "in-progress", "resolved", "closed"];


// ===================================================================
// 1. CREATE TICKET -> Sends to Client + Dynamic CS SPOC Team
// ===================================================================
router.post(`${API_BASE}/support-tickets`, ticketUpload, async (req, res) => {
 try {
 const { clientCode, companyName, email, subject, message, priority, category, status, createdBy } = req.body;
 if (!subject || !subject.trim()) return res.status(400).json({ success: false, message: "Subject is required" });
 if (!message || !message.trim()) return res.status(400).json({ success: false, message: "Message is required" });

 const normalizedPriority = priority || "Medium";
 if (!VALID_PRIORITIES.includes(normalizedPriority)) return res.status(400).json({ success: false, message: "Invalid priority" });

 const normalizedCategory = category || "General Inquiry";
 if (!VALID_CATEGORIES.includes(normalizedCategory)) return res.status(400).json({ success: false, message: "Invalid category" });

 let normalizedStatus = status || "open";
 if (!VALID_STATUSES.includes(normalizedStatus)) normalizedStatus = "open";

 const ticketId = await generateTicketId(req.db);
 const attachments = (req.files || []).map((file) => ({ name: file.originalname, mimetype: file.mimetype, size: file.size, dataUri: fileToDataUri(file), uploadedAt: new Date() }));

 const ticket = {
 ticketId, clientCode: clientCode || "", companyName: companyName || "",
 email: (email || "").trim().toLowerCase(), subject: subject.trim(), message: message.trim(),
 priority: normalizedPriority, category: normalizedCategory, status: normalizedStatus,
 createdBy: createdBy || "client", attachments, replies: [],
 statusHistory: [{ status: normalizedStatus, changedBy: createdBy || "client", changedAt: new Date(), note: "Ticket created" }],
 createdAt: new Date(), updatedAt: new Date()
 };

 await req.db.collection("support-tickets").insertOne(ticket);
 
 const responseTicket = { ...ticket };
 if (responseTicket.attachments) {
 responseTicket.attachments = responseTicket.attachments.map((a) => ({ name: a.name, mimetype: a.mimetype, size: a.size, uploadedAt: a.uploadedAt }));
 }

 if (ticket.email) {
 await sendEmail({
 to: ticket.email,
 subject: `Ticket Received - ${ticket.ticketId}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#2563eb;">Support Ticket Received</h2>
 <p>Hello ${ticket.companyName || "Valued Customer"},</p>
 <p>We have successfully received your support request.</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <p><strong>Subject:</strong> ${ticket.subject}</p>
 <p><strong>Priority:</strong> ${ticket.priority}</p>
 <hr>
 <p>Our CS SPOC team will review your request and get back to you shortly.</p>
 <p>Regards,<br><strong>Verifitech Support Team</strong></p></div>`
 });
 }

 const csSpocs = await req.db.collection("assignees").find({
 $or: [{ role: "CS SPOC" }, { employeeRole: "CS SPOC" }, { designation: "CS SPOC" }]
 }).toArray();

 const csSpocEmails = csSpocs.map(s => s.email || s.employeeEmail || s.emailAddress).filter(Boolean).join(", ");

 if (csSpocEmails) {
 await sendEmail({
 to: csSpocEmails,
 subject: `[New Ticket Alert] ${ticket.ticketId} - ${ticket.subject}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#dc2626;">New Support Ticket Raised</h2>
 <p>A client has submitted a new support ticket.</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <p><strong>Client:</strong> ${ticket.companyName || "N/A"} (${ticket.clientCode || "N/A"})</p>
 <p><strong>Client Email:</strong> ${ticket.email || "N/A"}</p>
 <p><strong>Subject:</strong> ${ticket.subject}</p>
 <p><strong>Priority:</strong> ${ticket.priority}</p>
 <div style="background:#f5f5f5;padding:15px;border-radius:8px;margin-top:15px;"><strong>Message:</strong><p>${ticket.message}</p></div>
 <hr><p>Please log in to assign and handle this ticket.</p></div>`
 });
 }

 res.status(201).json({ success: true, message: "Ticket submitted successfully", ticket: responseTicket, ticketId });
 } catch (error) {
 console.error("Create Support Ticket Error:", error);
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// GET ALL SUPPORT TICKETS
// ===================================================================
router.get(`${API_BASE}/support-tickets`, async (req, res) => {
 try {
 const { clientCode, email, status, category, priority, search, page = "1", limit = "50" } = req.query;
 const filter = { isDeleted: { $ne: true } };

 if (clientCode) filter.clientCode = clientCode;
 if (email) {
 const cleanEmail = email.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 filter.email = { $regex: `^${cleanEmail}$`, $options: "i" };
 }
 if (status && VALID_STATUSES.includes(status)) filter.status = status;
 if (category && VALID_CATEGORIES.includes(category)) filter.category = category;
 if (priority && VALID_PRIORITIES.includes(priority)) filter.priority = priority;
 if (search) {
 const esc = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 filter.$or = [{ subject: { $regex: esc, $options: "i" } }, { message: { $regex: esc, $options: "i" } }, { ticketId: { $regex: esc, $options: "i" } }];
 }

 const pageNum = Math.max(1, parseInt(page, 10) || 1);
 const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
 const skip = (pageNum - 1) * limitNum;

 const total = await req.db.collection("support-tickets").countDocuments(filter);
 const tickets = await req.db.collection("support-tickets").find(filter)
 .project({ "attachments.dataUri": 0, "replies.attachments.dataUri": 0 })
 .sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray();

 const countFilter = { isDeleted: { $ne: true } };
 if (clientCode) countFilter.clientCode = clientCode;
 if (email) {
 const cleanEmail = email.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 countFilter.email = { $regex: `^${cleanEmail}$`, $options: "i" };
 }

 const [totalTickets, openCount, inProgressCount, resolvedCount, closedCount] = await Promise.all([
 req.db.collection("support-tickets").countDocuments(countFilter),
 req.db.collection("support-tickets").countDocuments({ ...countFilter, status: "open" }),
 req.db.collection("support-tickets").countDocuments({ ...countFilter, status: "in-progress" }),
 req.db.collection("support-tickets").countDocuments({ ...countFilter, status: "resolved" }),
 req.db.collection("support-tickets").countDocuments({ ...countFilter, status: "closed" })
 ]);

 res.json({
 success: true, tickets,
 pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
 counts: { total: totalTickets, open: openCount, inProgress: inProgressCount, resolved: resolvedCount, closed: closedCount }
 });
 } catch (error) {
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// GET SINGLE SUPPORT TICKET
// ===================================================================
router.get(`${API_BASE}/support-tickets/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 let ticket = ObjectId.isValid(id) 
 ? await req.db.collection("support-tickets").findOne({ $or: [{ _id: new ObjectId(id) }, { ticketId: id }] })
 : await req.db.collection("support-tickets").findOne({ ticketId: id });
 if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
 res.json({ success: true, ticket });
 } catch (error) {
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// 2. UPDATE TICKET (Assignee + Status) -> Sends to Employee & Client
// ===================================================================
router.put(`${API_BASE}/support-tickets/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 const { priority, category, subject, assignee, status } = req.body;

 let ticket = ObjectId.isValid(id) 
 ? await req.db.collection("support-tickets").findOne({ $or: [{ _id: new ObjectId(id) }, { ticketId: id }] })
 : await req.db.collection("support-tickets").findOne({ ticketId: id });

 if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

 const updateData = { updatedAt: new Date() };

 if (priority !== undefined) {
 if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ success: false, message: "Invalid priority" });
 updateData.priority = priority;
 }
 if (category !== undefined) {
 if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ success: false, message: "Invalid category" });
 updateData.category = category;
 }
 if (subject !== undefined) {
 if (!subject.trim()) return res.status(400).json({ success: false, message: "Subject cannot be empty" });
 updateData.subject = subject.trim();
 }

 // --- HANDLE ASSIGNEE & EMAIL TO EMPLOYEE ---
 if (assignee !== undefined) {
 updateData.assignee = assignee;
 
 if (assignee) {
 // If frontend sends an email directly (contains @), send email instantly
 if (assignee.includes("@")) {
 updateData.assigneeEmail = assignee;
 await sendEmail({
 to: assignee,
 subject: `Ticket Assigned to You - ${ticket.ticketId}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#2563eb;">New Support Ticket Assigned</h2>
 <p>Hello,</p>
 <p>A support ticket has been assigned to you.</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <p><strong>Client:</strong> ${ticket.companyName || "N/A"}</p>
 <p><strong>Subject:</strong> ${ticket.subject}</p>
 <p><strong>Priority:</strong> ${ticket.priority}</p>
 <div style="background:#f5f5f5;padding:15px;border-radius:8px;margin-top:15px;"><strong>Message:</strong><p>${ticket.message}</p></div>
 <hr><p>Please log in to handle this ticket.</p></div>`
 });
 } 
 // Otherwise, look up the MongoDB ID in the database
 else if (ObjectId.isValid(assignee)) {
 const spoc = await req.db.collection("assignees").findOne({ _id: new ObjectId(assignee) });
 if (spoc) {
 const emailKey = Object.keys(spoc).find(key => key.toLowerCase().includes('email') || key.toLowerCase().includes('mail'));
 const foundEmail = emailKey ? spoc[emailKey] : null;
 if (foundEmail) {
 updateData.assigneeEmail = foundEmail;
 await sendEmail({
 to: foundEmail,
 subject: `Ticket Assigned to You - ${ticket.ticketId}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#2563eb;">New Support Ticket Assigned</h2>
 <p>Hello ${spoc.name || spoc.employeeName || "Employee"},</p>
 <p>A support ticket has been assigned to you.</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <p><strong>Client:</strong> ${ticket.companyName || "N/A"}</p>
 <p><strong>Subject:</strong> ${ticket.subject}</p>
 <p><strong>Priority:</strong> ${ticket.priority}</p>
 <div style="background:#f5f5f5;padding:15px;border-radius:8px;margin-top:15px;"><strong>Message:</strong><p>${ticket.message}</p></div>
 <hr><p>Please log in to handle this ticket.</p></div>`
 });
 }
 }
 }
 } else {
 updateData.assigneeEmail = "";
 }
 }

 // --- HANDLE STATUS & EMAIL TO CLIENT ---
 if (status !== undefined) {
 if (!VALID_STATUSES.includes(status)) return res.status(400).json({ success: false, message: "Invalid status" });
 updateData.status = status;

 if (ticket.email && ticket.status !== status && (status === "in-progress" || status === "resolved")) {
 const statusMessage = status === "in-progress" 
 ? "Our team is currently working on your request." 
 : "We have successfully resolved your issue. If you have further questions, please reply to this email or raise a new ticket.";
 
 await sendEmail({
 to: ticket.email,
 subject: `Ticket Update: ${status === "in-progress" ? "In Progress" : "Resolved"} - ${ticket.ticketId}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#2563eb;">Support Ticket Update</h2>
 <p>Hello ${ticket.companyName || "Valued Customer"},</p>
 <p>Your ticket status has been updated.</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <p><strong>Subject:</strong> ${ticket.subject}</p>
 <p><strong>New Status:</strong> <span style="background:${status === 'resolved' ? '#dcfce7' : '#e0f2fe'}; padding:6px 12px; border-radius:5px; font-weight:bold; color:${status === 'resolved' ? '#166534' : '#1e40af'};">${status.toUpperCase()}</span></p>
 <hr>
 <p>${statusMessage}</p>
 <p>Regards,<br><strong>Verifitech Support Team</strong></p></div>`
 });
 }
 }

 await req.db.collection("support-tickets").updateOne({ _id: ticket._id }, { $set: updateData });
 const updatedTicket = await req.db.collection("support-tickets").findOne({ _id: ticket._id });

 res.json({ success: true, message: "Ticket updated successfully", ticketId: ticket.ticketId, ticket: updatedTicket });
 } catch (error) {
 console.error("Update Support Ticket Error:", error);
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// ADD REPLY TO A TICKET
// ===================================================================
router.post(`${API_BASE}/support-tickets/:id/reply`, ticketUpload, async (req, res) => {
 try {
 const { id } = req.params;
 const { message, repliedBy } = req.body;
 if (!message || !message.trim()) return res.status(400).json({ success: false, message: "Reply message is required" });

 let ticket = ObjectId.isValid(id) 
 ? await req.db.collection("support-tickets").findOne({ $or: [{ _id: new ObjectId(id) }, { ticketId: id }] })
 : await req.db.collection("support-tickets").findOne({ ticketId: id });

 if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
 if (ticket.status === "closed") return res.status(400).json({ success: false, message: "Cannot reply to a closed ticket." });

 const attachments = (req.files || []).map((file) => ({ name: file.originalname, mimetype: file.mimetype, size: file.size, dataUri: fileToDataUri(file), uploadedAt: new Date() }));
 const reply = { message: message.trim(), sender: "admin", senderName: repliedBy, attachments, createdAt: new Date() };

 const updateOps = { $push: { replies: reply }, $set: { updatedAt: new Date() } };
 if (ticket.status === "open") {
 updateOps.$set.status = "in-progress";
 updateOps.$push.statusHistory = { status: "in-progress", changedBy: "admin", changedAt: new Date(), note: "Auto-moved to in-progress when admin replied" };
 }

 await req.db.collection("support-tickets").updateOne({ _id: ticket._id }, updateOps);
 const updatedTicket = await req.db.collection("support-tickets").findOne({ _id: ticket._id });

 if (ticket.email) {
 await sendEmail({
 to: ticket.email,
 subject: `New Reply on Ticket ${ticket.ticketId}`,
 html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;color:#333;">
 <h2 style="color:#2563eb;">New Reply to Your Ticket</h2>
 <p>Hello ${ticket.companyName || "Valued Customer"},</p><hr>
 <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
 <div style="background:#f0f7ff;border-left:4px solid #2563eb;padding:15px;margin:15px 0;border-radius:0 5px 5px 0;">
 <p style="margin:0 0 5px;color:#666;font-size:12px;"><strong>${reply.senderName || "Support Team"}</strong> · ${new Date().toLocaleString()}</p>
 <p style="margin:0;color:#333;">${reply.message.replace(/\n/g, '<br>')}</p>
 </div>
 <hr><p>Regards,<br><strong>Verifitech Support Team</strong></p></div>`
 });
 }

 res.status(201).json({ success: true, message: "Reply added successfully", reply, ticketId: ticket.ticketId, ticket: updatedTicket, newStatus: updateOps.$set.status || ticket.status });
 } catch (error) {
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// DELETE TICKET
// ===================================================================
router.delete(`${API_BASE}/support-tickets/:id`, async (req, res) => {
 try {
 const { id } = req.params;
 let ticket = ObjectId.isValid(id) 
 ? await req.db.collection("support-tickets").findOne({ $or: [{ _id: new ObjectId(id) }, { ticketId: id }] })
 : await req.db.collection("support-tickets").findOne({ ticketId: id });

 if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });

 await req.db.collection("support-tickets").updateOne(
 { _id: ticket._id },
 { $set: { status: "deleted", isDeleted: true, deletedAt: new Date(), updatedAt: new Date() } }
 );

 res.json({ success: true, message: "Ticket deleted successfully", ticketId: ticket.ticketId });
 } catch (error) {
 res.status(500).json({ success: false, message: error.message });
 }
});


// ===================================================================
// GET TICKET STATS
// ===================================================================
router.get(`${API_BASE}/support-tickets-stats/summary`, async (req, res) => {
 try {
 const { clientCode, email } = req.query;
 const filter = { isDeleted: { $ne: true } };
 if (clientCode) filter.clientCode = clientCode;
 if (email) {
 const cleanEmail = email.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 filter.email = { $regex: `^${cleanEmail}$`, $options: "i" };
 }

 const pipeline = [
 { $match: filter },
 { $group: {
 _id: null, total: { $sum: 1 },
 open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
 inProgress: { $sum: { $cond: [{ $eq: ["$status", "in-progress"] }, 1, 0] } },
 resolved: { $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] } },
 closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
 urgent: { $sum: { $cond: [{ $eq: ["$priority", "Urgent"] }, 1, 0] } },
 high: { $sum: { $cond: [{ $eq: ["$priority", "High"] }, 1, 0] } }
 }
 }
 ];

 const [statsResult, categoryBreakdown] = await Promise.all([
 req.db.collection("support-tickets").aggregate(pipeline).toArray(),
 req.db.collection("support-tickets").aggregate([
 { $match: filter }, { $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }
 ]).toArray()
 ]);

 const stats = statsResult[0] || { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0, urgent: 0, high: 0 };

 res.json({
 success: true,
 stats: { total: stats.total, open: stats.open, inProgress: stats.inProgress, resolved: stats.resolved, closed: stats.closed, active: stats.open + stats.inProgress, urgent: stats.urgent, high: stats.high },
 categoryBreakdown: categoryBreakdown.map((c) => ({ category: c._id, count: c.count }))
 });
 } catch (error) {
 res.status(500).json({ success: false, message: error.message });
 }
});

module.exports = router;
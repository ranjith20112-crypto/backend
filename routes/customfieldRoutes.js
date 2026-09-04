// routes/customFieldRoutes.js
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');

const API_BASE = '/api';
const CUSTOMFIELD_COLLECTION = 'customfield-creation';
const CHECKTYPE_COLLECTION = 'checktype-creation';
const SUBCHECKTYPE_COLLECTION = 'sub-checktype-creation';

// ---- Helpers ----
const isValidId = (id) => {
  try {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
  } catch {
    return false;
  }
};

const shape = (doc) => {
  if (!doc) return null;
  return { ...doc, _id: doc._id ? doc._id.toString() : undefined };
};

// Normalize an incoming custom-field payload to a consistent document shape
const buildCustomFieldDoc = (body = {}) => {
  const {
    fieldLabel = '',
    fieldName = '',
    fieldType = 'text',
    placeholder = '',
    defaultValue = '',
    description = '',
    checkTypeId = null,
    subCheckId = null,
    subCheckName = '',
    required = false,
    unique = false,
    readonly = false,
    hidden = false,
    showInList = true,
    showInForm = true,
    status = 'Active',
    sortOrder = 0,
    options = [],
    minLength = null,
    maxLength = null,
    minValue = null,
    maxValue = null,
    regexPattern = null,
    regexMessage = null,
    allowedFileTypes = null,
    maxFileSize = null,
    width = 'full',
    helpText = '',
    cssClass = '',
    validationRules = [],
  } = body;

  return {
    fieldLabel: String(fieldLabel).trim(),
    fieldName: String(fieldName).trim(),
    fieldType: String(fieldType).trim() || 'text',
    placeholder: String(placeholder || ''),
    defaultValue: String(defaultValue || ''),
    description: String(description || ''),
    checkTypeId: checkTypeId || null,
    // NEW: optional sub-check association
    subCheckId: subCheckId || null,
    subCheckName: String(subCheckName || ''),
    required: !!required,
    unique: !!unique,
    readonly: !!readonly,
    hidden: !!hidden,
    showInList: showInList !== false,
    showInForm: showInForm !== false,
    status: status === 'Inactive' ? 'Inactive' : 'Active',
    sortOrder: Number(sortOrder) || 0,
    options: Array.isArray(options) ? options.filter((o) => o !== '' && o != null) : [],
    minLength: minLength === null || minLength === '' ? null : Number(minLength),
    maxLength: maxLength === null || maxLength === '' ? null : Number(maxLength),
    minValue: minValue === null || minValue === '' ? null : Number(minValue),
    maxValue: maxValue === null || maxValue === '' ? null : Number(maxValue),
    regexPattern: regexPattern || null,
    regexMessage: regexMessage || null,
    allowedFileTypes: allowedFileTypes || null,
    maxFileSize: maxFileSize === null || maxFileSize === '' ? null : Number(maxFileSize),
    width: width || 'full',
    helpText: String(helpText || ''),
    cssClass: String(cssClass || ''),
    validationRules: Array.isArray(validationRules) ? validationRules : [],
  };
};

// Map a stored custom field to a form-ready descriptor
const toFormField = (f) => ({
  name: f.fieldName,
  label: f.fieldLabel,
  type: f.fieldType,
  required: !!f.required,
  options: Array.isArray(f.options) ? f.options : [],
  placeholder: f.placeholder || '',
  defaultValue: f.defaultValue || '',
  helpText: f.helpText || '',
  width: f.width || 'full',
  readonly: !!f.readonly,
  subCheckId: f.subCheckId || null,
  subCheckName: f.subCheckName || '',
  minLength: f.minLength ?? null,
  maxLength: f.maxLength ?? null,
  minValue: f.minValue ?? null,
  maxValue: f.maxValue ?? null,
  regexPattern: f.regexPattern || null,
  allowedFileTypes: f.allowedFileTypes || null,
  maxFileSize: f.maxFileSize ?? null,
});

// ====================================================================
// GET SUB-CHECKS FOR A CHECK TYPE (convenience for the CustomFields form)
//   GET /api/customfields/subchecks/:checkTypeId
//   Returns the sub-checks that belong to a check type, from the
//   sub-checktype-creation collection (falls back to the parent's
//   subChecks string array if no sub-check docs exist).
// ====================================================================
router.get(`${API_BASE}/customfields/subchecks/:checkTypeId`, async (req, res) => {
  try {
    const { checkTypeId } = req.params;
    if (!isValidId(checkTypeId)) {
      return res.status(400).json({ success: false, message: 'Invalid check type id.' });
    }

    // 1) Try the dedicated sub-check collection
    const subDocs = await req.db
      .collection(SUBCHECKTYPE_COLLECTION)
      .find({ parentCheckId: checkTypeId })
      .sort({ createdAt: 1 })
      .toArray();

    if (subDocs.length) {
      const subChecks = subDocs.map((s) => ({
        _id: s._id.toString(),
        code: s.code || '',
        name: s.name || '',
      }));
      return res.json({ success: true, subChecks });
    }

    // 2) Fallback: read the parent's subChecks string array
    const parent = await req.db
      .collection(CHECKTYPE_COLLECTION)
      .findOne({ _id: new ObjectId(checkTypeId) });

    const names = Array.isArray(parent?.subChecks) ? parent.subChecks : [];
    const subChecks = names.map((n, i) => ({
      _id: `name:${n}`, // synthetic id when no sub-check document exists
      code: '',
      name: n,
    }));

    return res.json({ success: true, subChecks });
  } catch (error) {
    console.error('Get SubChecks (custom fields) Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// LIST CUSTOM FIELDS
//   GET /api/customfields
//   optional: ?checkTypeId=  ?subCheckId=  ?status=Active
// ====================================================================
router.get(`${API_BASE}/customfields`, async (req, res) => {
  try {
    const query = {};
    if (req.query.checkTypeId) query.checkTypeId = req.query.checkTypeId;
    if (req.query.subCheckId) query.subCheckId = req.query.subCheckId;
    if (req.query.status) query.status = req.query.status;

    const fields = await req.db
      .collection(CUSTOMFIELD_COLLECTION)
      .find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .toArray();

    res.json({ success: true, customFields: fields.map(shape) });
  } catch (error) {
    console.error('List Custom Fields Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// GET CUSTOM FIELDS FOR A CHECK TYPE (form-ready)
//   GET /api/customfields/by-checktype/:checkTypeId
//   optional: ?subCheckId=<id|name:...>
//     - When subCheckId is provided, returns:
//         * fields with that exact subCheckId  (sub-check-specific)
//         * PLUS fields with no subCheckId      (check-type-wide)
//     - When subCheckId is omitted, returns ALL active form fields for
//       the check type (used to count / display everything).
// ====================================================================
router.get(`${API_BASE}/customfields/by-checktype/:checkTypeId`, async (req, res) => {
  try {
    const { checkTypeId } = req.params;
    const { subCheckId } = req.query;

    const baseQuery = {
      checkTypeId,
      status: 'Active',
      showInForm: { $ne: false },
      hidden: { $ne: true },
    };

    let query = baseQuery;
    if (subCheckId) {
      query = {
        ...baseQuery,
        $or: [
          { subCheckId: subCheckId },
          { subCheckId: null },
          { subCheckId: '' },
          { subCheckId: { $exists: false } },
        ],
      };
    }

    const fields = await req.db
      .collection(CUSTOMFIELD_COLLECTION)
      .find(query)
      .sort({ sortOrder: 1, createdAt: -1 })
      .toArray();

    res.json({ success: true, fields: fields.map(toFormField) });
  } catch (error) {
    console.error('Custom Fields By CheckType Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// GET SINGLE CUSTOM FIELD
// ====================================================================
router.get(`${API_BASE}/customfields/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid custom field id.' });

    const field = await req.db.collection(CUSTOMFIELD_COLLECTION).findOne({ _id: new ObjectId(id) });
    if (!field) return res.status(404).json({ success: false, message: 'Custom field not found.' });

    res.json({ success: true, customField: shape(field) });
  } catch (error) {
    console.error('Get Custom Field Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// CREATE CUSTOM FIELD
//   POST /api/customfields/create
// ====================================================================
router.post(`${API_BASE}/customfields/create`, async (req, res) => {
  try {
    const doc = buildCustomFieldDoc(req.body);

    if (!doc.fieldLabel) return res.status(400).json({ success: false, message: 'Field label is required.' });
    if (!doc.fieldName) return res.status(400).json({ success: false, message: 'Field name is required.' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(doc.fieldName)) {
      return res.status(400).json({ success: false, message: 'Field name must start with a letter and contain only letters, numbers and underscores.' });
    }

    // Uniqueness scoped by check type + sub-check
    const dup = await req.db.collection(CUSTOMFIELD_COLLECTION).findOne({
      fieldName: doc.fieldName,
      checkTypeId: doc.checkTypeId,
      subCheckId: doc.subCheckId,
    });
    if (dup) {
      return res.status(409).json({ success: false, message: `A field named "${doc.fieldName}" already exists for this check/sub-check.` });
    }

    const now = new Date();
    const payload = { ...doc, createdAt: now, updatedAt: now };

    const result = await req.db.collection(CUSTOMFIELD_COLLECTION).insertOne(payload);
    const saved = await req.db.collection(CUSTOMFIELD_COLLECTION).findOne({ _id: result.insertedId });

    res.status(201).json({ success: true, message: 'Custom field created.', customField: shape(saved) });
  } catch (error) {
    console.error('Create Custom Field Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// UPDATE CUSTOM FIELD
//   PUT /api/customfields/:id
// ====================================================================
router.put(`${API_BASE}/customfields/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid custom field id.' });

    const doc = buildCustomFieldDoc(req.body);

    if (!doc.fieldLabel) return res.status(400).json({ success: false, message: 'Field label is required.' });
    if (!doc.fieldName) return res.status(400).json({ success: false, message: 'Field name is required.' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(doc.fieldName)) {
      return res.status(400).json({ success: false, message: 'Field name must start with a letter and contain only letters, numbers and underscores.' });
    }

    const dup = await req.db.collection(CUSTOMFIELD_COLLECTION).findOne({
      _id: { $ne: new ObjectId(id) },
      fieldName: doc.fieldName,
      checkTypeId: doc.checkTypeId,
      subCheckId: doc.subCheckId,
    });
    if (dup) {
      return res.status(409).json({ success: false, message: `A field named "${doc.fieldName}" already exists for this check/sub-check.` });
    }

    const result = await req.db
      .collection(CUSTOMFIELD_COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { ...doc, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

    const updated = result?.value || result; // driver v6+ compatibility
    if (!updated) return res.status(404).json({ success: false, message: 'Custom field not found.' });

    res.json({ success: true, message: 'Custom field updated.', customField: shape(updated.value ? updated.value : updated) });
  } catch (error) {
    console.error('Update Custom Field Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================================================================
// DELETE CUSTOM FIELD
//   DELETE /api/customfields/:id
// ====================================================================
router.delete(`${API_BASE}/customfields/:id`, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: 'Invalid custom field id.' });

    const result = await req.db.collection(CUSTOMFIELD_COLLECTION).deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, message: 'Custom field not found.' });

    res.json({ success: true, message: 'Custom field deleted.' });
  } catch (error) {
    console.error('Delete Custom Field Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;

/*
============================================================
SERVER SETUP (app.js / server.js) — add alongside existing routes:
  app.use(require('./routes/customFieldRoutes'));
============================================================
*/